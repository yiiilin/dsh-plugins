import assert from "node:assert/strict";
import test from "node:test";

import { apply, inject, name, syncAgent } from "../index.js";

/** The mount contract the bundle patch row depends on. */
test("exports the name and injection the patch row declares", () => {
  assert.equal(name, "tool-restrict-presets");
  assert.deepEqual(inject, ["tools", "agents", "agentPresets"]);
});

/** A Cordis-shaped context recording listeners, effects and logs. */
function fakeCtx({ presets = new Map(), agents = [], restrict, composedPreset } = {}) {
  const listeners = new Map();
  const disposers = [];
  const logs = [];
  const calls = { restrict: 0, lifted: 0 };
  const ctx = {
    agentPresets: {
      composedPreset: composedPreset ?? ((agentCtx) => presets.get(agentCtx.id)),
    },
    agents: { list: () => agents },
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
  };
  return {
    ctx,
    calls,
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

/** A live-Agent stand-in whose own layer accepts exactly one restriction. */
function fakeAgent(id, ctxId, { restrictable = true, served = ["read", "grep", "remember", "hindsight_reflect"] } = {}) {
  const servedTools = served;
  const state = { restrictions: 0, lifted: 0, allow: undefined, deny: undefined };
  return {
    session: { id },
    ctx: { id: ctxId, tools: undefined },
    state,
    install() {
      this.ctx.tools = {
        // The registry answers `schemas(agent)` with what the Agent actually
        // inherits; a deny list is filtered through it before `restrict()`.
        schemas: () => servedTools.map((name) => ({ name })),
        restrict: (filter) => {
          if (!restrictable) throw new Error("tools.restrict() requires a scoped context (agent.ctx)");
          state.restrictions += 1;
          state.allow = filter.allow;
          state.deny = filter.deny;
          return () => {
            state.lifted += 1;
          };
        },
      };
    },
  };
}

test("a listed preset gets an empty allow-list, one restriction per session", () => {
  const agent = fakeAgent("s1", "scope-s1");
  agent.install();
  const presets = new Map([["scope-s1", "mentor"]]);
  const fake = fakeCtx({ presets });
  const track = new Map();

  apply(fake.ctx, { presets: ["mentor"] });
  fake.emit("agent/created", { agent });
  fake.emit("agent/created", { agent });

  assert.equal(agent.state.restrictions, 1, "the same session is not restricted twice");
  assert.deepEqual(agent.state.allow, [], "nothing inherited survives");
});

test("an unlisted preset keeps its tools", () => {
  const agent = fakeAgent("s2", "scope-s2");
  agent.install();
  const presets = new Map([["scope-s2", "implement"]]);
  const fake = fakeCtx({ presets });

  apply(fake.ctx, { presets: ["mentor"] });
  fake.emit("agent/created", { agent });

  assert.equal(agent.state.restrictions, 0);
});

test("leaving the preset lifts the restriction", () => {
  const agent = fakeAgent("s3", "scope-s3");
  agent.install();
  const presets = new Map([["scope-s3", "mentor"]]);
  const fake = fakeCtx({ presets, agents: [agent] });

  apply(fake.ctx, { presets: ["mentor"] });
  fake.emit("agent/created", { agent });
  assert.equal(agent.state.restrictions, 1);

  // A blank Session switched preset: it must get its tools back.
  presets.set("scope-s3", "implement");
  fake.emit("tools/change");

  assert.equal(agent.state.lifted, 1);
});

test("a disposed Agent releases its restriction exactly once", () => {
  const agent = fakeAgent("s4", "scope-s4");
  agent.install();
  const presets = new Map([["scope-s4", "mentor"]]);
  const fake = fakeCtx({ presets });

  apply(fake.ctx, { presets: ["mentor"] });
  fake.emit("agent/created", { agent });
  fake.emit("agent/disposed", { agent });
  fake.emit("agent/disposed", { agent });

  assert.equal(agent.state.lifted, 1, "a repeated disposal does not double-release");
});

test("agents that already existed are restricted on mount", () => {
  const agent = fakeAgent("s5", "scope-s5");
  agent.install();
  const presets = new Map([["scope-s5", "mentor"]]);
  const fake = fakeCtx({ presets, agents: [agent] });

  apply(fake.ctx, { presets: ["mentor"] });

  assert.equal(agent.state.restrictions, 1);
});

test("unloading lifts every restriction it installed", () => {
  const a = fakeAgent("s6", "scope-s6");
  const b = fakeAgent("s7", "scope-s7");
  a.install();
  b.install();
  const presets = new Map([["scope-s6", "mentor"], ["scope-s7", "mentor"]]);
  const fake = fakeCtx({ presets, agents: [a, b] });

  apply(fake.ctx, { presets: ["mentor"] });
  assert.equal(a.state.restrictions, 1);
  assert.equal(b.state.restrictions, 1);

  fake.unload();
  assert.equal(a.state.lifted, 1);
  assert.equal(b.state.lifted, 1);
});

test("an unscoped Agent is reported and its tools stay available", () => {
  const agent = fakeAgent("s8", "scope-s8", { restrictable: false });
  agent.install();
  const presets = new Map([["scope-s8", "mentor"]]);
  const fake = fakeCtx({ presets });

  apply(fake.ctx, { presets: ["mentor"] });
  fake.emit("agent/created", { agent });

  assert.equal(fake.logs.length, 1);
  assert.equal(fake.logs[0][0], "warn");
  assert.match(String(fake.logs[0][1]), /cannot be restricted/);
});

test("an unbound Agent is skipped without a log", () => {
  const agent = fakeAgent("s9", "scope-s9");
  agent.install();
  const presets = new Map();
  const fake = fakeCtx({ presets });

  apply(fake.ctx, { presets: ["mentor"] });
  fake.emit("agent/created", { agent });

  assert.equal(agent.state.restrictions, 0);
  assert.deepEqual(fake.logs, [], "an unbound Agent is not an error");
});

test("an empty preset list mounts inert", () => {
  const agent = fakeAgent("s10", "scope-s10");
  agent.install();
  const presets = new Map([["scope-s10", "mentor"]]);
  const fake = fakeCtx({ presets, agents: [agent] });

  apply(fake.ctx, { presets: [] });
  apply(fake.ctx, {});
  apply(fake.ctx, undefined);

  assert.equal(agent.state.restrictions, 0, "no preset is named, so nothing is restricted");
  assert.deepEqual(fake.logs, []);
});

test("verbose logs one line per restricted Agent, and only then", () => {
  const agent = fakeAgent("s11", "scope-s11");
  agent.install();
  const presets = new Map([["scope-s11", "mentor"]]);

  const quiet = fakeCtx({ presets });
  apply(quiet.ctx, { presets: ["mentor"] });
  quiet.emit("agent/created", { agent });
  assert.deepEqual(quiet.logs, [], "silent by default");

  const loud = fakeCtx({ presets });
  apply(loud.ctx, { presets: ["mentor"], verbose: true });
  loud.emit("agent/created", { agent });

  assert.equal(loud.logs.length, 1);
  assert.equal(loud.logs[0][0], "info");
  assert.match(String(loud.logs[0][1]), /now inherits no tools/);
});

test("syncAgent tolerates a preset lookup that throws", () => {
  const agent = fakeAgent("s12", "scope-s12");
  agent.install();
  const fake = fakeCtx({ composedPreset: () => { throw new Error("disposed"); } });
  const track = new Map();

  assert.doesNotThrow(() => syncAgent(fake.ctx, agent, ["mentor"], track, () => {}));
  assert.equal(agent.state.restrictions, 0);
});

test("a non-string or empty preset entry is ignored", () => {
  const agent = fakeAgent("s13", "scope-s13");
  agent.install();
  const presets = new Map([["scope-s13", "mentor"]]);
  const fake = fakeCtx({ presets, agents: [agent] });

  apply(fake.ctx, { presets: ["", null, 7, "mentor", "mentor"] });

  assert.equal(agent.state.restrictions, 1, "only the one real id is enforced, once");
});

// ── per-preset denials ──────────────────────────────────────────────────────
//
// The review preset keeps a normal toolset and drops one family. These cases
// pin the difference from `presets`, which empties the whole surface.

test("a deny-only preset keeps its tools and loses exactly the named ones", () => {
  const agent = fakeAgent("d1", "scope-d1");
  agent.install();
  const presets = new Map([["scope-d1", "arbitrary"]]);
  const fake = fakeCtx({ presets });

  apply(fake.ctx, { deny: { arbitrary: ["remember", "hindsight_reflect"] } });
  fake.emit("agent/created", { agent });

  assert.equal(agent.state.restrictions, 1);
  assert.equal(agent.state.allow, undefined, "the surface is not emptied");
  assert.deepEqual(agent.state.deny, ["remember", "hindsight_reflect"]);
});

test("a name the profile does not serve is not passed to restrict()", () => {
  const agent = fakeAgent("d2", "scope-d2", { served: ["read", "remember"] });
  agent.install();
  const presets = new Map([["scope-d2", "arbitrary"]]);
  const fake = fakeCtx({ presets });

  // `work_journal` is named but this profile mounts nothing of the sort;
  // restrict() would throw on an unknown name.
  apply(fake.ctx, { deny: { arbitrary: ["remember", "work_journal"] } });
  fake.emit("agent/created", { agent });

  assert.deepEqual(agent.state.deny, ["remember"]);
});

test("a deny list that matches nothing installs no restriction", () => {
  const agent = fakeAgent("d3", "scope-d3", { served: ["read", "grep"] });
  agent.install();
  const presets = new Map([["scope-d3", "arbitrary"]]);
  const fake = fakeCtx({ presets });

  apply(fake.ctx, { deny: { arbitrary: ["remember"] } });
  fake.emit("agent/created", { agent });

  assert.equal(agent.state.restrictions, 0, "nothing to deny means no layer at all");
});

test("an unlisted preset is untouched by another preset's deny list", () => {
  const agent = fakeAgent("d4", "scope-d4");
  agent.install();
  const presets = new Map([["scope-d4", "yiln"]]);
  const fake = fakeCtx({ presets });

  apply(fake.ctx, { deny: { arbitrary: ["remember"] } });
  fake.emit("agent/created", { agent });

  assert.equal(agent.state.restrictions, 0, "main sessions keep their memory");
});

test("leaving a deny-only preset lifts the restriction", () => {
  const agent = fakeAgent("d5", "scope-d5");
  agent.install();
  const presets = new Map([["scope-d5", "arbitrary"]]);
  const fake = fakeCtx({ presets, agents: [agent] });

  apply(fake.ctx, { deny: { arbitrary: ["remember"] } });
  fake.emit("agent/created", { agent });
  assert.equal(agent.state.restrictions, 1);

  presets.set("scope-d5", "yiln");
  fake.emit("tools/change");

  assert.equal(agent.state.lifted, 1);
});

test("the empty-surface policy wins when a preset appears in both lists", () => {
  const agent = fakeAgent("d6", "scope-d6");
  agent.install();
  const presets = new Map([["scope-d6", "mentor"]]);
  const fake = fakeCtx({ presets });

  apply(fake.ctx, { presets: ["mentor"], deny: { mentor: ["remember"] } });
  fake.emit("agent/created", { agent });

  assert.deepEqual(agent.state.allow, [], "no tools is stronger than some denied");
  assert.equal(agent.state.deny, undefined);
});

test("verbose reports the denied names", () => {
  const agent = fakeAgent("d7", "scope-d7");
  agent.install();
  const presets = new Map([["scope-d7", "arbitrary"]]);
  const fake = fakeCtx({ presets });

  // `recall` is not served here, so the log names only what was actually denied.
  apply(fake.ctx, { deny: { arbitrary: ["remember", "recall"] }, verbose: true });
  fake.emit("agent/created", { agent });

  assert.equal(fake.logs.length, 1);
  assert.match(String(fake.logs[0][1]), /denies remember$/);
});

test("deny entries that are not string arrays are ignored", () => {
  const agent = fakeAgent("d8", "scope-d8");
  agent.install();
  const presets = new Map([["scope-d8", "arbitrary"]]);
  const fake = fakeCtx({ presets });

  apply(fake.ctx, { deny: { arbitrary: "remember", other: [null, 7], "": ["read"] } });
  fake.emit("agent/created", { agent });

  assert.equal(agent.state.restrictions, 0, "a malformed entry is not a policy");
});
