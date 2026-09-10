import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { patchModelsSettingsClient, registerModelsSettingsPatch } from "../lib/settings-patch.js";

const upstreamPath = "/root/.nvm/versions/node/v24.14.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js";

test("patches the upstream Models editor with provider-wide model controls", () => {
  const source = readFileSync(upstreamPath, "utf8");
  const patched = patchModelsSettingsClient(source);

  assert.notEqual(patched, null);
  new vm.Script(patched);
  assert.equal((patched.match(/function LlmAdapterModelFields/g) ?? []).length, 1);
  assert.match(patched, /update\(index, "serviceTier"/);
  assert.match(patched, /update\(index, "reasoningEffort"/);
  assert.match(patched, /fastInherited/);
  assert.doesNotMatch(patched, /fastTierAuto|fastTierFlex|fastTierScale/);
  assert.match(patched, /const \{ models, onChange, probe, operations, t, disabled, defaultReasoning, defaultServiceTier \} = props;/);
  assert.doesNotMatch(patched, /provider !== "sub2api-gpt"/);
  const invocation = patched.indexOf("(0, react_jsx_runtime.jsx)(LlmAdapterModelFields");
  const maxTokensLabel = patched.lastIndexOf('children: t("modelMaxTokens")');
  assert.ok(maxTokensLabel >= 0 && maxTokensLabel < invocation);
  assert.ok(patched.indexOf('children: t("modelContextWindow")') < maxTokensLabel);
  assert.ok(patched.indexOf("function LlmAdapterModelFields") < patched.indexOf("function ModelListEditor"));
});


test("rebuilds the combo bundle and restores the source on disposal", () => {
  const directory = mkdtempSync(join(process.cwd(), ".tmp-llm-settings-patch-"));
  const clientPath = join(directory, "client.js");
  const source = readFileSync(upstreamPath, "utf8");
  const alreadyPatched = source.includes("dsh-plugin-llm-adapter settings patch");
  writeFileSync(clientPath, source, "utf8");
  let rebuilds = 0;
  let disposer;
  let routeDisposerCalls = 0;
  const ctx = {
    clientModules: {
      clientPath: () => clientPath,
      rebuilt: () => {
        rebuilds += 1;
        return `rev-${rebuilds}`;
      },
    },
    webServer: {
      register: () => () => {
        routeDisposerCalls += 1;
      },
    },
    effect(factory) {
      disposer = factory();
      return disposer;
    },
    logger: { warn() {} },
  };

  try {
    registerModelsSettingsPatch(ctx);
    const patched = readFileSync(clientPath, "utf8");
    assert.match(patched, /function LlmAdapterModelFields/u);
    assert.equal(rebuilds, 1);
    disposer();
    assert.equal(readFileSync(clientPath, "utf8"), source);
    assert.equal(rebuilds, alreadyPatched ? 1 : 2);
    assert.equal(routeDisposerCalls, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
