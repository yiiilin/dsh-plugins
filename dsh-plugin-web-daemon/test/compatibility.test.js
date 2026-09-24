import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const HOST_SOURCE = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const CLIENT_SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const PATCH_SOURCE = readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
const GATE_SOURCE = readFileSync(new URL("../lib/recovery-gate.js", import.meta.url), "utf8");

test("uses RC1 settings and recovery controller names", () => {
  assert.match(HOST_SOURCE, /const NS = "web-daemon"/u);
  assert.match(GATE_SOURCE, /sessionController: \[/u);
  assert.match(GATE_SOURCE, /agentPresets: \["remoteExportList", "select"\]/u);
  assert.match(GATE_SOURCE, /subagents: \["listChildren", "prompt", "interruptByParent"\]/u);
  assert.match(HOST_SOURCE, /session\.snapshotEvents\(\)/u);
  assert.doesNotMatch(HOST_SOURCE, /import .*settingsNamespace/u);
  assert.doesNotMatch(HOST_SOURCE, /import .*resolveSessionPreset/u);
  assert.doesNotMatch(PATCH_SOURCE, /apiProxy/u);
});

test("injects Agents so the worker can persist running sessions", () => {
  const start = PATCH_SOURCE.indexOf("    - id: web-daemon");
  assert.notEqual(start, -1, "the Web Daemon Host row exists");
  const nextRow = PATCH_SOURCE.indexOf("\n    - id:", start + 1);
  const row = PATCH_SOURCE.slice(start, nextRow === -1 ? undefined : nextRow);
  assert.match(row, /^[ \t]{8}- agents[ \t]*$/mu);
});

test("supports alpha profile SettingsForms with volatile row config", () => {
  assert.match(HOST_SOURCE, /typeof settings\?\.register === "function"/u);
  assert.match(HOST_SOURCE, /settings\.configure\(\{ auto: false \}, ctx\.fiber\)/u);
  assert.match(HOST_SOURCE, /loader\/volatile-update/u);
  assert.match(HOST_SOURCE, /\.volatile\(\)/u);
});
test("registers the server status panel through the official sidebar footer slot", () => {
  assert.match(CLIENT_SOURCE, /sidebar\.footer\.action/u);
  assert.match(CLIENT_SOURCE, /id: "web-daemon-server-status"/u);
  assert.doesNotMatch(CLIENT_SOURCE, /sidebar\.server\.status/u);
});

test("gates session history streams during recovery", () => {
  assert.match(GATE_SOURCE, /sessionController: \[[^\]]*"follow"/u);
  assert.match(GATE_SOURCE, /sessions: \[[^\]]*"follow"/u);
  assert.match(GATE_SOURCE, /async function\* \(\.\.\.args\)/u);
});

test("loads the recovery gate from its own module", () => {
  assert.match(HOST_SOURCE, /import \{ installRecoveryApiGate \} from "\.\/lib\/recovery-gate\.js"/u);
  assert.doesNotMatch(HOST_SOURCE, /function installRecoveryApiGate/u);
});

test("loads the subagent recovery helpers from their own module", () => {
  assert.match(HOST_SOURCE, /import \{[\s\S]*?\} from "\.\/lib\/subagent-recovery\.js"/u);
  assert.match(HOST_SOURCE, /childContinuationRequest/u);
  assert.doesNotMatch(HOST_SOURCE, /function childSessionRecord/u);
});

test("captures the ungated prompt before the recovery gate replaces it", () => {
  // Recovery is what the gate waits for: a gated `prompt` call inside recovery
  // would wait on itself and never settle.
  const capture = HOST_SOURCE.indexOf("const deliverChildPrompt");
  const gate = HOST_SOURCE.indexOf("installRecoveryApiGate(ctx, recoveryServices");
  assert.ok(capture > 0, "deliverChildPrompt is captured");
  assert.ok(gate > 0, "the recovery gate is installed");
  assert.ok(capture < gate, "the ungated prompt is captured before the gate is installed");
});

test("delivers child continuations with a real abort signal", () => {
  // The subagent manager calls `signal.throwIfAborted()` on the cold-resume
  // path, so an absent signal fails the delivery instead of restoring a child.
  assert.match(HOST_SOURCE, /new AbortController\(\)\.signal/u);
  assert.doesNotMatch(HOST_SOURCE, /\}\), undefined\);/u);
});

test("snapshots children as well as roots", () => {
  // `roots()` excludes resident children, so a roots-only walk never records a
  // running subagent and recovery has nothing to re-attach.
  assert.match(HOST_SOURCE, /function liveAgentsOf\(agents\)/u);
  assert.match(HOST_SOURCE, /agents\.list\(\)/u);
  assert.match(HOST_SOURCE, /await restoreChildren\(\);/u);
  const roots = HOST_SOURCE.indexOf("await Promise.all([...records.entries()].map(restore));");
  const children = HOST_SOURCE.indexOf("await restoreChildren();");
  assert.ok(roots < children, "children are re-attached after the top-level sessions");
});

