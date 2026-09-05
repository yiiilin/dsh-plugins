import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const HOST_SOURCE = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const CLIENT_SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const PATCH_SOURCE = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");

test("uses RC1 settings and recovery controller names", () => {
  assert.match(HOST_SOURCE, /const NS = "web-daemon"/u);
  assert.match(HOST_SOURCE, /sessionController: \[/u);
  assert.match(HOST_SOURCE, /agentPresets: \["remoteExportList", "select"\]/u);
  assert.match(HOST_SOURCE, /subagents: \["listChildren", "prompt", "interruptByParent"\]/u);
  assert.match(HOST_SOURCE, /session\.snapshotEvents\(\)/u);
  assert.doesNotMatch(HOST_SOURCE, /import .*settingsNamespace/u);
  assert.doesNotMatch(HOST_SOURCE, /import .*resolveSessionPreset/u);
  assert.doesNotMatch(PATCH_SOURCE, /apiProxy/u);
});

test("registers the server status panel through the official sidebar footer slot", () => {
  assert.match(CLIENT_SOURCE, /sidebar\.footer\.action/u);
  assert.match(CLIENT_SOURCE, /id: "web-daemon-server-status"/u);
  assert.doesNotMatch(CLIENT_SOURCE, /sidebar\.server\.status/u);
});
