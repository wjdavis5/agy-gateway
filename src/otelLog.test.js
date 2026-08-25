import test from "node:test";
import assert from "node:assert/strict";

import { buildOtlpLogPayload, createOtelLogShipper } from "./otelLog.js";

test("buildOtlpLogPayload(): well-formed OTLP envelope with explicit severity level", () => {
  const now = () => new Date(1_700_000_000_000);
  const info = buildOtlpLogPayload("GET /health 200 3ms", { serviceName: "agy-gateway", level: "info", now });
  const record = info.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(record.body.stringValue, "GET /health 200 3ms");
  assert.equal(record.severityText, "INFO");
  assert.equal(record.severityNumber, 9);
  assert.equal(record.timeUnixNano, "1700000000000000000");
  assert.deepEqual(info.resourceLogs[0].resource.attributes, [
    { key: "service.name", value: { stringValue: "agy-gateway" } },
  ]);

  const error = buildOtlpLogPayload("boom", { serviceName: "agy-gateway", level: "error", now });
  const errRecord = error.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(errRecord.severityText, "ERROR");
  assert.equal(errRecord.severityNumber, 17);
});

test("send() POSTs the payload to the endpoint and never throws on rejection", async () => {
  const calls = [];
  const ok = createOtelLogShipper({
    endpoint: "http://fake/v1/logs",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    },
  });
  ok.send("hello", "info");
  await new Promise((res) => setImmediate(res));
  assert.equal(calls[0].url, "http://fake/v1/logs");
  assert.equal(calls[0].options.method, "POST");
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.resourceLogs[0].scopeLogs[0].logRecords[0].body.stringValue, "hello");

  const failing = createOtelLogShipper({
    endpoint: "http://fake/v1/logs",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.doesNotThrow(() => failing.send("x", "error"));
});

test("a failed send calls onError exactly once until a send succeeds again", async () => {
  const errors = [];
  let shouldFail = true;
  const shipper = createOtelLogShipper({
    endpoint: "http://fake/v1/logs",
    fetchImpl: async () => {
      if (shouldFail) throw new Error("down");
      return { ok: true, status: 200 };
    },
    onError: (e) => errors.push(e.message),
  });

  shipper.send("a", "info");
  shipper.send("b", "info");
  await new Promise((res) => setImmediate(res));
  assert.equal(errors.length, 1, "only the first consecutive failure is reported");

  shouldFail = false;
  shipper.send("c", "info");
  await new Promise((res) => setImmediate(res));
  shouldFail = true;
  shipper.send("d", "info");
  await new Promise((res) => setImmediate(res));
  assert.equal(errors.length, 2, "reporting re-arms after a success");
});
