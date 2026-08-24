import test from "node:test";
import assert from "node:assert/strict";

import { createRequestHandler, buildHealthPayload } from "./server.js";
import { createJobStore } from "./jobs.js";

// All tests pass plain duck-typed req/res objects -- no sockets, no real
// runner, no real agy binary -- per the plex webUI.js precedent.

const TOKEN = "test-token-123";

function baseConfig(overrides = {}) {
  return {
    agyGatewayToken: TOKEN,
    port: 8100,
    agyPath: "/root/.local/bin/agy",
    agyTimeoutMs: 300_000,
    agyTimeoutMaxMs: 900_000,
    agyMaxConcurrent: 3,
    agyEffort: "high",
    agySandbox: false,
    agyMaxBodyBytes: 1024,
    jobTtlMs: 86_400_000,
    ...overrides,
  };
}

function makeReq({ method = "GET", url = "/", headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)];
  const req = {
    method,
    url,
    headers,
    consumed: false,
    destroyed: false,
    destroy() {
      req.destroyed = true;
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        req.consumed = true;
        yield chunk;
        if (req.destroyed) return;
      }
    },
  };
  return req;
}

function authedReq(options = {}) {
  return makeReq({
    ...options,
    headers: { authorization: `Bearer ${TOKEN}`, ...(options.headers ?? {}) },
  });
}

function makeRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

function okRunner(result = { ok: true, agy: { status: "SUCCESS" }, durationMs: 5 }) {
  const calls = [];
  return {
    calls,
    run(request) {
      calls.push(request);
      return Promise.resolve(result);
    },
    stats: () => ({ running: 0, queued: 0 }),
  };
}

function emptyJobStore() {
  return {
    submit: () => "unused",
    get: () => undefined,
    list: () => [],
    counts: () => ({ stored: 0, byState: { queued: 0, running: 0, succeeded: 0, failed: 0 } }),
  };
}

function makeHandler({
  config = baseConfig(),
  runner = okRunner(),
  jobStore = emptyJobStore(),
  healthProbe = async () => ({ present: true, version: "1.1.19" }),
  now,
} = {}) {
  return createRequestHandler({ config, runner, jobStore, healthProbe, ...(now ? { now } : {}) });
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// --- Auth ---

test("a request without an authorization header gets 401 and the body is never read", async () => {
  const runner = okRunner();
  const handler = makeHandler({ runner });
  const req = makeReq({ method: "POST", url: "/run", body: JSON.stringify({ prompt: "p" }) });
  const res = makeRes();

  await handler(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { ok: false, error: "unauthorized" });
  assert.equal(req.consumed, false, "401 must be sent without consuming the request body");
  assert.equal(runner.calls.length, 0);
});

test("a wrong token gets 401", async () => {
  const handler = makeHandler();
  const res = makeRes();
  await handler(
    makeReq({
      method: "POST",
      url: "/run",
      headers: { authorization: "Bearer wrong-token" },
      body: JSON.stringify({ prompt: "p" }),
    }),
    res
  );
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.json(), { ok: false, error: "unauthorized" });
});

test("a malformed authorization header (no Bearer prefix) gets 401", async () => {
  const handler = makeHandler();
  const res = makeRes();
  await handler(makeReq({ url: "/jobs", headers: { authorization: TOKEN } }), res);
  assert.equal(res.statusCode, 401);
});

// --- POST /run (sync) ---

test("sync happy path: valid prompt returns 200 with the runner result verbatim", async () => {
  const result = { ok: true, agy: { status: "SUCCESS", response: "hi" }, durationMs: 42 };
  const runner = okRunner(result);
  const handler = makeHandler({ runner });
  const res = makeRes();

  await handler(
    authedReq({ method: "POST", url: "/run", body: JSON.stringify({ prompt: "hello" }) }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/json");
  assert.deepEqual(res.json(), result);
  assert.equal(runner.calls[0].prompt, "hello");
});

test("only the allowed request fields reach the runner", async () => {
  const runner = okRunner();
  const handler = makeHandler({ runner });
  const res = makeRes();
  await handler(
    authedReq({
      method: "POST",
      url: "/run",
      body: JSON.stringify({
        prompt: "p",
        effort: "low",
        outputFormat: "text",
        jsonSchema: "{}",
        timeoutMs: 1000,
        agyPath: "/evil/binary",
        onStart: "nope",
      }),
    }),
    res
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(runner.calls[0], {
    prompt: "p",
    effort: "low",
    outputFormat: "text",
    jsonSchema: "{}",
    timeoutMs: 1000,
  });
});

test("a runner timeout maps to 504 with the typed failure body verbatim", async () => {
  const failure = { ok: false, errorKind: "timeout", message: "too slow", durationMs: 300_000 };
  const handler = makeHandler({ runner: okRunner(failure) });
  const res = makeRes();
  await handler(authedReq({ method: "POST", url: "/run", body: JSON.stringify({ prompt: "p" }) }), res);
  assert.equal(res.statusCode, 504);
  assert.deepEqual(res.json(), failure);
});

test("a runner agy-status failure maps to 502", async () => {
  const failure = { ok: false, errorKind: "agy-status", message: 'agy reported status "CANCELED"', durationMs: 5, stderrTail: "denied" };
  const handler = makeHandler({ runner: okRunner(failure) });
  const res = makeRes();
  await handler(authedReq({ method: "POST", url: "/run", body: JSON.stringify({ prompt: "p" }) }), res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.json(), failure);
});

test("a runner not-found failure maps to 503 and bad-request to 400", async () => {
  const notFound = { ok: false, errorKind: "not-found", message: "no agy", durationMs: 1 };
  let res = makeRes();
  await makeHandler({ runner: okRunner(notFound) })(
    authedReq({ method: "POST", url: "/run", body: JSON.stringify({ prompt: "p" }) }),
    res
  );
  assert.equal(res.statusCode, 503);

  const badRequest = { ok: false, errorKind: "bad-request", message: "bad outputFormat", durationMs: 0 };
  res = makeRes();
  await makeHandler({ runner: okRunner(badRequest) })(
    authedReq({ method: "POST", url: "/run", body: JSON.stringify({ prompt: "p" }) }),
    res
  );
  assert.equal(res.statusCode, 400);
});

test("a missing or empty prompt gets 400 without calling the runner", async () => {
  const runner = okRunner();
  const handler = makeHandler({ runner });
  for (const body of [{}, { prompt: "" }, { prompt: "   " }, { prompt: 42 }]) {
    const res = makeRes();
    await handler(authedReq({ method: "POST", url: "/run", body: JSON.stringify(body) }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().ok, false);
  }
  assert.equal(runner.calls.length, 0);
});

test("an unparseable or non-object body gets 400", async () => {
  const handler = makeHandler();
  for (const body of ["{not json", '"just a string"', "[1,2]", "null"]) {
    const res = makeRes();
    await handler(authedReq({ method: "POST", url: "/run", body }), res);
    assert.equal(res.statusCode, 400, `body ${JSON.stringify(body)} must 400`);
  }
});

test("an oversized body gets 413 and the runner is never called", async () => {
  const runner = okRunner();
  const handler = makeHandler({ runner, config: baseConfig({ agyMaxBodyBytes: 10 }) });
  const res = makeRes();
  const req = authedReq({
    method: "POST",
    url: "/run",
    body: JSON.stringify({ prompt: "x".repeat(100) }),
  });
  await handler(req, res);
  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.json(), { ok: false, error: "body too large" });
  assert.equal(runner.calls.length, 0);
});

test("two concurrent POST /run calls are in flight simultaneously (no handler serialization)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const gate = deferred();
  const runner = {
    run() {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return gate.promise.then((r) => {
        inFlight -= 1;
        return r;
      });
    },
    stats: () => ({ running: inFlight, queued: 0 }),
  };
  const handler = makeHandler({ runner });

  const res1 = makeRes();
  const res2 = makeRes();
  const p1 = handler(authedReq({ method: "POST", url: "/run", body: JSON.stringify({ prompt: "one" }) }), res1);
  const p2 = handler(authedReq({ method: "POST", url: "/run", body: JSON.stringify({ prompt: "two" }) }), res2);

  // Let both handler invocations reach the runner.
  await new Promise((res) => setImmediate(res));
  assert.equal(maxInFlight, 2, "both runs must be in flight at once");

  gate.resolve({ ok: true, text: "done", durationMs: 1 });
  await Promise.all([p1, p2]);
  assert.equal(res1.statusCode, 200);
  assert.equal(res2.statusCode, 200);
});

// --- Jobs (async) ---

test("async flow: submit 202 queued, poll running, poll succeeded", async () => {
  const gate = deferred();
  let onStart;
  const runner = {
    run(request) {
      onStart = request.onStart;
      return gate.promise;
    },
    stats: () => ({ running: 0, queued: 0 }),
  };
  const jobStore = createJobStore({ runner, ttlMs: 86_400_000 });
  const handler = makeHandler({ runner, jobStore });

  const submitRes = makeRes();
  await handler(
    authedReq({ method: "POST", url: "/jobs", body: JSON.stringify({ prompt: "long task" }) }),
    submitRes
  );
  assert.equal(submitRes.statusCode, 202);
  const { jobId, state } = submitRes.json();
  assert.equal(state, "queued");
  assert.equal(typeof jobId, "string");

  onStart();
  let pollRes = makeRes();
  await handler(authedReq({ url: `/jobs/${jobId}` }), pollRes);
  assert.equal(pollRes.statusCode, 200);
  assert.equal(pollRes.json().state, "running");
  assert.equal(typeof pollRes.json().startedAt, "number");

  const result = { ok: true, agy: { status: "SUCCESS", response: "answer" }, durationMs: 9 };
  gate.resolve(result);
  await new Promise((res) => setImmediate(res));

  pollRes = makeRes();
  await handler(authedReq({ url: `/jobs/${jobId}` }), pollRes);
  assert.equal(pollRes.statusCode, 200);
  assert.equal(pollRes.json().state, "succeeded");
  assert.deepEqual(pollRes.json().result, result);
});

test("POST /jobs with an invalid prompt gets 400 and creates no job", async () => {
  const jobStore = emptyJobStore();
  let submitted = 0;
  jobStore.submit = () => {
    submitted += 1;
    return "id";
  };
  const handler = makeHandler({ jobStore });
  const res = makeRes();
  await handler(authedReq({ method: "POST", url: "/jobs", body: JSON.stringify({}) }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(submitted, 0);
});

test("GET of an unknown job id gets 404", async () => {
  const handler = makeHandler();
  const res = makeRes();
  await handler(authedReq({ url: "/jobs/does-not-exist" }), res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.json(), { ok: false, error: "job not found" });
});

test("GET /jobs lists jobs from list()", async () => {
  const jobStore = emptyJobStore();
  jobStore.list = () => [{ jobId: "j2", state: "running", createdAt: 2 }, { jobId: "j1", state: "succeeded", createdAt: 1, finishedAt: 3 }];
  const handler = makeHandler({ jobStore });
  const res = makeRes();
  await handler(authedReq({ url: "/jobs" }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { jobs: jobStore.list() });
});

// --- Health ---

test("GET /health needs no token and returns the expected shape", async () => {
  const runner = okRunner();
  runner.stats = () => ({ running: 2, queued: 1 });
  const jobStore = emptyJobStore();
  jobStore.counts = () => ({ stored: 7, byState: { queued: 1, running: 2, succeeded: 3, failed: 1 } });
  const startMs = 1_700_000_000_000;
  let t = startMs;
  const handler = makeHandler({
    runner,
    jobStore,
    healthProbe: async () => ({ present: true, version: "1.1.19" }),
    now: () => t,
  });
  t = startMs + 65_000;

  const res = makeRes();
  await handler(makeReq({ url: "/health" }), res);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.pid, process.pid);
  assert.equal(body.startedAt, new Date(startMs).toISOString());
  assert.equal(body.uptimeSeconds, 65);
  assert.deepEqual(body.agy, { path: "/root/.local/bin/agy", present: true, version: "1.1.19" });
  assert.deepEqual(body.jobs, { running: 2, queued: 1, stored: 7 });
  assert.equal(body.maxConcurrent, 3);
});

test("GET /health is degraded (503) when the probe says the binary is absent", async () => {
  const handler = makeHandler({ healthProbe: async () => ({ present: false, version: null }) });
  const res = makeRes();
  await handler(makeReq({ url: "/health" }), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().status, "degraded");
  assert.deepEqual(res.json().agy, { path: "/root/.local/bin/agy", present: false, version: null });
});

test("buildHealthPayload is exported and pure over its injected inputs", async () => {
  const { ok, body } = await buildHealthPayload({
    config: baseConfig(),
    runner: { stats: () => ({ running: 0, queued: 0 }) },
    jobStore: emptyJobStore(),
    healthProbe: async () => ({ present: true, version: "9.9.9" }),
    startedAtMs: 1_000,
    now: () => 11_000,
  });
  assert.equal(ok, true);
  assert.equal(body.uptimeSeconds, 10);
  assert.equal(body.agy.version, "9.9.9");
});

// --- Routing ---

test("GET /run gets 405, POST /health gets 405, GET method on POST-only jobs id is fine", async () => {
  const handler = makeHandler();
  let res = makeRes();
  await handler(authedReq({ method: "GET", url: "/run" }), res);
  assert.equal(res.statusCode, 405);

  res = makeRes();
  await handler(authedReq({ method: "POST", url: "/health" }), res);
  assert.equal(res.statusCode, 405);

  res = makeRes();
  await handler(authedReq({ method: "DELETE", url: "/jobs" }), res);
  assert.equal(res.statusCode, 405);
});

test("an unknown path gets 404", async () => {
  const handler = makeHandler();
  const res = makeRes();
  await handler(authedReq({ url: "/nope" }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().ok, false);
});
