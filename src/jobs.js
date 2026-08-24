import crypto from "node:crypto";

// In-memory async-job store (KTD7): POST /jobs submits a runner request
// and returns immediately with an id; the caller polls GET /jobs/<id>.
// State machine: queued -> running (on the runner's onStart callback,
// i.e. real semaphore-slot acquisition -- not on enqueue) -> succeeded |
// failed. Finished jobs are kept for ttlMs then evicted -- lazily on
// get()/list(), and in bulk via sweep() (the entrypoint calls sweep on an
// unref'd interval; the store itself sets no timers so tests that inject
// a fake `now` stay fully deterministic).
//
// The store deliberately keeps NO copy of the request: prompts (and agy
// results, until their job is polled or expires) can carry sensitive
// content from any lab service, so list() exposes only ids/states/
// timestamps and the full result is only reachable by id.

/**
 * @param {{
 *   runner: {run(request: object): Promise<object>},
 *   ttlMs: number,
 *   now?: () => number,
 * }} options
 */
export function createJobStore({ runner, ttlMs, now = Date.now }) {
  /** @type {Map<string, {jobId: string, state: string, createdAt: number, startedAt?: number, finishedAt?: number, result?: object, error?: object}>} */
  const jobs = new Map();

  function isExpired(job, nowMs) {
    return (
      (job.state === "succeeded" || job.state === "failed") &&
      job.finishedAt !== undefined &&
      job.finishedAt + ttlMs < nowMs
    );
  }

  /** Public shape: a copy, so callers can't mutate the stored record. */
  function publicJob(job) {
    return { ...job };
  }

  /**
   * Fire-and-forget submit. Returns the job id synchronously; the run's
   * settlement mutates the stored record for later polling.
   * @param {object} request - runner request (prompt, effort?, ...)
   * @returns {string} job id
   */
  function submit(request) {
    const jobId = crypto.randomUUID();
    const job = { jobId, state: "queued", createdAt: now() };
    jobs.set(jobId, job);

    const onStart = () => {
      job.state = "running";
      job.startedAt = now();
    };

    runner.run({ ...request, onStart }).then(
      (result) => {
        job.finishedAt = now();
        if (result?.ok === true) {
          job.state = "succeeded";
          job.result = result;
        } else {
          job.state = "failed";
          job.error = result;
        }
      },
      (error) => {
        // The runner contract never rejects, but a job must never be
        // stranded in queued/running if that ever breaks.
        job.finishedAt = now();
        job.state = "failed";
        job.error = { ok: false, errorKind: "exit", message: `runner rejected: ${error?.message ?? String(error)}` };
      }
    );

    return jobId;
  }

  /**
   * @param {string} id
   * @returns {object|undefined} public job shape, or undefined for
   * unknown ids and lazily-evicted expired jobs.
   */
  function get(id) {
    const job = jobs.get(id);
    if (!job) return undefined;
    if (isExpired(job, now())) {
      jobs.delete(id);
      return undefined;
    }
    return publicJob(job);
  }

  /**
   * Recent jobs, newest first. Ids/states/timestamps only -- never
   * prompts or results (they can hold sensitive content).
   */
  function list() {
    const nowMs = now();
    const out = [];
    for (const [id, job] of jobs) {
      if (isExpired(job, nowMs)) {
        jobs.delete(id);
        continue;
      }
      const entry = { jobId: job.jobId, state: job.state, createdAt: job.createdAt };
      if (job.finishedAt !== undefined) entry.finishedAt = job.finishedAt;
      out.push(entry);
    }
    // Map preserves insertion order; createdAt is the tiebreak-free sort
    // key, so reversing insertion order is "newest first".
    return out.reverse();
  }

  function counts() {
    const byState = { queued: 0, running: 0, succeeded: 0, failed: 0 };
    for (const job of jobs.values()) {
      if (byState[job.state] !== undefined) byState[job.state] += 1;
    }
    return { stored: jobs.size, byState };
  }

  /**
   * Evicts every expired finished job.
   * @returns {number} how many were evicted.
   */
  function sweep() {
    const nowMs = now();
    let evicted = 0;
    for (const [id, job] of jobs) {
      if (isExpired(job, nowMs)) {
        jobs.delete(id);
        evicted += 1;
      }
    }
    return evicted;
  }

  return { submit, get, list, counts, sweep };
}
