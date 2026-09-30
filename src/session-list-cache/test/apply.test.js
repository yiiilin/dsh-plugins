import assert from "node:assert/strict";
import test from "node:test";

import { apply, inject, name } from "../index.js";

/** The mount contract the bundle patch row depends on. */
test("exports the name and injection the patch row declares", () => {
  assert.equal(name, "session-list-cache");
  assert.deepEqual(inject, ["sessionQuery"]);
});

/** A minimal Cordis-shaped context that records listeners and disposers. */
function fakeCtx(service) {
  const listeners = new Map();
  const disposers = [];
  const logs = [];
  return {
    ctx: {
      sessionQuery: service,
      logger: {
        info: (message) => logs.push(["info", message]),
        warn: (message) => logs.push(["warn", message]),
      },
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
        return () => {};
      },
      effect(callback) {
        disposers.push(callback());
        return () => {};
      },
    },
    listeners,
    disposers,
    logs,
    /** Fire every listener registered for one event. */
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
    /** Run every registered effect disposer, as plugin unload would. */
    unload() {
      for (const dispose of disposers) dispose();
    },
  };
}

/** A stand-in sessionQuery service counting how many scans its body ran. */
function service(value = [{ header: { id: "s1" } }]) {
  const state = { scans: 0 };
  return {
    state,
    listSessions(signal) {
      state.scans += 1;
      return Promise.resolve(value);
    },
  };
}

test("apply coalesces concurrent listSessions calls into one scan", async () => {
  const svc = service();
  const fake = fakeCtx(svc);
  apply(fake.ctx, { ttlMs: 1000 });

  const results = await Promise.all([
    svc.listSessions(),
    svc.listSessions(),
    svc.listSessions(),
  ]);

  assert.equal(svc.state.scans, 1, "three concurrent callers share one scan");
  for (const result of results) assert.deepEqual(result, [{ header: { id: "s1" } }]);
  assert.equal(fake.logs[0][0], "info");
});

test("apply reuses one scan across the window, then rescans", async () => {
  const svc = service();
  const fake = fakeCtx(svc);
  apply(fake.ctx, { ttlMs: 60_000 });

  await svc.listSessions();
  await svc.listSessions();
  assert.equal(svc.state.scans, 1);
});

test("a created session invalidates the cached scan", async () => {
  const svc = service();
  const fake = fakeCtx(svc);
  apply(fake.ctx, { ttlMs: 60_000 });

  await svc.listSessions();
  assert.equal(svc.state.scans, 1);

  fake.emit("session/created", { id: "new" });
  await svc.listSessions();
  assert.equal(svc.state.scans, 2, "a new session is visible immediately, not after the window");
});

test("a disposed session invalidates the cached scan", async () => {
  const svc = service();
  const fake = fakeCtx(svc);
  apply(fake.ctx, { ttlMs: 60_000 });

  await svc.listSessions();
  fake.emit("session/disposed", { id: "gone" });
  await svc.listSessions();
  assert.equal(svc.state.scans, 2);
});

test("unloading restores the original service method", () => {
  const svc = service();
  const original = svc.listSessions;
  const fake = fakeCtx(svc);
  apply(fake.ctx, { ttlMs: 1000 });

  assert.notEqual(svc.listSessions, original, "the method is wrapped while mounted");
  fake.unload();
  assert.equal(svc.listSessions, original, "the original method is restored on unload");
});

test("a service without listSessions leaves the plugin inert and warns", () => {
  const svc = {};
  const fake = fakeCtx(svc);
  apply(fake.ctx, { ttlMs: 1000 });

  assert.equal(fake.logs.length, 1);
  assert.equal(fake.logs[0][0], "warn");
  assert.equal(svc.listSessions, undefined, "nothing is installed");
});

test("ttlMs 0 disables the plugin and warns", async () => {
  const svc = service();
  const original = svc.listSessions;
  const fake = fakeCtx(svc);
  apply(fake.ctx, { ttlMs: 0 });

  assert.equal(svc.listSessions, original, "the service is untouched");
  assert.equal(fake.logs[0][0], "info");
  await svc.listSessions();
});

test("a missing config still mounts with the default window", async () => {
  const svc = service();
  const original = svc.listSessions;
  const fake = fakeCtx(svc);
  apply(fake.ctx, undefined);

  assert.notEqual(svc.listSessions, original);
  await svc.listSessions();
  assert.equal(svc.state.scans, 1);
});
