import test from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "./config.js";

// All tests inject env objects and a stub loadEnvFileImpl -- never the real
// process.env or a real .env file, per the mock-the-boundary convention.

const BASE = { AGY_GATEWAY_TOKEN: "test-token" };

function load(env = {}, options = {}) {
  return loadConfig({
    env: { ...BASE, ...env },
    loadEnvFileImpl: () => {},
    ...options,
  });
}

test("defaults are applied when only the token is set", () => {
  const config = load();
  assert.equal(config.agyGatewayToken, "test-token");
  assert.equal(config.port, 8100);
  assert.equal(config.agyPath, "/root/.local/bin/agy");
  assert.equal(config.agyTimeoutMs, 300_000);
  assert.equal(config.agyTimeoutMaxMs, 900_000);
  assert.equal(config.agyMaxConcurrent, 3);
  assert.equal(config.agyEffort, "high");
  assert.equal(config.agySandbox, false);
  assert.equal(config.agyMaxBodyBytes, 1_048_576);
  assert.equal(config.jobTtlMs, 86_400_000);
});

test("explicit env values override the defaults", () => {
  const config = load({
    PORT: "9000",
    AGY_PATH: "/usr/local/bin/agy",
    AGY_TIMEOUT_MS: "1000",
    AGY_TIMEOUT_MAX_MS: "2000",
    AGY_MAX_CONCURRENT: "5",
    AGY_EFFORT: "low",
    AGY_SANDBOX: "true",
    AGY_MAX_BODY_BYTES: "2048",
    JOB_TTL_MS: "60000",
  });
  assert.equal(config.port, 9000);
  assert.equal(config.agyPath, "/usr/local/bin/agy");
  assert.equal(config.agyTimeoutMs, 1000);
  assert.equal(config.agyTimeoutMaxMs, 2000);
  assert.equal(config.agyMaxConcurrent, 5);
  assert.equal(config.agyEffort, "low");
  assert.equal(config.agySandbox, true);
  assert.equal(config.agyMaxBodyBytes, 2048);
  assert.equal(config.jobTtlMs, 60_000);
});

test("a missing token throws an error naming AGY_GATEWAY_TOKEN", () => {
  assert.throws(
    () => loadConfig({ env: {}, loadEnvFileImpl: () => {} }),
    /AGY_GATEWAY_TOKEN/
  );
  assert.throws(
    () => loadConfig({ env: { AGY_GATEWAY_TOKEN: "" }, loadEnvFileImpl: () => {} }),
    /AGY_GATEWAY_TOKEN/
  );
});

test("an invalid int throws an error naming the variable", () => {
  assert.throws(() => load({ PORT: "abc" }), /PORT/);
  assert.throws(() => load({ AGY_TIMEOUT_MS: "12.5" }), /AGY_TIMEOUT_MS/);
  assert.throws(() => load({ AGY_TIMEOUT_MS: "0" }), /AGY_TIMEOUT_MS/);
  assert.throws(() => load({ AGY_MAX_CONCURRENT: "-1" }), /AGY_MAX_CONCURRENT/);
  assert.throws(() => load({ AGY_MAX_BODY_BYTES: "big" }), /AGY_MAX_BODY_BYTES/);
  assert.throws(() => load({ JOB_TTL_MS: "" }), /JOB_TTL_MS/);
});

test("AGY_SANDBOX parses only the strings true and false", () => {
  assert.equal(load({ AGY_SANDBOX: "true" }).agySandbox, true);
  assert.equal(load({ AGY_SANDBOX: "false" }).agySandbox, false);
  assert.throws(() => load({ AGY_SANDBOX: "yes" }), /AGY_SANDBOX/);
});

test("AGY_EFFORT accepts only low, medium, high", () => {
  assert.equal(load({ AGY_EFFORT: "medium" }).agyEffort, "medium");
  assert.throws(() => load({ AGY_EFFORT: "max" }), /AGY_EFFORT/);
});

test("a missing .env file is tolerated (ENOENT from the loader is swallowed)", () => {
  const seenPaths = [];
  const config = loadConfig({
    env: { AGY_GATEWAY_TOKEN: "tok" },
    envFilePath: "/nonexistent/.env",
    loadEnvFileImpl: (path) => {
      seenPaths.push(path);
      const error = new Error("ENOENT: no such file or directory");
      error.code = "ENOENT";
      throw error;
    },
  });
  assert.equal(config.agyGatewayToken, "tok");
  assert.deepEqual(seenPaths, ["/nonexistent/.env"]);
});

test("upload and add-dir settings parse with safe defaults", () => {
  const base = { AGY_GATEWAY_TOKEN: "t" };
  const load = (env) => loadConfig({ env, loadEnvFileImpl: () => {} });

  const defaults = load(base);
  assert.deepEqual(defaults.agyAddDirs, []);
  assert.equal(defaults.agyUploadDir, null);
  assert.equal(defaults.agyMaxUploadBytes, 26_214_400);

  const set = load({
    ...base,
    AGY_ADD_DIRS: "/mnt/agy-share, /extra",
    AGY_UPLOAD_DIR: "/mnt/agy-share/uploads",
    AGY_MAX_UPLOAD_BYTES: "1000",
  });
  assert.deepEqual(set.agyAddDirs, ["/mnt/agy-share", "/extra"]);
  assert.equal(set.agyUploadDir, "/mnt/agy-share/uploads");
  assert.equal(set.agyMaxUploadBytes, 1000);

  assert.throws(() => load({ ...base, AGY_MAX_UPLOAD_BYTES: "zero" }), /AGY_MAX_UPLOAD_BYTES/);
});

test("otel log shipping settings parse with lab-standard defaults", () => {
  const base = { AGY_GATEWAY_TOKEN: "t" };
  const load = (env) => loadConfig({ env, loadEnvFileImpl: () => {} });

  const defaults = load(base);
  assert.equal(defaults.otelLogsEnabled, true);
  assert.equal(defaults.otelLogsEndpoint, "http://127.0.0.1:4318/v1/logs");

  const off = load({ ...base, OTEL_LOGS_ENABLED: "false" });
  assert.equal(off.otelLogsEnabled, false);

  const custom = load({ ...base, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://otel:4318/v1/logs" });
  assert.equal(custom.otelLogsEndpoint, "http://otel:4318/v1/logs");
});
