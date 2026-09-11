import assert from "node:assert/strict";
import test from "node:test";
import { installRecoveryApiGate } from "../lib/recovery-gate.js";

/** Minimal cordis-shaped context: the gate only needs a disposal effect and a logger. */
function createContext() {
  const disposals = [];
  return {
    disposals,
    logger: { warn() {} },
    effect(callback) { disposals.push(callback()); },
  };
}

function createServices(overrides = {}) {
  return {
    goals: {
      create() { throw new Error("goal already exists"); },
      edit() { throw new Error("goal already exists"); },
      pause() {},
      resume() {},
      complete() {},
      clear() {},
      ...overrides,
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

test("keeps a synchronous service throw synchronous once recovery has settled", async () => {
  const ctx = createContext();
  const services = createServices();
  const recovery = deferred();
  installRecoveryApiGate(ctx, services, recovery.promise, { gatedCalls: [] });

  recovery.resolve();
  await recovery.promise;
  await Promise.resolve();

  // The goal tools and slash commands call goals.create synchronously and catch
  // GoalError with a synchronous try/catch; a promise would slip past them.
  assert.throws(() => services.goals.create(), /goal already exists/u);
});

test("defers calls while recovery is pending and records them", async () => {
  const ctx = createContext();
  const services = createServices({ create: () => "created" });
  const recovery = deferred();
  const diag = { gatedCalls: [] };
  installRecoveryApiGate(ctx, services, recovery.promise, diag);

  const pending = services.goals.create();
  assert.equal(typeof pending.then, "function");
  assert.deepEqual(diag.gatedCalls, ["goals.create"]);

  recovery.resolve();
  assert.equal(await pending, "created");
  // Only the pre-settlement call is a deferred call; the gate is done after that.
  assert.deepEqual(diag.gatedCalls, ["goals.create"]);
});

test("never leaves a deferred rejection unhandled", async () => {
  const ctx = createContext();
  const services = createServices();
  const recovery = deferred();
  installRecoveryApiGate(ctx, services, recovery.promise, { gatedCalls: [] });

  const rejections = [];
  const onRejection = (error) => rejections.push(error);
  process.on("unhandledRejection", onRejection);
  try {
    // A caller written against the synchronous contract cannot observe this
    // rejection. Written the old way it escaped and the Harness exited the whole
    // daemon — stopping every session — so it must stay handled.
    const returned = services.goals.create();
    recovery.resolve();
    await assert.rejects(returned, /goal already exists/u);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  assert.deepEqual(rejections, []);
});

test("restores every gated method on disposal", () => {
  const ctx = createContext();
  const services = createServices({ create: () => "created" });
  const originalCreate = services.goals.create;
  installRecoveryApiGate(ctx, services, Promise.resolve(), { gatedCalls: [] });
  assert.notEqual(services.goals.create, originalCreate);
  for (const dispose of ctx.disposals) dispose();
  assert.equal(services.goals.create, originalCreate);
});
