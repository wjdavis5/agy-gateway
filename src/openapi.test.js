import test from "node:test";
import assert from "node:assert/strict";

import { buildOpenApiSpec } from "./openapi.js";

function config(overrides = {}) {
  return {
    agyTimeoutMs: 300_000,
    agyTimeoutMaxMs: 900_000,
    agyMaxConcurrent: 3,
    agyEffort: "high",
    agyMaxBodyBytes: 1_048_576,
    agyMaxUploadBytes: 26_214_400,
    agyUploadDir: "/mnt/agy-share/uploads",
    jobTtlMs: 86_400_000,
    ...overrides,
  };
}

test("spec is OpenAPI 3.1 with all live endpoints and bearer auth", () => {
  const spec = buildOpenApiSpec({ config: config(), version: "1.2.3" });
  assert.match(spec.openapi, /^3\.1\./);
  assert.equal(spec.info.version, "1.2.3");
  for (const path of ["/run", "/jobs", "/jobs/{jobId}", "/files", "/health", "/openapi.json"]) {
    assert.ok(spec.paths[path], `missing path ${path}`);
  }
  assert.ok(spec.components.securitySchemes.bearerAuth);
  // Authed routes carry security; discovery routes don't.
  assert.ok(spec.paths["/run"].post.security);
  assert.equal(spec.paths["/health"].get.security, undefined);
  assert.equal(spec.paths["/openapi.json"].get.security, undefined);
});

test("spec reflects the live config's caps and defaults", () => {
  const spec = buildOpenApiSpec({
    config: config({ agyTimeoutMaxMs: 123_456, agyMaxUploadBytes: 777 }),
    version: "0.0.0",
  });
  const timeoutMs = spec.components.schemas.RunRequest.properties.timeoutMs;
  assert.equal(timeoutMs.maximum, 123_456);
  assert.match(JSON.stringify(spec.paths["/files"]), /777/);
});

test("spec omits /files when uploads are disabled", () => {
  const spec = buildOpenApiSpec({ config: config({ agyUploadDir: null }), version: "0.0.0" });
  assert.equal(spec.paths["/files"], undefined);
  assert.ok(spec.paths["/run"]);
});

test("errorKind enum and job states are enumerated", () => {
  const spec = buildOpenApiSpec({ config: config(), version: "0.0.0" });
  const kinds = spec.components.schemas.RunFailure.properties.errorKind.enum;
  assert.deepEqual(
    [...kinds].sort(),
    ["agy-status", "bad-output", "bad-request", "exit", "not-found", "timeout"]
  );
  const states = spec.components.schemas.Job.properties.state.enum;
  assert.deepEqual([...states].sort(), ["failed", "queued", "running", "succeeded"]);
});
