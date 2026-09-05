import assert from "node:assert/strict";
import test from "node:test";
import { apply, explainSandboxFailure } from "../index.js";

test("explains the native non-widening bash error", () => {
  const same = explainSandboxFailure(
    'sandbox escalation to "danger-full-access" is not strictly wider than this call\'s current "danger-full-access" mode',
  );
  assert.match(same, /Bash was not executed/u);
  assert.match(same, /requested "danger-full-access"/u);
  assert.match(same, /already active/u);
  assert.match(same, /omit both sandbox_permissions and justification/u);

  const narrower = explainSandboxFailure(
    'sandbox escalation to "workspace-write" is not strictly wider than this call\'s current "danger-full-access" mode (request was not executed)',
  );
  assert.match(narrower, /not wider than the current mode/u);
  assert.match(narrower, /omit both sandbox_permissions and justification/u);
  assert.equal(explainSandboxFailure("command failed with exit code 1"), undefined);
});

test("installs prompt guidance and rewrites only matching bash failures", async () => {
  let prompt;
  const listeners = new Map();
  const ctx = {
    systemPrompt: {
      getSectionOrder: () => 100,
      section(value) {
        prompt = value;
      },
    },
    on(event, listener) {
      listeners.set(event, listener);
    },
  };
  apply(ctx);

  assert.equal(prompt.name, "tool:sandbox-guidance");
  assert.match(prompt.text, /Do not include sandbox_permissions/u);
  assert.match(prompt.text, /Never send justification by itself/u);
  assert.match(prompt.text, /strictly wider/u);
  assert.match(prompt.text, /retry the exact same command once/u);
  assert.match(prompt.text, /do not ask for approval in chat first/u);
  const postExecute = listeners.get("tools/post-execute");
  assert.equal(typeof postExecute, "function");

  let delegated = false;
  const next = () => {
    delegated = true;
    return Promise.resolve({ kind: "accept" });
  };
  const rewritten = await postExecute(
    { name: "bash" },
    {
      isError: true,
      error: {
        message: 'sandbox escalation to "danger-full-access" is not strictly wider than this call\'s current "danger-full-access" mode',
      },
      content: [],
    },
    next,
  );
  assert.equal(rewritten.kind, "accept");
  assert.match(rewritten.content[0].text, /Bash was not executed/u);
  assert.equal(delegated, false);

  const other = await postExecute(
    { name: "bash" },
    { isError: true, error: { message: "command failed" }, content: [] },
    next,
  );
  assert.deepEqual(other, { kind: "accept" });
  assert.equal(delegated, true);

  delegated = false;
  const nonBash = await postExecute(
    { name: "fs" },
    { isError: true, error: { message: 'sandbox escalation to "danger-full-access" is not strictly wider than this call\'s current "danger-full-access" mode' }, content: [] },
    next,
  );
  assert.deepEqual(nonBash, { kind: "accept" });
  assert.equal(delegated, true);

  delegated = false;
  const success = await postExecute(
    { name: "bash" },
    { isError: false, value: {}, content: [] },
    next,
  );
  assert.deepEqual(success, { kind: "accept" });
  assert.equal(delegated, true);
});
