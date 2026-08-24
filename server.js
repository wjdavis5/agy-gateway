// Thin entrypoint: wire config -> runner -> job store -> handler -> HTTP.
// All logic lives under src/ (covered by node --test); this file only
// composes it, per the plex thin-entrypoint convention.
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadConfig } from "./src/config.js";
import { createAgyRunner } from "./src/agyRunner.js";
import { createJobStore } from "./src/jobs.js";
import { createRequestHandler, startWebServer } from "./src/server.js";

const execFileAsync = promisify(execFile);

const config = loadConfig();

const runner = createAgyRunner({
  agyPath: config.agyPath,
  maxConcurrent: config.agyMaxConcurrent,
  defaultTimeoutMs: config.agyTimeoutMs,
  maxTimeoutMs: config.agyTimeoutMaxMs,
  defaultEffort: config.agyEffort,
  sandbox: config.agySandbox,
});

const jobStore = createJobStore({ runner, ttlMs: config.jobTtlMs });

// Health probe: `agy --version` runs once at startup and is cached (it
// won't change under a running gateway); the cheap fs access check runs
// per health call so `present` recovers if the binary (re)appears.
const cachedVersion = await execFileAsync(config.agyPath, ["--version"], { timeout: 15_000 })
  .then(({ stdout }) => stdout.trim() || null)
  .catch(() => null);

async function healthProbe() {
  const present = await access(config.agyPath, constants.X_OK).then(
    () => true,
    () => false
  );
  return { present, version: cachedVersion };
}

const requestHandler = createRequestHandler({ config, runner, jobStore, healthProbe });
await startWebServer({ port: config.port, requestHandler });

setInterval(jobStore.sweep, 3_600_000).unref();

// Log policy: never prompts/results -- this line and nothing chattier.
console.log(`agy-gateway listening on port ${config.port} (agy: ${config.agyPath}, version: ${cachedVersion ?? "unknown"})`);
