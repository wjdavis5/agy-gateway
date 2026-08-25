// Thin entrypoint: wire config -> runner -> job store -> handler -> HTTP.
// All logic lives under src/ (covered by node --test); this file only
// composes it, per the plex thin-entrypoint convention.
import { access } from "node:fs/promises";
import { constants, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadConfig } from "./src/config.js";
import { createAgyRunner } from "./src/agyRunner.js";
import { createJobStore } from "./src/jobs.js";
import { createRequestHandler, startWebServer } from "./src/server.js";
import { createOtelLogShipper } from "./src/otelLog.js";

const execFileAsync = promisify(execFile);

const config = loadConfig();

// Central log shipping (see src/otelLog.js): every line below goes to
// stdout/journald AND, fire-and-forget, to the local OTel Collector.
const shipper = config.otelLogsEnabled
  ? createOtelLogShipper({
      endpoint: config.otelLogsEndpoint,
      onError: (error) => console.error("otel log shipping failed:", error?.message ?? error),
    })
  : null;
const logInfo = (line) => {
  console.log(line);
  shipper?.send(line, "info");
};
const logError = (...args) => {
  const line = args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ");
  console.error(line);
  shipper?.send(line, "error");
};

const runner = createAgyRunner({
  agyPath: config.agyPath,
  maxConcurrent: config.agyMaxConcurrent,
  defaultTimeoutMs: config.agyTimeoutMs,
  maxTimeoutMs: config.agyTimeoutMaxMs,
  defaultEffort: config.agyEffort,
  sandbox: config.agySandbox,
  addDirs: config.agyAddDirs,
});

const jobStore = createJobStore({ runner, ttlMs: config.jobTtlMs, logImpl: logInfo });

// Health probe: `agy --version` runs once at startup and is cached (it
// won't change under a running gateway); the cheap fs access check runs
// per health call so `present` recovers if the binary (re)appears. The
// probe must NOT gate the listener -- a slow or missing binary would
// otherwise hold the port closed (connection refused) for up to 15s when
// a fast "degraded" 503 is the whole point of /health.
let cachedVersion = null;
const versionProbe = execFileAsync(config.agyPath, ["--version"], { timeout: 15_000 })
  .then(({ stdout }) => {
    cachedVersion = stdout.trim() || null;
  })
  .catch(() => {});

async function healthProbe() {
  const present = await access(config.agyPath, constants.X_OK).then(
    () => true,
    () => false
  );
  return { present, version: cachedVersion };
}

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const requestHandler = createRequestHandler({ config, runner, jobStore, healthProbe, version });
await startWebServer({ port: config.port, requestHandler, logImpl: logError, requestLogImpl: logInfo });

setInterval(jobStore.sweep, 3_600_000).unref();

// Awaited only for the log line -- the server is already accepting.
await versionProbe;
// Log policy: never prompts/results -- this line and nothing chattier.
logInfo(`agy-gateway listening on port ${config.port} (agy: ${config.agyPath}, version: ${cachedVersion ?? "unknown"})`);
