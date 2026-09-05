import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const CLIENT_SOURCE = readFileSync(new URL("../client.js", import.meta.url), "utf8");
const HOST_SOURCE = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");

test("declares the RC1 Models provider-card client extension", () => {
  assert.match(CLIENT_SOURCE, /const inject = \["slots", "locale", "remote", "remote\.settings"\]/u);
  assert.match(CLIENT_SOURCE, /name: "settings\.models\.provider-card"/u);
  assert.match(CLIENT_SOURCE, /key: "llm-pi-ai"/u);
  assert.match(CLIENT_SOURCE, /settings\.describe\(\)/u);
  assert.match(CLIENT_SOURCE, /settings\.update\(SETTINGS_NS/u);
});

test("uses optional namespace imports for old and RC1 host exports", () => {
  assert.match(HOST_SOURCE, /import \* as dshLlm from "@deepseek-ai\/dsh-llm"/u);
  assert.match(HOST_SOURCE, /import \* as dshSettings from "@deepseek-ai\/dsh-settings"/u);
  assert.match(HOST_SOURCE, /dshLlm\.ToolCallId/u);
  assert.match(HOST_SOURCE, /settings\.installSection/u);
  assert.doesNotMatch(HOST_SOURCE, /import \{[^}]*\bCallId\b/u);
});
