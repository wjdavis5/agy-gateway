import test from "node:test";
import assert from "node:assert/strict";

import { createRequestHandler, buildHealthPayload, startWebServer } from "./server.js";
import { createJobStore } from "./jobs.js";
import { deferred, tick } from "./testSupport.js";

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

test("a prompt over the CLI-argument cap gets 400 without calling the runner", async () => {
  const runner = okRunner();
  const handler = makeHandler({ runner, config: baseConfig({ agyMaxBodyBytes: 1_048_576 }) });
  const res = makeRes();
  await handler(
    authedReq({ method: "POST", url: "/run", body: JSON.stringify({ prompt: "x".repeat(100_001) }) }),
    res
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "prompt exceeds 100000 characters (agy receives it as a single CLI argument)");
  assert.equal(runner.calls.length, 0);
});

test("a jsonSchema over the CLI-argument cap gets 400 without calling the runner", async () => {
  const runner = okRunner();
  const handler = makeHandler({ runner, config: baseConfig({ agyMaxBodyBytes: 1_048_576 }) });
  const res = makeRes();
  await handler(
    authedReq({
      method: "POST",
      url: "/run",
      body: JSON.stringify({ prompt: "p", jsonSchema: "x".repeat(100_001) }),
    }),
    res
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "jsonSchema exceeds 100000 characters (agy receives it as a single CLI argument)");
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

test("an oversized body destroys the request only after the 413 has flushed", async () => {
  const handler = makeHandler({ config: baseConfig({ agyMaxBodyBytes: 10 }) });
  const res = makeRes();
  const listeners = {};
  res.once = (event, cb) => {
    listeners[event] = cb;
  };
  const req = authedReq({
    method: "POST",
    url: "/run",
    body: JSON.stringify({ prompt: "x".repeat(100) }),
  });
  await handler(req, res);
  assert.equal(res.statusCode, 413, "the 413 must be written");
  assert.equal(req.destroyed, false, "destroy must not run before the response flushes");
  assert.equal(typeof listeners.finish, "function", "a finish listener must be registered");
  listeners.finish();
  assert.equal(req.destroyed, true, "the finish callback must destroy the request");
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
  await tick();
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
  await tick();

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

test("a job id with malformed percent-encoding gets 404, not a 500", async () => {
  const handler = makeHandler();
  const res = makeRes();
  await handler(authedReq({ url: "/jobs/%zz" }), res);
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

  res = makeRes();
  await handler(authedReq({ method: "POST", url: "/jobs/some-id" }), res);
  assert.equal(res.statusCode, 405);
});

test("an unknown path gets 404", async () => {
  const handler = makeHandler();
  const res = makeRes();
  await handler(authedReq({ url: "/nope" }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().ok, false);
});

// --- startWebServer ---

function makeFakeHttp() {
  const server = {
    onceListeners: {},
    onListeners: {},
    listenPort: null,
    once(event, cb) {
      server.onceListeners[event] = cb;
    },
    on(event, cb) {
      server.onListeners[event] = cb;
    },
    listen(port, cb) {
      server.listenPort = port;
      cb();
    },
  };
  const httpImpl = {
    connectionHandler: null,
    createServer(handler) {
      httpImpl.connectionHandler = handler;
      return server;
    },
  };
  return { httpImpl, server };
}

test("startWebServer resolves with the server once listening", async () => {
  const { httpImpl, server } = makeFakeHttp();
  const started = await startWebServer({ port: 8100, requestHandler: async () => {}, httpImpl });
  assert.equal(started, server);
  assert.equal(server.listenPort, 8100);
});

test("a post-listen server error is logged, not thrown or swallowed", async () => {
  const { httpImpl, server } = makeFakeHttp();
  const logged = [];
  await startWebServer({
    port: 8100,
    requestHandler: async () => {},
    httpImpl,
    logImpl: (...args) => logged.push(args),
  });
  const persistent = server.onListeners.error;
  assert.equal(typeof persistent, "function", "a persistent error listener must be registered");
  persistent(new Error("EADDRINUSE later"));
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0], ["agy-gateway http server error:", "EADDRINUSE later"]);
});

test("a rejecting requestHandler gets a 500 from the wrapper", async () => {
  const { httpImpl } = makeFakeHttp();
  await startWebServer({ port: 8100, requestHandler: () => Promise.reject(new Error("boom")), httpImpl });

  const res = { headersSent: false, statusCode: null, body: null };
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.end = (body) => {
    res.body = body;
  };
  httpImpl.connectionHandler({}, res);
  await tick();
  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: "internal error" });
});

test("the 500 wrapper does not rewrite headers already sent", async () => {
  const { httpImpl } = makeFakeHttp();
  await startWebServer({ port: 8100, requestHandler: () => Promise.reject(new Error("boom")), httpImpl });

  let wroteHead = false;
  let ended = false;
  const res = {
    headersSent: true,
    writeHead: () => {
      wroteHead = true;
    },
    end: () => {
      ended = true;
    },
  };
  httpImpl.connectionHandler({}, res);
  await tick();
  assert.equal(wroteHead, false, "writeHead must not run after headers were sent");
  assert.equal(ended, true, "the response must still be ended");
});
