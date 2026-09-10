import assert from "node:assert/strict";
import test from "node:test";

import { createListCache } from "../index.js";

/** A controllable async source that records how many scans actually ran. */
function source(value = [{ id: "a" }]) {
  const calls = [];
  let release;
  const load = (signal) => {
    calls.push(signal);
    return new Promise((resolve) => {
      release = () => resolve(value);
    });
  };
  return {
    load,
    calls,
    finish: () => release(),
    /** Let every pending microtask settle. */
    flush: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test("concurrent callers share one scan instead of one each", async () => {
  const src = source([{ id: "s1" }]);
  const cache = createListCache(src.load, { ttlMs: 1000 });

  const waiting = [
    cache.listSessions(undefined),
    cache.listSessions(undefined),
    cache.listSessions(undefined),
  ];
  await Promise.resolve();
  assert.equal(src.calls.length, 1, "one scan serves every concurrent caller");

  src.finish();
  const results = await Promise.all(waiting);
  assert.equal(cache.stats.scans, 1);
  assert.equal(cache.stats.joins, 2, "the first caller starts the scan; the other two join it");
  for (const result of results) assert.deepEqual(result, [{ id: "s1" }]);
});

test("a completed scan is reused inside the window and refreshed after it", async () => {
  let clock = 0;
  const src = source([{ id: "s1" }]);
  const cache = createListCache(src.load, { ttlMs: 1000, now: () => clock });

  const first = cache.listSessions(undefined);
  src.finish();
  await first;

  clock = 999;
  await cache.listSessions(undefined);
  assert.equal(cache.stats.scans, 1, "inside the window no new scan runs");
  assert.equal(cache.stats.hits, 1);

  clock = 1001;
  const third = cache.listSessions(undefined);
  await Promise.resolve();
  assert.equal(cache.stats.scans, 2, "past the window the scan runs again");
  src.finish();
  await third;
});

test("invalidate forces the next caller to rescan", async () => {
  const src = source();
  const cache = createListCache(src.load, { ttlMs: 60_000 });
  const first = cache.listSessions(undefined);
  src.finish();
  await first;

  cache.invalidate();
  const second = cache.listSessions(undefined);
  await Promise.resolve();
  assert.equal(cache.stats.scans, 2);
  src.finish();
  await second;
});

test("the shared scan runs without the caller's signal", async () => {
  const src = source();
  const cache = createListCache(src.load, { ttlMs: 1000 });
  const controller = new AbortController();

  const call = cache.listSessions(controller.signal);
  await Promise.resolve();
  assert.equal(src.calls.length, 1);
  assert.equal(src.calls[0], undefined, "a caller's abort must not cancel the shared scan");

  src.finish();
  await call;
});

test("one caller aborting does not fail the others sharing that scan", async () => {
  const src = source([{ id: "s1" }]);
  const cache = createListCache(src.load, { ttlMs: 1000 });
  const controller = new AbortController();

  const abandoned = cache.listSessions(controller.signal);
  const patient = cache.listSessions(undefined);
  await Promise.resolve();
  assert.equal(src.calls.length, 1);

  controller.abort();
  await assert.rejects(abandoned, (error) => error.name === "AbortError");

  src.finish();
  assert.deepEqual(await patient, [{ id: "s1" }], "the surviving caller still gets the shared result");
});

test("an already-aborted caller never starts a scan", async () => {
  const src = source();
  const cache = createListCache(src.load, { ttlMs: 1000 });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(cache.listSessions(controller.signal), (error) => error.name === "AbortError");
  assert.equal(src.calls.length, 0);
});

test("a failed scan is not cached and the next caller retries", async () => {
  let attempts = 0;
  const cache = createListCache(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("store unavailable");
    return [{ id: "s1" }];
  }, { ttlMs: 1000 });

  await assert.rejects(cache.listSessions(undefined), /store unavailable/);
  assert.deepEqual(await cache.listSessions(undefined), [{ id: "s1" }]);
  assert.equal(attempts, 2, "the failure was not cached");
});

test("callers receive their own array so the cached list cannot be mutated", async () => {
  const src = source([{ id: "s1" }]);
  const cache = createListCache(src.load, { ttlMs: 1000 });

  const first = cache.listSessions(undefined);
  src.finish();
  const received = await first;
  received.push({ id: "injected" });

  const second = await cache.listSessions(undefined);
  assert.deepEqual(second, [{ id: "s1" }], "the cached list is unaffected by caller mutation");
});

test("ttlMs 0 disables reuse", async () => {
  const src = source();
  const cache = createListCache(src.load, { ttlMs: 0 });
  const first = cache.listSessions(undefined);
  src.finish();
  await first;

  const second = cache.listSessions(undefined);
  await Promise.resolve();
  assert.equal(cache.stats.scans, 2);
  src.finish();
  await second;
});
