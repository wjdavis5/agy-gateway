import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Core runner for agy-gateway: turns a request object into one headless
// `agy` invocation and a typed result, running at most maxConcurrent agy
// processes at once (bounded semaphore + FIFO queue -- KTD3).
//
// The invocation shape mirrors the live-verified pattern in
// plex/src/organize/agyClassifier.js (promisified execFile, argv array, no
// shell, 10MB maxBuffer, only stdout's single JSON object trusted).
//
// --- Live-verified agy behavior (2026-08-24, agy 1.1.19) ---
//
//   1. Invocation: agy -p <prompt> --output-format json|text
//      [--json-schema <inline schema string>] --effort <low|medium|high>
//      --print-timeout <Ns> [--sandbox]
//   2. `--print-timeout` defaults to 5m0s INSIDE agy -- it must always be
//      passed explicitly (ceil of the remaining budget in seconds, e.g.
//      "540s") or agy self-terminates at 5 minutes regardless of our
//      execFile timeout.
//   3. `--json-schema` accepts the schema inline as a single argument.
//   4. json-mode stdout is ONE JSON object:
//      {"conversation_id":"...","status":"SUCCESS","response":"...",
//       "structured_output":{...},"usage":{...}}
//      `structured_output` is the trusted field when a schema was passed.
//   5. A missing binary surfaces as error.code === "ENOENT" from execFile;
//      an execFile-timeout kill surfaces as error.killed === true.
//   6. `--add-dir <dir>` (repeatable) grants scoped workspace trust for
//      one invocation: file reads under that dir are auto-approved
//      headlessly, everything else stays denied. Live-verified 2026-08-24
//      on LXC 105: agy read and correctly described a PNG (shapes + text)
//      under an --add-dir'd CIFS mount, while the same read without the
//      flag was denied.
//   7. Observed non-SUCCESS statuses (live probes on LXC 105): "CANCELED"
//      -- a tool call needed a permission headless mode cannot prompt for
//      and was auto-denied (explanation text arrives on stderr, body
//      response is empty); and "ERROR" -- --sandbox denied a tool call
//      (body carries an `error` field). Both map to errorKind
//      "agy-status", with stderrTail carrying the denial detail.
//
// Deliberate choices:
//   - --dangerously-skip-permissions is OFF by default (KTD6, settled
//     policy) -- a tool call the agent can't auto-run is simply not run,
//     so a hostile prompt can't make agy touch the filesystem or shell.
//     It is opt-in via skipPermissionsMode (AGY_SKIP_PERMISSIONS_MODE),
//     added 2026-08-30 to enable image/vision analysis, which needs a
//     `command`-permission tool headless mode otherwise auto-denies:
//       "off"        -- never skip.
//       "image-only" -- skip ONLY when the prompt references uploadDir, so
//                       the common text path stays locked down. NOTE: the
//                       trigger is a substring match on the prompt, so a
//                       caller with the token can opt in by naming that path
//                       -- it bounds ACCIDENTAL exposure, not a determined
//                       token-holder. Still far tighter than "always".
//       "always"     -- skip for every prompt; the whole gateway is
//                       command-capable to anyone with the token.
//   - The plex precedent discards stderr; here every failure keeps a
//     stderr tail, because agy failure detail lives there.
//   - The execFile timeout kills with SIGKILL, not the SIGTERM default:
//     graceful cancel was already out of scope, and a SIGTERM-ignoring
//     wedged child would never settle the promise -- permanently leaking
//     a concurrency slot with no crash to trigger a systemd restart.
//   - The timeout budget starts at ENQUEUE and spans queue wait plus
//     execution: a request that expires while queued is removed and
//     resolved as a timeout without ever spawning a process, and a
//     request that starts late only gets its REMAINING budget.

const STDERR_TAIL_CHARS = 2000;
const VALID_OUTPUT_FORMATS = new Set(["json", "text"]);

/**
 * Last ~2000 chars of captured stderr, or undefined when empty/absent.
 * @param {unknown} stderr
 * @returns {string|undefined}
 */
function stderrTailOf(stderr) {
  if (typeof stderr !== "string" || stderr === "") return undefined;
  return stderr.slice(-STDERR_TAIL_CHARS);
}

/**
 * @param {string} errorKind
 * @param {string} message
 * @param {number} durationMs
 * @param {unknown} [stderr]
 */
function failure(errorKind, message, durationMs, stderr) {
  const result = { ok: false, errorKind, message, durationMs };
  const tail = stderrTailOf(stderr);
  if (tail !== undefined) result.stderrTail = tail;
  return result;
}

/**
 * Creates a bounded agy runner.
 *
 * @param {{
 *   agyPath: string,
 *   maxConcurrent?: number,
 *   defaultTimeoutMs?: number,
 *   maxTimeoutMs?: number,
 *   defaultEffort?: string,
 *   sandbox?: boolean,
 *   execFileImpl?: (file: string, args: string[], options: object) => Promise<{stdout: string, stderr?: string}>,
 * }} options
 * @returns {{run(request: object): Promise<object>, stats(): {running: number, queued: number}}}
 */
export function createAgyRunner({
  agyPath,
  maxConcurrent = 3,
  defaultTimeoutMs = 300_000,
  maxTimeoutMs = 900_000,
  defaultEffort = "high",
  sandbox = false,
  skipPermissionsMode = "off",
  uploadDir = null,
  addDirs = [],
  execFileImpl = promisify(execFile),
} = {}) {
  if (typeof agyPath !== "string" || agyPath.trim() === "") {
    throw new Error("createAgyRunner requires a non-empty agyPath");
  }
  if (!Array.isArray(addDirs) || addDirs.some((d) => typeof d !== "string" || d.trim() === "")) {
    throw new Error("createAgyRunner addDirs must be an array of non-empty strings");
  }

  let running = 0;
  /** @type {Array<{grant: () => void}>} */
  const waitQueue = [];

  /**
   * Acquires a semaphore slot, waiting at most waitBudgetMs. Resolves
   * true when the slot was acquired (caller must releaseSlot()), false
   * when the budget expired while still queued (entry is removed from
   * the queue; no slot was consumed).
   * @param {number} waitBudgetMs
   * @returns {Promise<boolean>}
   */
  function acquireSlot(waitBudgetMs) {
    if (running < maxConcurrent) {
      running += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const entry = {
        grant() {
          clearTimeout(timer);
          running += 1;
          resolve(true);
        },
      };
      const timer = setTimeout(() => {
        const idx = waitQueue.indexOf(entry);
        if (idx !== -1) waitQueue.splice(idx, 1);
        resolve(false);
      }, Math.max(0, waitBudgetMs));
      waitQueue.push(entry);
    });
  }

  function releaseSlot() {
    running -= 1;
    const next = waitQueue.shift();
    if (next) next.grant();
  }

  /**
   * Runs one agy invocation with the remaining budget. Never throws.
   * @param {{prompt: string, outputFormat: string, jsonSchema?: string, effort: string}} req
   * @param {number} remainingMs
   * @param {number} startedAt
   */
  async function invoke(req, remainingMs, startedAt) {
    const args = ["-p", req.prompt, "--output-format", req.outputFormat];
    if (req.jsonSchema !== undefined) args.push("--json-schema", req.jsonSchema);
    args.push("--effort", req.effort);
    for (const dir of addDirs) args.push("--add-dir", dir);
    args.push("--print-timeout", `${Math.ceil(remainingMs / 1000)}s`);
    // KTD6 opt-in: auto-approve all tools so agy can run the `command` tool it
    // uses to view images. "image-only" scopes it to prompts referencing an
    // uploaded file; plain text prompts never get command capability.
    const skipPerms =
      skipPermissionsMode === "always" ||
      (skipPermissionsMode === "image-only" &&
        typeof uploadDir === "string" &&
        uploadDir !== "" &&
        typeof req.prompt === "string" &&
        req.prompt.includes(uploadDir));
    if (skipPerms) args.push("--dangerously-skip-permissions");
    if (sandbox) args.push("--sandbox");

    let stdout;
    let stderr;
    try {
      ({ stdout, stderr } = await execFileImpl(agyPath, args, {
        timeout: remainingMs,
        maxBuffer: 10 * 1024 * 1024,
        killSignal: "SIGKILL",
      }));
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (error?.code === "ENOENT") {
        return failure("not-found", `agy CLI not found at "${agyPath}"`, durationMs, error?.stderr);
      }
      if (error?.killed) {
        return failure(
          "timeout",
          `agy call exceeded its ${req.effectiveTimeoutMs}ms budget and was killed`,
          durationMs,
          error?.stderr
        );
      }
      return failure(
        "exit",
        `agy exited with an error: ${error?.message ?? String(error)}`,
        durationMs,
        error?.stderr
      );
    }

    const durationMs = Date.now() - startedAt;

    if (req.outputFormat === "text") {
      // Text mode: stdout verbatim, no JSON parsing, no status check.
      return { ok: true, text: stdout, durationMs };
    }

    let body;
    try {
      body = JSON.parse(stdout);
    } catch {
      return failure("bad-output", "agy stdout was not parseable JSON", durationMs, stderr);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return failure("bad-output", "agy stdout was not a JSON object", durationMs, stderr);
    }
    if (body.status !== "SUCCESS") {
      return failure(
        "agy-status",
        `agy reported status "${body.status ?? "(missing)"}"`,
        durationMs,
        stderr
      );
    }
    return { ok: true, agy: body, durationMs };
  }

  /**
   * Validates and runs one request. Never rejects for per-run failures --
   * always resolves a typed result object.
   *
   * `onStart` (U4 extension) is invoked exactly once, after the semaphore
   * slot is acquired and before execFileImpl -- never for bad-request or
   * queued-timeout paths. The job store uses it to move a job from
   * "queued" to "running" on real execution start, not on enqueue.
   * @param {{prompt: string, effort?: string, outputFormat?: string, jsonSchema?: string, timeoutMs?: number, onStart?: () => void}} request
   */
  async function run(request) {
    const startedAt = Date.now();

    // Caller errors: resolved without consuming a slot (sixth kind,
    // distinct from the five agy-side kinds).
    if (!request || typeof request !== "object") {
      return failure("bad-request", "request must be an object", 0);
    }
    const { prompt, effort = defaultEffort, outputFormat = "json", jsonSchema, timeoutMs, onStart } = request;
    if (typeof prompt !== "string" || prompt.trim() === "") {
      return failure("bad-request", "prompt must be a non-empty string", 0);
    }
    if (!VALID_OUTPUT_FORMATS.has(outputFormat)) {
      return failure(
        "bad-request",
        `outputFormat must be "json" or "text", got ${JSON.stringify(outputFormat)}`,
        0
      );
    }
    if (timeoutMs !== undefined && !(Number.isInteger(timeoutMs) && timeoutMs >= 1)) {
      return failure(
        "bad-request",
        `timeoutMs must be an integer >= 1, got ${String(timeoutMs)}`,
        0
      );
    }
    if (effort !== undefined && (typeof effort !== "string" || effort.trim() === "")) {
      return failure("bad-request", "effort must be a non-empty string", 0);
    }
    if (jsonSchema !== undefined && typeof jsonSchema !== "string") {
      return failure("bad-request", "jsonSchema must be a string", 0);
    }

    const effectiveTimeoutMs = Math.min(timeoutMs ?? defaultTimeoutMs, maxTimeoutMs);
    const deadline = startedAt + effectiveTimeoutMs;

    const acquired = await acquireSlot(deadline - Date.now());
    if (!acquired) {
      // Budget spent entirely in the queue: same errorKind as an
      // execution timeout, but execFileImpl was never invoked.
      return failure(
        "timeout",
        `request timed out after ${effectiveTimeoutMs}ms while waiting for an agy slot`,
        Date.now() - startedAt
      );
    }

    try {
      // Execution is genuinely starting (slot held, execFile next). A
      // throwing callback must not break the run or leak the slot.
      if (typeof onStart === "function") {
        try {
          onStart();
        } catch {
          // Observer-only callback: its errors are its own problem.
        }
      }
      const remainingMs = Math.max(1, deadline - Date.now());
      return await invoke(
        { prompt, outputFormat, jsonSchema, effort, effectiveTimeoutMs },
        remainingMs,
        startedAt
      );
    } finally {
      // The slot is released on success AND on every failure path.
      releaseSlot();
    }
  }

  function stats() {
    return { running, queued: waitQueue.length };
  }

  return { run, stats };
}
