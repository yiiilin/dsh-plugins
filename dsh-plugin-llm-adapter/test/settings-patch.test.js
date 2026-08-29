import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { patchModelsSettingsClient } from "../lib/settings-patch.js";

const upstreamPath = "/root/.nvm/versions/node/v24.14.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js";

test("patches the upstream Models editor with model-level controls", () => {
  const source = readFileSync(upstreamPath, "utf8");
  const patched = patchModelsSettingsClient(source);

  assert.notEqual(patched, null);
  new vm.Script(patched);
  assert.equal((patched.match(/function LlmAdapterModelFields/g) ?? []).length, 1);
  assert.match(patched, /update\(index, "serviceTier"/);
  assert.match(patched, /update\(index, "reasoningEffort"/);
  assert.match(patched, /defaultServiceTier/);
  assert.ok(patched.indexOf("function LlmAdapterModelFields") < patched.indexOf("function ModelListEditor"));
});

test("refuses an unrecognized upstream bundle shape", () => {
  assert.equal(patchModelsSettingsClient("not the Models bundle"), null);
});
