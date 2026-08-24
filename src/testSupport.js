// Shared test-only helpers. The filename deliberately does not match the
// *.test.js glob, so node --test never runs this file directly.

/** A promise with its resolve/reject handles exposed. */
export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets pending .then() continuations (e.g. on a just-settled promise) run. */
export function tick() {
  return new Promise((res) => setImmediate(res));
}
