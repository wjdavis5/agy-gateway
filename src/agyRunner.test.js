import test from "node:test";
import assert from "node:assert/strict";

import { createAgyRunner } from "./agyRunner.js";

// All tests inject a fake execFileImpl (promise-signature, matching the
// promisified node:child_process execFile the real code defaults to) --
// never a real agy binary, per the mock-the-boundary convention mirrored
// from the plex repo (src/organize/agyClassifier.test.js).

function agyStdout(structuredOutput, status = "SUCCESS") {
  return {
    stdout: JSON.stringify({
      conversation_id: "test",
      status,
      response: "response text",
      structured_output: structuredOutput,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    stderr: "",
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

// 1. Success json
test("json success: resolves ok:true with the parsed agy body and the verified argv shape", async () => {
  const calls = [];
  const runner = createAgyRunner({
    agyPath: "/usr/local/bin/agy",
    execFileImpl: async (file, args, options) => {
      calls.push({ file, args, options });
      return agyStdout({ answer: 42 });
    },
  });

  const result = await runner.run({ prompt: "what is the answer" });
  assert.equal(result.ok, true);
  assert.equal(result.agy.status, "SUCCESS");
  assert.deepEqual(result.agy.structured_output, { answer: 42 });
  assert.equal(typeof result.durationMs, "number");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/usr/local/bin/agy");
  const { args } = calls[0];
  // -p <prompt> first, prompt as a single argv element.
  assert.equal(args[0], "-p");
  assert.equal(args[1], "what is the answer");
  const fmtIdx = args.indexOf("--output-format");
  assert.ok(fmtIdx > 1);
  assert.equal(args[fmtIdx + 1], "json");
  // --print-timeout must always be passed explicitly (agy self-terminates
  // at its internal 5m default otherwise). Default budget 300000ms -> 300s.
  const ptIdx = args.indexOf("--print-timeout");
  assert.ok(ptIdx > -1);
  assert.equal(args[ptIdx + 1], "300s");
  // KTD6: never skip permissions.
  assert.ok(!args.includes("--dangerously-skip-permissions"));
});

// 2. jsonSchema
test("jsonSchema is passed inline as a single --json-schema argument", async () => {
  const schema = JSON.stringify({ type: "object", properties: { a: { type: "number" } } });
  const calls = [];
  const runner = createAgyRunner({
    agyPath: "agy",
    execFileImpl: async (file, args) => {
      calls.push(args);
      return agyStdout({ a: 1 });
    },
  });

  await runner.run({ prompt: "p", jsonSchema: schema });
  const args = calls[0];
  const idx = args.indexOf("--json-schema");
  assert.ok(idx > -1);
  assert.equal(args[idx + 1], schema);
  // Order: --output-format before --json-schema before --effort.
  assert.ok(args.indexOf("--output-format") < idx);
  assert.ok(idx < args.indexOf("--effort"));
});

// 3. sandbox
test("sandbox:true appends --sandbox; default omits it", async () => {
  const calls = [];
  const execFileImpl = async (file, args) => {
    calls.push(args);
    return agyStdout({});
  };

  await createAgyRunner({ agyPath: "agy", sandbox: true, execFileImpl }).run({ prompt: "p" });
  assert.ok(calls[0].includes("--sandbox"));

  await createAgyRunner({ agyPath: "agy", execFileImpl }).run({ prompt: "p" });
  assert.ok(!calls[1].includes("--sandbox"));
});

// 4. Timeout during execution
test("an execFile timeout kill resolves errorKind timeout and names the ms", async () => {
  const runner = createAgyRunner({
    agyPath: "agy",
    defaultTimeoutMs: 12345,
    execFileImpl: async () => {
      const error = new Error("spawned process timed out");
      error.killed = true;
      throw error;
    },
  });

  const result = await runner.run({ prompt: "slow" });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "timeout");
  assert.match(result.message, /12345/);
});

// 5. Missing binary
test("a missing binary (ENOENT) resolves errorKind not-found", async () => {
  const runner = createAgyRunner({
    agyPath: "/nonexistent/agy",
    execFileImpl: async () => {
      const error = new Error("spawn /nonexistent/agy ENOENT");
      error.code = "ENOENT";
      throw error;
    },
  });

  const result = await runner.run({ prompt: "p" });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "not-found");
});

// 6. Non-zero exit with stderr
test("a non-zero exit resolves errorKind exit with a stderr tail", async () => {
  const runner = createAgyRunner({
    agyPath: "agy",
    execFileImpl: async () => {
      const error = new Error("Command failed: agy -p ...");
      error.code = 1;
      error.stderr = "x".repeat(3000) + "FATAL: something broke";
      throw error;
    },
  });

  const result = await runner.run({ prompt: "p" });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "exit");
  assert.ok(result.stderrTail.endsWith("FATAL: something broke"));
  // Tail, not the whole thing: capped at ~2000 chars.
  assert.ok(result.stderrTail.length <= 2000);
});

// 7. Bad stdout
test("non-JSON stdout in json mode resolves errorKind bad-output", async () => {
  const runner = createAgyRunner({
    agyPath: "agy",
    execFileImpl: async () => ({ stdout: "not json at all", stderr: "some warning" }),
  });

  const result = await runner.run({ prompt: "p" });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "bad-output");
  // stderr was non-empty, so the tail rides along on this failure too.
  assert.equal(result.stderrTail, "some warning");
});

// 8. status FAILED
test("a parsed body with status !== SUCCESS resolves errorKind agy-status naming the status", async () => {
  const runner = createAgyRunner({
    agyPath: "agy",
    execFileImpl: async () => agyStdout({}, "FAILED"),
  });

  const result = await runner.run({ prompt: "p" });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "agy-status");
  assert.match(result.message, /FAILED/);
});

// 9. Text mode
test("text mode returns stdout verbatim with no JSON parsing or status check", async () => {
  const calls = [];
  const runner = createAgyRunner({
    agyPath: "agy",
    execFileImpl: async (file, args) => {
      calls.push(args);
      return { stdout: "plain prose, definitely { not json", stderr: "" };
    },
  });

  const result = await runner.run({ prompt: "p", outputFormat: "text" });
  assert.equal(result.ok, true);
  assert.equal(result.text, "plain prose, definitely { not json");
  const fmtIdx = calls[0].indexOf("--output-format");
  assert.equal(calls[0][fmtIdx + 1], "text");
});

// 10. Concurrency
test("at most maxConcurrent execFile calls run at once; stats() reflects running and queued", async () => {
  const gates = [deferred(), deferred(), deferred()];
  let started = 0;
  const runner = createAgyRunner({
    agyPath: "agy",
    maxConcurrent: 2,
    execFileImpl: (file, args) => {
      const gate = gates[started];
      started += 1;
      return gate.promise;
    },
  });

  const p1 = runner.run({ prompt: "one" });
  const p2 = runner.run({ prompt: "two" });
  const p3 = runner.run({ prompt: "three" });
  // Let the async run() bodies reach the semaphore.
  await sleep(0);

  assert.equal(started, 2, "third execFile call must not start while both slots are held");
  assert.deepEqual(runner.stats(), { running: 2, queued: 1 });

  gates[0].resolve(agyStdout({}));
  await p1;
  await sleep(0);
  assert.equal(started, 3, "third run starts once a slot frees");
  assert.deepEqual(runner.stats(), { running: 2, queued: 0 });

  gates[1].resolve(agyStdout({}));
  gates[2].resolve(agyStdout({}));
  await Promise.all([p2, p3]);
  assert.deepEqual(runner.stats(), { running: 0, queued: 0 });
});

// 11. Slot release on failure
test("a rejecting run releases its slot so a queued run still starts", async () => {
  const first = deferred();
  let secondStarted = false;
  const runner = createAgyRunner({
    agyPath: "agy",
    maxConcurrent: 1,
    execFileImpl: (file, args) => {
      if (args[1] === "first") return first.promise;
      secondStarted = true;
      return Promise.resolve(agyStdout({}));
    },
  });

  const p1 = runner.run({ prompt: "first" });
  const p2 = runner.run({ prompt: "second" });
  await sleep(0);
  assert.equal(secondStarted, false);

  const error = new Error("boom");
  error.code = 1;
  first.reject(error);

  const r1 = await p1;
  assert.equal(r1.ok, false);
  assert.equal(r1.errorKind, "exit");

  const r2 = await p2;
  assert.equal(r2.ok, true);
  assert.equal(secondStarted, true);
});

// 12. Queued-timeout
test("a budget that expires while queued resolves timeout without ever calling execFileImpl", async () => {
  const first = deferred();
  const invokedPrompts = [];
  const runner = createAgyRunner({
    agyPath: "agy",
    maxConcurrent: 1,
    execFileImpl: (file, args) => {
      invokedPrompts.push(args[1]);
      if (args[1] === "first") return first.promise;
      return Promise.resolve(agyStdout({}));
    },
  });

  const p1 = runner.run({ prompt: "first" });
  const p2 = runner.run({ prompt: "second", timeoutMs: 15 });
  await sleep(0);
  assert.deepEqual(runner.stats(), { running: 1, queued: 1 });

  const r2 = await p2; // must resolve on its own while the slot is still held
  assert.equal(r2.ok, false);
  assert.equal(r2.errorKind, "timeout");
  assert.deepEqual(invokedPrompts, ["first"], "queued-timeout run must never reach execFileImpl");
  assert.deepEqual(runner.stats(), { running: 1, queued: 0 }, "expired run left the queue");

  // The dead entry must not clog the queue: a third run still starts.
  first.resolve(agyStdout({}));
  await p1;
  const r3 = await runner.run({ prompt: "third" });
  assert.equal(r3.ok, true);
  assert.deepEqual(invokedPrompts, ["first", "third"]);
});

// 13. Clamp to maxTimeoutMs
test("timeoutMs above maxTimeoutMs is clamped (visible in --print-timeout and the execFile timeout)", async () => {
  const calls = [];
  const runner = createAgyRunner({
    agyPath: "agy",
    maxTimeoutMs: 60_000,
    execFileImpl: async (file, args, options) => {
      calls.push({ args, options });
      return agyStdout({});
    },
  });

  await runner.run({ prompt: "p", timeoutMs: 9_999_999 });
  const { args, options } = calls[0];
  const ptIdx = args.indexOf("--print-timeout");
  assert.equal(args[ptIdx + 1], "60s");
  assert.ok(options.timeout <= 60_000);
});

// 14. bad-request
test("an empty prompt resolves bad-request without calling execFileImpl or consuming a slot", async () => {
  let called = false;
  const runner = createAgyRunner({
    agyPath: "agy",
    execFileImpl: async () => {
      called = true;
      return agyStdout({});
    },
  });

  for (const bad of [{ prompt: "" }, { prompt: "   " }, {}, { prompt: 42 }]) {
    const result = await runner.run(bad);
    assert.equal(result.ok, false);
    assert.equal(result.errorKind, "bad-request");
    assert.equal(typeof result.message, "string");
  }
  assert.equal(called, false);
  assert.deepEqual(runner.stats(), { running: 0, queued: 0 });
});

test("an invalid outputFormat resolves bad-request without calling execFileImpl", async () => {
  let called = false;
  const runner = createAgyRunner({
    agyPath: "agy",
    execFileImpl: async () => {
      called = true;
      return agyStdout({});
    },
  });

  const result = await runner.run({ prompt: "p", outputFormat: "yaml" });
  assert.equal(result.ok, false);
  assert.equal(result.errorKind, "bad-request");
  assert.equal(called, false);
});
