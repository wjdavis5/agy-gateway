import http from "node:http";
import crypto from "node:crypto";
import { writeFile } from "node:fs/promises";

import { buildOpenApiSpec } from "./openapi.js";

// The gateway's network surface: bearer-auth'd sync (/run) and async
// (/jobs) endpoints over the U3 runner, plus an unauthenticated /health.
//
// Mirrors plex/src/organize/webUI.js's split: createRequestHandler() is
// duck-typed against req/res (req.method/url/headers + async-iterable
// body, res.writeHead/end) so tests pass plain objects with no sockets,
// and startWebServer() is a thin node:http wrapper that catches handler
// rejections into a 500 and resolves once listening.
//
// Log policy (deliberate): nothing here logs prompt bodies, schemas, or
// agy result bodies -- prompts can carry sensitive content from any lab
// service. Method/path/status/jobId/durationMs are the ceiling.

// Runner errorKind -> HTTP status for the sync endpoint. Every failure
// body is the runner's typed result verbatim.
const ERROR_KIND_STATUS = {
  "bad-request": 400,
  timeout: 504,
  "not-found": 503,
  exit: 502,
  "bad-output": 502,
  "agy-status": 502,
};

// The only body fields forwarded to the runner -- anything else in the
// posted JSON (including an attacker-supplied onStart) is dropped.
const ALLOWED_RUN_FIELDS = ["prompt", "effort", "outputFormat", "jsonSchema", "timeoutMs"];

// prompt/jsonSchema are each passed to agy as one CLI argument, and
// Linux limits a single argv arg to ~128KiB (E2BIG beyond). Cap well
// under that so oversized inputs get a clear 400, not an opaque 502.
const MAX_CLI_ARG_CHARS = 100_000;

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

/**
 * Constant-time bearer-token check. Comparing SHA-256 digests (always 32
 * bytes) rather than the raw strings keeps timingSafeEqual's equal-length
 * precondition satisfied without leaking the expected token's length.
 * @param {unknown} headerValue - the raw authorization header
 * @param {Buffer} expectedTokenHash
 */
function isAuthorized(headerValue, expectedTokenHash) {
  if (typeof headerValue !== "string") return false;
  const prefix = "Bearer ";
  if (!headerValue.startsWith(prefix)) return false;
  const presented = sha256(headerValue.slice(prefix.length));
  return crypto.timingSafeEqual(presented, expectedTokenHash);
}

/**
 * Reads the request body with a hard byte cap. The moment the running
 * count exceeds maxBytes it stops consuming and reports too-large --
 * never buffering an unbounded payload first.
 * @param {AsyncIterable<Buffer|string>} req
 * @param {number} maxBytes
 * @returns {Promise<{tooLarge: true} | {tooLarge: false, raw: string}>}
 */
async function readBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > maxBytes) {
      // Stop consuming, but don't destroy here: tearing down the socket
      // before the 413 is written would make real clients see
      // ECONNRESET instead of the response. The caller destroys after
      // the response has flushed.
      return { tooLarge: true };
    }
    chunks.push(buf);
  }
  return { tooLarge: false, raw: Buffer.concat(chunks) };
}

/**
 * Parses and validates a POST body into a runner request.
 * @returns {{ok: true, request: object} | {ok: false, error: string}}
 */
function parseRunRequest(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, error: "body must be valid JSON" };
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
    return { ok: false, error: "prompt must be a non-empty string" };
  }
  // agy receives prompt and jsonSchema as single CLI arguments; Linux
  // caps one argv arg at ~128KiB, so anything bigger dies as an opaque
  // E2BIG 502. Reject it up front with a clear 400 instead.
  if (body.prompt.length > MAX_CLI_ARG_CHARS) {
    return { ok: false, error: `prompt exceeds ${MAX_CLI_ARG_CHARS} characters (agy receives it as a single CLI argument)` };
  }
  if (typeof body.jsonSchema === "string" && body.jsonSchema.length > MAX_CLI_ARG_CHARS) {
    return { ok: false, error: `jsonSchema exceeds ${MAX_CLI_ARG_CHARS} characters (agy receives it as a single CLI argument)` };
  }
  const request = {};
  for (const field of ALLOWED_RUN_FIELDS) {
    if (body[field] !== undefined) request[field] = body[field];
  }
  return { ok: true, request };
}

/**
 * Builds the /health payload. Pure over its injected inputs (probe,
 * stats, counts, clock) -- exported separately so tests hit it directly,
 * like plex's buildHealthPayload.
 * @param {object} params
 * @param {object} params.config
 * @param {{stats: () => {running: number, queued: number}}} params.runner
 * @param {{counts: () => {stored: number}}} params.jobStore
 * @param {() => Promise<{present: boolean, version: string|null}>} params.healthProbe
 * @param {number} params.startedAtMs
 * @param {() => number} [params.now]
 * @returns {Promise<{ok: boolean, body: object}>} ok=false means degraded (HTTP 503).
 */
export async function buildHealthPayload({ config, runner, jobStore, healthProbe, startedAtMs, now = Date.now }) {
  const probe = await healthProbe();
  const nowMs = now();
  const stats = runner.stats();
  const ok = probe.present === true;
  const body = {
    status: ok ? "ok" : "degraded",
    pid: process.pid,
    startedAt: new Date(startedAtMs).toISOString(),
    uptimeSeconds: Math.round((nowMs - startedAtMs) / 1000),
    agy: { path: config.agyPath, present: probe.present, version: probe.version },
    jobs: { running: stats.running, queued: stats.queued, stored: jobStore.counts().stored },
    maxConcurrent: config.agyMaxConcurrent,
  };
  return { ok, body };
}

/**
 * Builds the duck-typed request handler.
 * @param {object} params
 * @param {object} params.config
 * @param {{run: Function, stats: Function}} params.runner
 * @param {{submit: Function, get: Function, list: Function, counts: Function}} params.jobStore
 * @param {() => Promise<{present: boolean, version: string|null}>} params.healthProbe
 * @param {() => number} [params.now]
 * @returns {(req: object, res: object) => Promise<void>}
 */
export function createRequestHandler({ config, runner, jobStore, healthProbe, now = Date.now, fsImpl = { writeFile }, version = "0.0.0" }) {
  const startedAtMs = now();
  const tokenHash = sha256(config.agyGatewayToken);

  /** Reads + validates a POST body; on failure the response was already sent. */
  async function readValidBody(req, res) {
    const body = await readBody(req, config.agyMaxBodyBytes);
    if (body.tooLarge) {
      sendJson(res, 413, { ok: false, error: "body too large" });
      // Drop the connection only once the 413 has flushed -- destroying
      // first tears down the shared socket and the client sees
      // ECONNRESET, never the response. Guarded: plain test doubles may
      // lack once()/destroy().
      if (typeof res.once === "function" && typeof req.destroy === "function") {
        res.once("finish", () => req.destroy());
      }
      return undefined;
    }
    const parsed = parseRunRequest(body.raw.toString("utf8"));
    if (!parsed.ok) {
      sendJson(res, 400, { ok: false, error: parsed.error });
      return undefined;
    }
    return parsed.request;
  }

  // Built once per handler (config is fixed for the process lifetime).
  let cachedSpec = null;

  return async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    // Discovery routes are unauthenticated like /health: the spec reveals
    // the API's shape, never its token.
    if (path === "/" || path === "/openapi.json") {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      if (path === "/") {
        sendJson(res, 200, {
          ok: true,
          service: "agy-gateway",
          version,
          openapi: "/openapi.json",
          health: "/health",
        });
        return;
      }
      cachedSpec ??= buildOpenApiSpec({ config, version });
      sendJson(res, 200, cachedSpec);
      return;
    }

    // /health is the one unauthenticated route (KTD8) -- an external
    // monitor gets liveness without holding the token.
    if (path === "/health") {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      const { ok, body } = await buildHealthPayload({ config, runner, jobStore, healthProbe, startedAtMs, now });
      sendJson(res, ok ? 200 : 503, body);
      return;
    }

    // Auth before anything else -- especially before reading any body, so
    // an unauthorized caller can't make the server buffer a payload.
    if (!isAuthorized(req.headers?.authorization, tokenHash)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    if (path === "/files") {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      if (!config.agyUploadDir) {
        sendJson(res, 404, { ok: false, error: "uploads not enabled (set AGY_UPLOAD_DIR)" });
        return;
      }
      const body = await readBody(req, config.agyMaxUploadBytes);
      if (body.tooLarge) {
        sendJson(res, 413, { ok: false, error: "file too large" });
        if (typeof res.once === "function" && typeof req.destroy === "function") {
          res.once("finish", () => req.destroy());
        }
        return;
      }
      if (body.raw.length === 0) {
        sendJson(res, 400, { ok: false, error: "empty upload body" });
        return;
      }
      // Only the extension of a caller-suggested ?name= survives; the
      // stored name is server-minted, so no caller input reaches the
      // filesystem path in any other form (no traversal surface).
      const suggested = url.searchParams.get("name") ?? "";
      const extMatch = suggested.match(/\.([A-Za-z0-9]{1,8})$/);
      const name = crypto.randomUUID() + (extMatch ? `.${extMatch[1].toLowerCase()}` : "");
      const containerPath = `${config.agyUploadDir.replace(/\/+$/, "")}/${name}`;
      await fsImpl.writeFile(containerPath, body.raw);
      sendJson(res, 201, { ok: true, file: { name, containerPath, bytes: body.raw.length } });
      return;
    }

    if (path === "/run") {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      const request = await readValidBody(req, res);
      if (!request) return;
      const result = await runner.run(request);
      const status = result.ok ? 200 : (ERROR_KIND_STATUS[result.errorKind] ?? 502);
      sendJson(res, status, result);
      return;
    }

    if (path === "/jobs") {
      if (req.method === "POST") {
        const request = await readValidBody(req, res);
        if (!request) return;
        const jobId = jobStore.submit(request);
        sendJson(res, 202, { jobId, state: "queued" });
        return;
      }
      if (req.method === "GET") {
        sendJson(res, 200, { jobs: jobStore.list() });
        return;
      }
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }

    const jobMatch = path.match(/^\/jobs\/([^/]+)$/);
    if (jobMatch) {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      // Malformed percent-encoding throws URIError; server-minted UUIDs
      // never need decoding to fail, so treat it as not-found.
      let jobId;
      try {
        jobId = decodeURIComponent(jobMatch[1]);
      } catch {
        sendJson(res, 404, { ok: false, error: "job not found" });
        return;
      }
      const job = jobStore.get(jobId);
      if (!job) {
        sendJson(res, 404, { ok: false, error: "job not found" });
        return;
      }
      sendJson(res, 200, job);
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  };
}

/**
 * Starts the HTTP server: a thin wrapper over node:http; all real logic
 * lives in createRequestHandler(), tested without sockets.
 * @param {object} params
 * @param {number} params.port
 * @param {(req: object, res: object) => Promise<void>} params.requestHandler
 * @param {{createServer: Function}} [params.httpImpl]
 * @param {(...args: unknown[]) => void} [params.logImpl]
 * @returns {Promise<import('node:http').Server>} resolves once listening.
 */
export function startWebServer({ port, requestHandler, httpImpl = http, logImpl = console.error }) {
  const server = httpImpl.createServer((req, res) => {
    Promise.resolve(requestHandler(req, res)).catch(() => {
      // The error itself is not echoed to the client (it could quote
      // request content); a bare 500 is all an HTTP caller needs.
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "internal error" }, null, 2));
    });
  });
  // The one-shot reject only covers the pre-listen window; after that a
  // rejected promise is a no-op, so a persistent listener keeps
  // post-listen 'error' events from vanishing (or crashing the process
  // with zero listeners). Log policy: message only, never bodies.
  server.on("error", (err) => {
    logImpl("agy-gateway http server error:", err?.message ?? err);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve(server));
  });
}
