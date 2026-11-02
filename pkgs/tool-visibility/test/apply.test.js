import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "@deepseek-ai/cordis";
import { createScope, scopeOf } from "@deepseek-ai/dsh-scope";

import { apply, compileRules, hiddenFor, inject, name } from "../index.js";

/** The mount contract the bundle patch row depends on. */
test("exports the name and injection the patch row declares", () => {
  assert.equal(name, "tool-visibility");
  assert.deepEqual(inject, ["tools", "agents", "agentPresets", "systemPrompt"]);
});

/**
 * A Cordis-shaped context recording listeners, effects and prompt providers.
 *
 * The provider list mirrors the runtime: the catalog a test reads is the one the
 * last registered provider returned.
 */
function fakeCtx({ presets = new Map(), agents = [] } = {}) {
  const listeners = new Map();
  const disposers = [];
  const logs = [];
  const providers = [];
  const tools = { schemas: () => [...SERVED].map((tool) => ({ name: tool })) };
  const ctx = {
    tools,
    agentPresets: {
      composedPreset: (agentCtx) => presets.get(agentCtx.agentId),
    },
    agents: { list: () => agents },
    systemPrompt: {
      tools(provider) {
        providers.push(provider);
        return () => {};
      },
    },
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
    logs,
    providers,
    /** Fire every listener registered for one event. */
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
    /** Run every registered effect disposer, as plugin unload would. */
    unload() {
      for (const dispose of disposers) dispose();
    },
    /** Assemble the catalog one Agent would receive. */
    catalogFor(agent) {
      let result;
      for (const provider of providers) result = provider({ scope: agent.scope });
      return result ?? { schemas: [] };
    },
  };
}

/** The served tool surface these tests share. Exported as a mutable list. */
const SERVED = Object.freeze(["read", "grep", "list_bots", "message_bot", "ask_user"]);

/**
 * A live-Agent stand-in: a REAL scoped Cordis context, a session id, and an own
 * tool layer. The scope key is minted by the platform's own `createScope`, so
 * the catalog lookup is exercised through the same `scopeOf()` the runtime uses
 * rather than through a hand-tagged property.
 */
function fakeAgent(sessionId, agentId, options = {}) {
  const { restrictable = true } = options;
  const served = options.served ?? SERVED;
  const scope = {};
  const scoped = createScope(new Context(), scope);
  const state = { restrictions: 0, lifted: 0, allow: undefined, deny: undefined, disposed: false };
  // Build on the REAL scoped context, so `scopeOf(agent.ctx)` resolves to this
  // Agent's scope exactly as it does for a live Agent.
  const agentCtx = scoped.ctx.extend({
    agentId,
    tools: {
      // The registry answers `schemas(agent)` with what the Agent inherits; a
      // deny list is filtered through it before `restrict()`.
      schemas: () => served.map((tool) => ({ name: tool })),
      restrict: (filter) => {
        if (!restrictable) {
          throw new Error("tools.restrict() requires a scoped context (agent.ctx)");
        }
        state.restrictions += 1;
        state.allow = filter.allow;
        state.deny = filter.deny;
        return () => {
          state.lifted += 1;
        };
      },
    },
  });

  const agent = {
    session: { id: sessionId },
    scope,
    ctx: agentCtx,
    state,
    /** Tear the scoped context down, as Agent disposal does. */
    async dispose() {
      await scoped.dispose();
      state.disposed = true;
    },
  };
  // The runtime's own reader must agree this context belongs to the scope.
  assert.equal(scopeOf(agent.ctx), scope, "the fake Agent must be really scoped");
  return agent;
}

/** The Bot preset these tests scope ds-bot's team tools to. */
const BOT_RULES = {
  list_bots: { presets: ["standard"] },
  message_bot: { presets: ["standard"] },
  ask_user: { presets: ["standard"] },
};

test("compileRules drops empty preset lists and honours allowAll", () => {
  const restricted = compileRules({
    list_bots: { presets: ["standard"] },
    empty: { presets: [] },
    opted_out: { presets: ["standard"], allowAll: true },
    blank: { presets: ["", "standard"] },
  });
  assert.deepEqual([...restricted.keys()].sort(), ["blank", "list_bots"]);
  assert.deepEqual([...restricted.get("blank")], ["standard"]);
});

test("hiddenFor returns nothing for an unbound preset", () => {
  const restricted = compileRules(BOT_RULES);
  assert.deepEqual(hiddenFor(restricted, undefined), []);
  assert.deepEqual(hiddenFor(restricted, "standard"), []);
  assert.deepEqual(hiddenFor(restricted, "yiln").sort(), ["ask_user", "list_bots", "message_bot"]);
});

test("a Bot preset keeps the tools and gets no restriction", () => {
  const agent = fakeAgent("s-bot", "standard");
  const presets = new Map([["standard", "standard"]]);
  const fake = fakeCtx({ presets, agents: [agent] });

  apply(fake.ctx, { tools: BOT_RULES });
  fake.emit("agent/created", { agent });

  assert.equal(agent.state.restrictions, 0, "a matching preset keeps its tools");
  assert.deepEqual(
    fake.catalogFor(agent).schemas.map((schema) => schema.name),
    SERVED,
    "every tool stays in the Bot catalog",
  );
});

test("another preset loses the tools from catalog and execution", () => {
  const agent = fakeAgent("s-tool", "yiln");
  const presets = new Map([["yiln", "yiln"]]);
  const fake = fakeCtx({ presets, agents: [agent] });

  apply(fake.ctx, { tools: BOT_RULES });
  fake.emit("agent/created", { agent });

  assert.deepEqual(
    fake.catalogFor(agent).schemas.map((schema) => schema.name),
    ["read", "grep"],
    "only undeclared tools remain in the catalog",
  );
  assert.deepEqual(agent.state.deny.sort(), ["ask_user", "list_bots", "message_bot"]);
  assert.equal(agent.state.restrictions, 1, "the same session is not restricted twice");
});

test("an undeclared tool stays visible to every preset", () => {
  // The regression that matters most: installing this plugin must not remove a
  // tool the deployment never named.
  const agent = fakeAgent("s-undeclared", "yiln");
  const presets = new Map([["yiln", "yiln"]]);
  const fake = fakeCtx({ presets, agents: [agent] });

  apply(fake.ctx, { tools: { list_bots: { presets: ["standard"] } } });
  fake.emit("agent/created", { agent });

  const names = fake.catalogFor(agent).schemas.map((schema) => schema.name);
  assert.ok(names.includes("read"));
  assert.ok(names.includes("message_bot"), "a tool with no rule keeps its old visibility");
  assert.ok(!names.includes("list_bots"));
});

test("a tool the deployment never mounted is not a restrict() failure", () => {
  const agent = fakeAgent("s-unmounted", "yiln", { served: ["read", "grep"] });
  const presets = new Map([["yiln", "yiln"]]);
  const fake = fakeCtx({ presets, agents: [agent] });

  apply(fake.ctx, { tools: BOT_RULES });
  fake.emit("agent/created", { agent });

  assert.equal(agent.state.restrictions, 0, "nothing the Agent inherits could be denied");
  assert.deepEqual(fake.logs, [], "an unmounted name is not an error");
});

test("leaving a matching preset lifts the restriction", () => {
  const agent = fakeAgent("s-switch", "yiln");
  const presets = new Map([["yiln", "yiln"]]);
  const fake = fakeCtx({ presets, agents: [agent] });

  apply(fake.ctx, { tools: BOT_RULES });
  fake.emit("agent/created", { agent });
  assert.equal(agent.state.restrictions, 1);

  // A blank Session switched to the Bot preset: it must get its tools back.
  presets.set("yiln", "standard");
  fake.emit("tools/change");

  assert.equal(agent.state.lifted, 1);
  assert.deepEqual(
    fake.catalogFor(agent).schemas.map((schema) => schema.name),
    SERVED,
    "the catalog has no rules left to apply",
  );
});

test("a disposed Agent releases its restriction exactly once", () => {
  const agent = fakeAgent("s-dispose", "yiln");
  const presets = new Map([["yiln", "yiln"]]);
  const fake = fakeCtx({ presets, agents: [agent] });

  apply(fake.ctx, { tools: BOT_RULES });
  fake.emit("agent/created", { agent });
  fake.emit("agent/disposed", { agent });
  fake.emit("agent/disposed", { agent });

  assert.equal(agent.state.lifted, 1, "a repeated disposal does not double-release");
});

test("agents that already existed are handled on mount", () => {
  const agent = fakeAgent("s-existing", "yiln");
  const presets = new Map([["yiln", "yiln"]]);
  const fake = fakeCtx({ presets, agents: [agent] });

  apply(fake.ctx, { tools: BOT_RULES });

  assert.equal(agent.state.restrictions, 1);
  assert.deepEqual(
    fake.catalogFor(agent).schemas.map((schema) => schema.name),
    ["read", "grep"],
  );
});

test("unloading lifts every restriction it installed", () => {
  const a = fakeAgent("s-a", "yiln");
  const b = fakeAgent("s-b", "yiln");
  const presets = new Map([["yiln", "yiln"]]);
  const fake = fakeCtx({ presets, agents: [a, b] });

  apply(fake.ctx, { tools: BOT_RULES });
  assert.equal(a.state.restrictions, 1);
  assert.equal(b.state.restrictions, 1);

  fake.unload();
  assert.equal(a.state.lifted, 1);
  assert.equal(b.state.lifted, 1);
});

test("an unscoped Agent is reported and stays catalog-trimmed", () => {
  const agent = fakeAgent("s-unscoped", "yiln", { restrictable: false });
  const presets = new Map([["yiln", "yiln"]]);
  const fake = fakeCtx({ presets, agents: [agent] });

  // The Agent already exists at mount, so the policy runs once there and once
  // more on `agent/created`; both report the same inability to restrict.
  apply(fake.ctx, { tools: BOT_RULES });
  fake.emit("agent/created", { agent });

  const warnings = fake.logs.filter(([level]) => level === "warn");
  assert.ok(warnings.length >= 1, "the unscoped Agent is reported");
  assert.match(String(warnings[0][1]), /cannot be restricted/);
  assert.ok(
    !fake.catalogFor(agent).schemas.some((schema) => schema.name === "list_bots"),
    "the catalog layer still hides the tool when execution cannot",
  );
});

test("an unbound Agent is skipped without a log or a trim", () => {
  const agent = fakeAgent("s-unbound", "unbound");
  const presets = new Map();
  const fake = fakeCtx({ presets, agents: [agent] });

  apply(fake.ctx, { tools: BOT_RULES });
  fake.emit("agent/created", { agent });

  assert.equal(agent.state.restrictions, 0);
  assert.deepEqual(fake.logs, [], "an unbound Agent is not an error");
  assert.deepEqual(
    fake.catalogFor(agent).schemas.map((schema) => schema.name),
    SERVED,
    "an unresolvable preset leaves the catalog alone",
  );
});

test("a throwing catalog pass falls back to the unfiltered catalog", () => {
  // A provider that throws fails EVERY turn, so this fallback is load-bearing.
  const agent = fakeAgent("s-throw", "yiln");
  const presets = new Map([["yiln", "yiln"]]);
  const fake = fakeCtx({ presets, agents: [agent] });

  apply(fake.ctx, { tools: BOT_RULES });
  fake.emit("agent/created", { agent });

  const broken = fakeCtx({ presets, agents: [agent] });
  broken.ctx.tools.schemas = () => {
    throw new Error("registry exploded");
  };
  apply(broken.ctx, { tools: BOT_RULES });

  // The provider still returns a usable result rather than throwing.
  let result;
  for (const provider of broken.providers) result = provider({ scope: agent.scope });
  assert.deepEqual(result.schemas, []);
  assert.ok(
    broken.logs.some(([, message]) => /catalog read failed/.test(String(message))),
    "the failure is reported",
  );
});

test("an empty tool map mounts inert", () => {
  const agent = fakeAgent("s-inert", "yiln");
  const presets = new Map([["yiln", "yiln"]]);
  const fake = fakeCtx({ presets, agents: [agent] });

  apply(fake.ctx, { tools: {} });
  apply(fake.ctx, {});
  apply(fake.ctx, undefined);

  assert.equal(agent.state.restrictions, 0);
  assert.deepEqual(fake.providers, [], "no provider is registered when no rule exists");
});

test("verbose reports the trimmed catalog", () => {
  const agent = fakeAgent("s-verbose", "yiln");
  const presets = new Map([["yiln", "yiln"]]);
  const fake = fakeCtx({ presets, agents: [agent] });

  apply(fake.ctx, { tools: BOT_RULES, verbose: true });
  fake.emit("agent/created", { agent });

  assert.ok(
    fake.logs.some(([level, message]) => level === "info" && /yiln/.test(String(message))),
    "one informational line names the preset",
  );
});
