import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import test from "node:test";

const CLIENT_SOURCE = readFileSync(new URL("../client.js", import.meta.url), "utf8");

function loadClientExports() {
  let definition;
  const context = createContext({
    Symbol,
    window: {
      __ModuleLoader__: {
        load(value) {
          definition = value;
        },
      },
    },
  });
  runInContext(CLIENT_SOURCE, context, { filename: "file-explorer/client.js" });
  assert.ok(definition, "the file explorer client should register a module definition");
  return definition.factory(() => ({}));
}

test("headless workspace opens are routed to the file explorer", async () => {
  const client = loadClientExports();
  assert.equal(typeof client.installWorkspaceOpenFallback, "function", "the client should expose its opener integration seam");

  const opened = [];
  const nativeCan = async () => ({ ok: true, value: false });
  const nativeOpen = async () => {
    throw new Error("native opener must not run on a headless host");
  };
  const session = {};
  Object.defineProperty(session, "canOpenWorkspacePath", { configurable: true, get: () => nativeCan });
  Object.defineProperty(session, "openWorkspacePath", { configurable: true, get: () => nativeOpen });
  const remote = { session };
  const controller = {
    open(path) {
      opened.push(path);
      return true;
    },
  };

  const dispose = client.installWorkspaceOpenFallback(remote, controller);
  const result = await session.openWorkspacePath({ path: "/workspace/edited.js" });

  assert.deepEqual(opened, ["/workspace/edited.js"]);
  assert.equal(result.ok, true);
  assert.equal(result.value.opened, true);
  dispose();
  assert.equal(session.openWorkspacePath, nativeOpen);
  assert.equal(session.canOpenWorkspacePath, nativeCan);
});

test("preserves native workspace opening when the host supports it", async () => {
  const client = loadClientExports();
  const nativeCalls = [];
  const fallbackCalls = [];
  const session = {
    async canOpenWorkspacePath() {
      return { ok: true, value: true };
    },
    async openWorkspacePath(request) {
      nativeCalls.push(request.path);
      return { ok: true, value: { opened: true } };
    },
  };
  const dispose = client.installWorkspaceOpenFallback(
    { session },
    { open(path) { fallbackCalls.push(path); return true; } },
  );

  const result = await session.openWorkspacePath({ path: "/workspace/native.js" });

  assert.equal(result.ok, true);
  assert.deepEqual(nativeCalls, ["/workspace/native.js"]);
  assert.deepEqual(fallbackCalls, []);
  dispose();
});
