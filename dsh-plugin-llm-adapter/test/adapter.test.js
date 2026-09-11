import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.DSH_LLM_ADAPTER_MODULE
  ?? "/root/.dsh/profiles/web/node_modules/@yiln-dsh/dsh-plugin-llm-adapter/lib/index.js";
const { Config, apply, blankOptionalArgNormalizer } = await import(pathToFileURL(modulePath).href);

const credentials = { resolve: async () => ({ value: "test-key" }) };

function mount(models, attachments) {
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
    get(name) {
      if (name === "credentials") return credentials;
      if (name === "attachments") return attachments;
      return undefined;
    },
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

test("serializes an admitted image with its request dimensions", async () => {
  const ref = {
    attachmentId: "sha256:test-image",
    mediaType: "image/png",
    bytes: 4,
    width: 2,
    height: 2,
  };
  const attachments = {
    readImageRequest: async () => ({
      attachment: ref,
      data: new Uint8Array([1, 2, 3, 4]),
      mediaType: "image/png",
      bytes: 4,
      width: 2,
      height: 2,
    }),
  };
  const adapter = mount([{
    ...commonModel,
    id: "gpt-5.6-luna",
    input: ["text", "image"],
    reasoningEffort: "max",
    serviceTier: "priority",
  }], attachments);
  const request = await captureRequest(adapter, {
    provider: "sub2api-gpt",
    model: "gpt-5.6-luna",
    messages: [message("user", "image-message", [{ type: "image", attachment: ref }], { kind: "user" })],
  });

  assert.ok(request, "the adapter should reach the provider request after image conversion");
  assert.match(JSON.stringify(request), /2x2/);
});

const bashTool = {
  name: "bash",
  description: "Execute a bash command",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      description: { type: "string" },
      justification: { type: "string" },
      sandbox_permissions: { type: "string", enum: ["workspace-write", "danger-full-access"] },
    },
    required: ["command", "description"],
  },
};

const writeTool = {
  name: "write",
  description: "Write a file",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      content: { type: "string" },
      justification: { type: "string" },
    },
    required: ["file_path", "content"],
  },
};

test("drops a blank optional argument instead of passing it as a malformed ask", () => {
  const normalize = blankOptionalArgNormalizer([bashTool, writeTool]);
  const args = {
    command: "git rev-parse HEAD",
    description: "Read the commit",
    justification: "",
    run_in_background: false,
    sandbox_permissions: "danger-full-access",
    timeoutMs: 10000,
  };

  assert.deepEqual(normalize("bash", args), {
    command: "git rev-parse HEAD",
    description: "Read the commit",
    run_in_background: false,
    timeoutMs: 10000,
  }, "an escalation mode whose reason is blank is a filler, not a request");
  assert.deepEqual(args, {
    command: "git rev-parse HEAD",
    description: "Read the commit",
    justification: "",
    run_in_background: false,
    sandbox_permissions: "danger-full-access",
    timeoutMs: 10000,
  }, "the model's own arguments are never mutated");
});

test("keeps a required property even when the model sends it empty", () => {
  const normalize = blankOptionalArgNormalizer([writeTool]);

  assert.deepEqual(normalize("write", { file_path: "/tmp/empty", content: "", justification: "" }), {
    file_path: "/tmp/empty",
    content: "",
  }, "an empty write.content still writes an empty file");
});

/** A settled tool call plus its model-facing result, as the next request carries them. */
function settled(name, id, resultText) {
  return [
    message("assistant", `message-${id}`, [{
      type: "tool-call",
      id,
      name,
      arguments: "{}",
    }], { kind: "model", provider: "sub2api-gpt", model: "gpt-5.6-luna" }),
    message("user", `message-${id}-result`, [{
      type: "tool-result",
      toolCallId: id,
      content: [{ type: "text", text: resultText }],
      isError: true,
    }], { kind: "tool", callId: id }),
  ];
}

const DENIAL = [
  "[sandbox: file access denied under read-only mode]",
  "[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]",
].join("\n");

test("keeps an escalation that answers the denial it just received", () => {
  const normalize = blankOptionalArgNormalizer([bashTool], settled("bash", "call-1", DENIAL));
  const args = {
    command: "cat /etc/shadow",
    description: "Read a protected file",
    sandbox_permissions: "danger-full-access",
    justification: "The sandbox just denied this exact command.",
  };

  assert.equal(normalize("bash", args), args, "a denied command keeps its one sanctioned retry");
});

test("drops a reasoned escalation that answers no denial", () => {
  const normalize = blankOptionalArgNormalizer([bashTool], settled("bash", "call-1", "ok\n"));
  const args = {
    command: "git rev-parse HEAD",
    description: "Read the commit",
    sandbox_permissions: "danger-full-access",
    justification: "Create the initial architecture specification in the repository.",
  };

  assert.deepEqual(normalize("bash", args), {
    command: "git rev-parse HEAD",
    description: "Read the commit",
  }, "a pair no denial grounds can never be granted, so it is not a request");
});

test("grounds an escalation in the denial of its own tool", () => {
  const normalize = blankOptionalArgNormalizer([bashTool, writeTool], settled("bash", "call-1", DENIAL));
  const args = {
    file_path: "/tmp/out.txt",
    content: "test",
    sandbox_permissions: "danger-full-access",
    justification: "Test writing a repository file.",
  };

  assert.deepEqual(normalize("write", args), {
    file_path: "/tmp/out.txt",
    content: "test",
  }, "another tool's denial does not authorize this one");
});

test("drops an escalation reason that drives nothing", () => {
  const normalize = blankOptionalArgNormalizer([bashTool]);

  assert.deepEqual(normalize("bash", { command: "ls", description: "List", justification: "Needed to continue." }), {
    command: "ls",
    description: "List",
  });
});

test("leaves an unknown tool and non-object arguments untouched", () => {
  const normalize = blankOptionalArgNormalizer([bashTool]);
  const unknown = { justification: "", provider: "" };

  assert.equal(normalize("subagent", unknown), unknown, "nothing is known optional for an unadvertised tool");
  assert.equal(normalize("bash", "not-an-object"), "not-an-object");
  assert.equal(normalize("bash", null), null);
  assert.equal(blankOptionalArgNormalizer([]), undefined);
});

function responsesStream(events) {
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function streamToolCall(adapter, item) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => responsesStream([
    { type: "response.created", response: { id: "resp-1" } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: "resp-1",
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
  const blocks = [];
  try {
    for await (const chunk of adapter.stream({
      provider: "sub2api-gpt",
      model: "gpt-5.6-luna",
      messages: [userMessage()],
      tools: [bashTool],
    })) {
      if (chunk.type === "block-end" && chunk.block.type === "tool-call") blocks.push(chunk.block);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  return blocks;
}

const fillerCall = {
  type: "function_call",
  id: "fc-1",
  call_id: "call-1",
  name: "bash",
  arguments: '{"command":"git rev-parse HEAD","description":"Read the commit","justification":"","sandbox_permissions":"danger-full-access"}',
};

test("normalizes a finished tool call when the model opts in", async () => {
  const adapter = mount([{ ...commonModel, id: "gpt-5.6-luna", dropArgumentFillers: true }]);
  const blocks = await streamToolCall(adapter, fillerCall);

  assert.equal(blocks.length, 1);
  assert.deepEqual(JSON.parse(blocks[0].arguments), {
    command: "git rev-parse HEAD",
    description: "Read the commit",
  }, "the call recorded and dispatched carries no filler");
});

test("records the model's own arguments when it does not opt in", async () => {
  const adapter = mount([{ ...commonModel, id: "gpt-5.6-luna" }]);
  const blocks = await streamToolCall(adapter, fillerCall);

  assert.equal(blocks.length, 1);
  assert.deepEqual(JSON.parse(blocks[0].arguments), JSON.parse(fillerCall.arguments));
});
