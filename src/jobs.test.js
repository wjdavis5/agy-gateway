import test from "node:test";
import assert from "node:assert/strict";

import { createJobStore } from "./jobs.js";

// Tests drive a fake runner whose run() promise resolution the test
// controls (deferred pattern) and a fake clock -- no timers, no real agy.

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFakeRunner() {
  const calls = [];
  return {
    calls,
    run(request) {
      const d = deferred();
      calls.push({ request, resolve: d.resolve, reject: d.reject });
      return d.promise;
    },
  };
}

function createClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
  };
}

// Let the .then() continuation attached to the runner promise run.
function tick() {
  return new Promise((res) => setImmediate(res));
}

test("submit returns a job id synchronously and the job starts queued", () => {
  const runner = createFakeRunner();
  const clock = createClock(5_000);
  const store = createJobStore({ runner, ttlMs: 1_000, now: clock.now });

  const jobId = store.submit({ prompt: "hello" });
  assert.equal(typeof jobId, "string");
  assert.ok(jobId.length > 0);

  const job = store.get(jobId);
  assert.equal(job.jobId, jobId);
  assert.equal(job.state, "queued");
  assert.equal(job.createdAt, 5_000);
  assert.equal(job.startedAt, undefined);
  assert.equal(job.finishedAt, undefined);

  // The runner got the request plus an onStart callback.
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0].request.prompt, "hello");
  assert.equal(typeof runner.calls[0].request.onStart, "function");
});

test("onStart moves the job to running with startedAt", () => {
  const runner = createFakeRunner();
  const clock = createClock(1_000);
  const store = createJobStore({ runner, ttlMs: 1_000, now: clock.now });

  const jobId = store.submit({ prompt: "p" });
  clock.advance(50);
  runner.calls[0].request.onStart();

  const job = store.get(jobId);
  assert.equal(job.state, "running");
  assert.equal(job.startedAt, 1_050);
});

test("a resolved ok:true run moves the job to succeeded with the result", async () => {
  const runner = createFakeRunner();
  const clock = createClock(1_000);
  const store = createJobStore({ runner, ttlMs: 1_000, now: clock.now });

  const jobId = store.submit({ prompt: "p" });
  runner.calls[0].request.onStart();
  clock.advance(200);
  const result = { ok: true, agy: { status: "SUCCESS", response: "hi" }, durationMs: 200 };
  runner.calls[0].resolve(result);
  await tick();

  const job = store.get(jobId);
  assert.equal(job.state, "succeeded");
  assert.deepEqual(job.result, result);
  assert.equal(job.finishedAt, 1_200);
  assert.equal(job.error, undefined);
});

test("a resolved ok:false run moves the job to failed with the typed error", async () => {
  const runner = createFakeRunner();
  const clock = createClock(1_000);
  const store = createJobStore({ runner, ttlMs: 1_000, now: clock.now });

  const jobId = store.submit({ prompt: "p" });
  const failure = { ok: false, errorKind: "timeout", message: "too slow", durationMs: 100 };
  runner.calls[0].resolve(failure);
  await tick();

  const job = store.get(jobId);
  assert.equal(job.state, "failed");
  assert.deepEqual(job.error, failure);
  assert.equal(job.result, undefined);
  assert.equal(typeof job.finishedAt, "number");
});

test("get of an unknown id returns undefined", () => {
  const store = createJobStore({ runner: createFakeRunner(), ttlMs: 1_000 });
  assert.equal(store.get("no-such-job"), undefined);
});

test("a finished job past its TTL is lazily evicted on get", async () => {
  const runner = createFakeRunner();
  const clock = createClock(1_000);
  const store = createJobStore({ runner, ttlMs: 500, now: clock.now });

  const jobId = store.submit({ prompt: "p" });
  runner.calls[0].resolve({ ok: true, text: "done", durationMs: 1 });
  await tick();

  // Not yet expired: finishedAt=1000, ttl 500, now 1500 is the boundary.
  clock.advance(500);
  assert.ok(store.get(jobId), "job at exactly finishedAt+ttl is still retrievable");

  clock.advance(1);
  assert.equal(store.get(jobId), undefined, "expired job evicted on get");
  assert.equal(store.counts().stored, 0, "eviction removed it from the store");
});

test("an unfinished job is never evicted regardless of age", () => {
  const runner = createFakeRunner();
  const clock = createClock(1_000);
  const store = createJobStore({ runner, ttlMs: 10, now: clock.now });

  const jobId = store.submit({ prompt: "p" });
  clock.advance(1_000_000);
  assert.equal(store.get(jobId).state, "queued");
});

test("list returns recent jobs newest first without prompts or results", async () => {
  const runner = createFakeRunner();
  const clock = createClock(1_000);
  const store = createJobStore({ runner, ttlMs: 60_000, now: clock.now });

  const first = store.submit({ prompt: "secret prompt one" });
  clock.advance(10);
  const second = store.submit({ prompt: "secret prompt two" });
  runner.calls[0].resolve({ ok: true, text: "secret result", durationMs: 1 });
  await tick();

  const jobs = store.list();
  assert.deepEqual(
    jobs.map((j) => j.jobId),
    [second, first],
    "newest first"
  );
  for (const job of jobs) {
    assert.deepEqual(
      Object.keys(job).sort(),
      ["createdAt", "finishedAt", "jobId", "state"].filter(
        (k) => k !== "finishedAt" || job.finishedAt !== undefined
      ),
      "list entries carry only jobId/state/createdAt/finishedAt"
    );
    assert.ok(!JSON.stringify(job).includes("secret"), "no prompt or result content leaks");
  }
});

test("counts reports stored total and per-state tallies", async () => {
  const runner = createFakeRunner();
  const store = createJobStore({ runner, ttlMs: 60_000 });

  store.submit({ prompt: "a" }); // stays queued
  store.submit({ prompt: "b" });
  runner.calls[1].request.onStart(); // running
  store.submit({ prompt: "c" });
  runner.calls[2].resolve({ ok: true, text: "t", durationMs: 1 });
  store.submit({ prompt: "d" });
  runner.calls[3].resolve({ ok: false, errorKind: "exit", message: "m", durationMs: 1 });
  await tick();

  assert.deepEqual(store.counts(), {
    stored: 4,
    byState: { queued: 1, running: 1, succeeded: 1, failed: 1 },
  });
});

test("sweep evicts all expired finished jobs and returns the count", async () => {
  const runner = createFakeRunner();
  const clock = createClock(1_000);
  const store = createJobStore({ runner, ttlMs: 100, now: clock.now });

  store.submit({ prompt: "a" });
  store.submit({ prompt: "b" });
  const liveId = store.submit({ prompt: "c" }); // never finishes
  runner.calls[0].resolve({ ok: true, text: "t", durationMs: 1 });
  runner.calls[1].resolve({ ok: false, errorKind: "exit", message: "m", durationMs: 1 });
  await tick();

  clock.advance(101);
  assert.equal(store.sweep(), 2);
  assert.equal(store.counts().stored, 1);
  assert.equal(store.get(liveId).state, "queued");
  assert.equal(store.sweep(), 0, "second sweep finds nothing to evict");
});
