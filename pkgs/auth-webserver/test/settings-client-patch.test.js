import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  injectRemoteSettingsMarker,
  patchSettingsClient,
  registerRemoteSettingsClientPatch,
  REMOTE_SETTINGS_GLOBAL,
  REMOTE_SETTINGS_HTTP_GLOBAL,
  REMOTE_SETTINGS_MARKER,
  SETTINGS_CLIENT_PACKAGE,
} from "../settings-client-patch.js";

const PERSISTENCE_ANCHOR = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";';

// The shipped Settings client as DSH >= 0.2.1-alpha.3 renders it: the
// Host/process-local gate is gone, `persistence` appears nowhere, and
// writability comes from the Host describe mirror. A fixture is not enough on
// its own — see the real-bundle test below — but this pins the shape that used
// to be reported as a hard failure.
const RETIRED_GATE_SOURCE = [
  "function apply(ctx) {",
  "\tconst schema = new SettingsSchemaService(ctx);",
  "\tconst mirror = new SettingsDescribeMirror(ctx);",
  "\tnew ConfigForms(ctx, { mirror, schema });",
  "}",
].join("\n");

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

test("treats a client that dropped the gate as nothing to patch, not a failure", () => {
  // DSH >= 0.2.1-alpha.3. Host-backed settings are unconditional there, so the
  // source must come back byte-identical (the caller then skips the rewrite and
  // must NOT log the unrecognised-shape error).
  const patched = patchSettingsClient(RETIRED_GATE_SOURCE);

  assert.equal(patched, RETIRED_GATE_SOURCE);
  assert.doesNotMatch(patched, /dsh-plugin-auth-webserver remote settings patch/);
});

test("fails loudly when the bundle names the gate in an unrecognised shape", () => {
  assert.equal(patchSettingsClient("const persistence = 'memory';"), null);
  assert.equal(patchSettingsClient("const persistence = enabled ? 'host' : 'memory';"), null);
});

test("records a gate-present bundle as a rewrite, a retired one as a no-op", () => {
  // The distinction the caller depends on: `ownsPatch` decides whether the file
  // is written and restored, so a retired bundle must not be rewritten.
  const present = `before\n${PERSISTENCE_ANCHOR}\nafter`;
  const retired = RETIRED_GATE_SOURCE;

  assert.notEqual(patchSettingsClient(present), present);
  assert.equal(patchSettingsClient(retired), retired);
});

test("patches the real shipped Settings client it can resolve", () => {
  // Guards the anchor against the artifact this repository actually installs,
  // which the synthetic fixtures above cannot do: the old fixture embedded the
  // anchor verbatim, so it passed while the real bundle had already moved on.
  const require = createRequire(import.meta.url);
  const manifest = require.resolve(`${SETTINGS_CLIENT_PACKAGE}/package.json`);
  const source = readFileSync(join(dirname(manifest), "lib", "client.js"), "utf8");
  const patched = patchSettingsClient(source);

  assert.notEqual(patched, null, "the shipped Settings client named the gate in an unrecognised shape");
  if (patched === source) {
    // Retired-gate release (>= 0.2.1-alpha.3): nothing to rewrite, by design.
    assert.doesNotMatch(source, /\bpersistence\b/);
  } else {
    assert.match(patched, /dsh-plugin-auth-webserver remote settings patch/);
  }
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

test("installs on a gate-retired client without rewriting it or logging an error", () => {
  // DSH >= 0.2.1-alpha.3. Before the fix this path returned false and logged at
  // error level on every boot; Host-backed settings are unconditional upstream,
  // so it must report success, leave the file byte-for-byte alone, and stay quiet.
  const directory = mkdtempSync(join(tmpdir(), "dsh-auth-settings-retired-"));
  const clientPath = join(directory, "client.js");
  writeFileSync(clientPath, RETIRED_GATE_SOURCE, "utf8");
  const errors = [];
  const warns = [];
  let dispose;
  const ctx = {
    clientModules: {
      clientPath: () => clientPath,
      rebuilt: () => "rev-1",
    },
    get: () => undefined,
    effect(factory) {
      dispose = factory();
      return dispose;
    },
    logger: {
      warn: (...args) => warns.push(args),
      error: (...args) => errors.push(args),
    },
  };

  try {
    assert.equal(registerRemoteSettingsClientPatch(ctx), true);
    assert.equal(readFileSync(clientPath, "utf8"), RETIRED_GATE_SOURCE);
    assert.deepEqual(errors, []);
    assert.deepEqual(warns, []);
    dispose();
    assert.equal(readFileSync(clientPath, "utf8"), RETIRED_GATE_SOURCE);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("still reports an unrecognised gate shape as an error and installs nothing", () => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-auth-settings-unknown-"));
  const clientPath = join(directory, "client.js");
  const source = "const persistence = someUnknownShape();";
  writeFileSync(clientPath, source, "utf8");
  const errors = [];
  const ctx = {
    clientModules: {
      clientPath: () => clientPath,
      rebuilt: () => "rev-1",
    },
    get: () => undefined,
    effect: () => () => {},
    logger: { warn() {}, error: (...args) => errors.push(args) },
  };

  try {
    assert.equal(registerRemoteSettingsClientPatch(ctx), false);
    assert.equal(readFileSync(clientPath, "utf8"), source);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /not in the shape this patch rewrites/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
