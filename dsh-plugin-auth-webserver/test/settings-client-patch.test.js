import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  injectRemoteSettingsMarker,
  patchSettingsClient,
  registerRemoteSettingsClientPatch,
  REMOTE_SETTINGS_GLOBAL,
  REMOTE_SETTINGS_HTTP_GLOBAL,
  REMOTE_SETTINGS_MARKER,
} from "../settings-client-patch.js";

const PERSISTENCE_ANCHOR = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";';

test("patches the settings client behind the gateway marker", () => {
  const source = `before\n${PERSISTENCE_ANCHOR}\nafter`;
  const patched = patchSettingsClient(source);

  assert.ok(patched);
  assert.match(patched, new RegExp(`location\\.protocol === "https:"`));
  assert.match(patched, new RegExp(`globalThis\\.${REMOTE_SETTINGS_GLOBAL} === true`));
  assert.match(patched, new RegExp(`location\\.protocol === "http:" && globalThis\\.${REMOTE_SETTINGS_HTTP_GLOBAL} === true`));
  assert.match(patched, /dsh-plugin-auth-webserver remote settings patch/);
  assert.equal(patchSettingsClient(patched), patched);
});

test("leaves an unknown settings bundle untouched", () => {
  assert.equal(patchSettingsClient("const persistence = 'memory';"), null);
});

test("injects one idempotent remote settings marker", () => {
  const html = "<!doctype html><html><head><title>DSH</title></head><body></body></html>";
  const marked = injectRemoteSettingsMarker(html, true);
  const markedForHttp = injectRemoteSettingsMarker(html, true, true);

  assert.equal(marked.split(REMOTE_SETTINGS_MARKER).length, 2);
  assert.match(marked, new RegExp(`globalThis\\.${REMOTE_SETTINGS_GLOBAL}=true`));
  assert.doesNotMatch(marked, new RegExp(REMOTE_SETTINGS_HTTP_GLOBAL));
  assert.match(markedForHttp, new RegExp(`globalThis\\.${REMOTE_SETTINGS_HTTP_GLOBAL}=true`));
  assert.equal(injectRemoteSettingsMarker(marked, true), marked);
});

test("rebuilds the combo snapshot and restores the source on disposal", () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-auth-settings-patch-"));
  const clientPath = join(directory, "client.js");
  const source = `before\n${PERSISTENCE_ANCHOR}\nafter`;
  writeFileSync(clientPath, source, "utf8");
  let rebuilds = 0;
  let dispose;
  const ctx = {
    clientModules: {
      clientPath: () => clientPath,
      rebuilt: () => {
        rebuilds += 1;
        return `rev-${rebuilds}`;
      },
    },
    get: () => undefined,
    effect(factory) {
      dispose = factory();
      return dispose;
    },
    logger: { warn() {} },
  };

  try {
    assert.equal(registerRemoteSettingsClientPatch(ctx), true);
    assert.match(readFileSync(clientPath, "utf8"), /dsh-plugin-auth-webserver remote settings patch/);
    assert.equal(rebuilds, 1);
    dispose();
    assert.equal(readFileSync(clientPath, "utf8"), source);
    assert.equal(rebuilds, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
