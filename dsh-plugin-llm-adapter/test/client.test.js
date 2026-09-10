import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const CLIENT_SOURCE = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const HOST_SOURCE = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");

test("keeps the client half passive while the Host patches the official Models editor", () => {
  assert.match(CLIENT_SOURCE, /const inject = \[\]/u);
  assert.doesNotMatch(CLIENT_SOURCE, /settings\.models\.provider-card/u);
  assert.doesNotMatch(CLIENT_SOURCE, /编辑高级模型设置/u);
  assert.doesNotMatch(CLIENT_SOURCE, /Edit advanced model settings/u);
});

test("uses optional namespace imports for old and RC1 host exports", () => {
  assert.match(HOST_SOURCE, /import \* as dshLlm from "@deepseek-ai\/dsh-llm"/u);
  assert.match(HOST_SOURCE, /import \* as dshSettings from "@deepseek-ai\/dsh-settings"/u);
  assert.match(HOST_SOURCE, /dshLlm\.ToolCallId/u);
  assert.match(HOST_SOURCE, /settings\.installSection/u);
  assert.doesNotMatch(HOST_SOURCE, /import \{[^}]*\bCallId\b/u);
});
