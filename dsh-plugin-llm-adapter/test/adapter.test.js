import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.DSH_LLM_ADAPTER_MODULE
  ?? "/root/.dsh/profiles/web/node_modules/@yiln-dsh/dsh-plugin-llm-adapter/lib/index.js";
const { Config, apply } = await import(pathToFileURL(modulePath).href);

const credentials = { resolve: async () => ({ value: "test-key" }) };

function mount(models) {
  let adapter;
  const ctx = {
    llm: {
      registerAdapter(_providers, value) {
        adapter = value;
        return { replace() {} };
      },
      registerConfigurableProviders() {
        return { replace() {} };
      },
      registerModelDiscovery() {
        return () => {};
      },
    },
    credentials,
    webServer: { register() { return () => {}; } },
    clientModules: { clientPath() { return undefined; } },
    inject() {},
    effect(setup) { return setup(); },
    get(name) { return name === "credentials" ? credentials : undefined; },
    logger: { warn() {}, info() {}, error() {} },
  };
  apply(ctx, Config({ providers: {
    "sub2api-gpt": {
      apiKeyEnv: "SUB2API_API_KEY",
      api: "openai-responses",
      baseURL: "https://sub2api.yiln.de/v1",
      reasoning: "max",
      models,
    },
  } }));
  assert.ok(adapter, "the fork must register an adapter");
  return adapter;
}

function message(role, id, content, source) {
  return { role, id, content, source };
}

async function captureRequest(adapter, options) {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (_url, init) => {
    request = JSON.parse(init.body);
    throw new Error("captured request");
  };
  try {
    for await (const _chunk of adapter.stream(options)) {}
  } finally {
    globalThis.fetch = originalFetch;
  }
  return request;
}

const commonModel = {
  contextWindow: 1000000,
  maxTokens: 128000,
  input: ["text"],
  reasoningEfforts: { off: null, low: "low", high: "high", max: "max" },
};

function userMessage() {
  return message("user", "message-1", [{ type: "text", text: "ping" }], { kind: "user" });
}

test("uses each model's reasoning and Responses service tier defaults", async () => {
  const adapter = mount([
    { ...commonModel, id: "gpt-5.6-luna", reasoningEffort: "low", serviceTier: "priority" },
    { ...commonModel, id: "gpt-5.6-terra", reasoningEffort: "high", serviceTier: "default" },
  ]);
  const lunaInfo = await adapter.resolveModel("sub2api-gpt", "gpt-5.6-luna");
  const terraInfo = await adapter.resolveModel("sub2api-gpt", "gpt-5.6-terra");
  const lunaRequest = await captureRequest(adapter, {
    provider: "sub2api-gpt",
    model: "gpt-5.6-luna",
    messages: [userMessage()],
  });
  const terraRequest = await captureRequest(adapter, {
    provider: "sub2api-gpt",
    model: "gpt-5.6-terra",
    messages: [userMessage()],
  });

  assert.equal(lunaInfo.reasoning.defaultEffort, "low");
  assert.equal(terraInfo.reasoning.defaultEffort, "high");
  assert.equal(lunaRequest.reasoning.effort, "low");
  assert.equal(lunaRequest.service_tier, "priority");
  assert.equal(terraRequest.reasoning.effort, "high");
  assert.equal(terraRequest.service_tier, "default");
});

test("keeps request reasoning override and tool/replay-compatible history", async () => {
  const adapter = mount([{
    ...commonModel,
    id: "gpt-5.6-luna",
    reasoningEffort: "low",
    serviceTier: "priority",
  }]);
  const request = await captureRequest(adapter, {
    provider: "sub2api-gpt",
    model: "gpt-5.6-luna",
    reasoningEffort: "high",
    tools: [{
      name: "lookup",
      description: "Look up a value",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    }],
    messages: [
      userMessage(),
      message("assistant", "message-2", [{
        type: "tool-call",
        id: "call-1",
        name: "lookup",
        arguments: '{"query":"x"}',
      }], { kind: "model", provider: "sub2api-gpt", model: "gpt-5.6-luna" }),
      message("user", "message-3", [{
        type: "tool-result",
        toolCallId: "call-1",
        content: [{ type: "text", text: "result" }],
      }], { kind: "tool", callId: "call-1" }),
    ],
  });

  assert.equal(request.reasoning.effort, "high");
  assert.equal(request.service_tier, "priority");
  assert.equal(request.tools[0].name, "lookup");
  assert.ok(request.input.some((entry) => JSON.stringify(entry).includes("call-1")));
  assert.ok(request.input.some((entry) => JSON.stringify(entry).includes("result")));
});
