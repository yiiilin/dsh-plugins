import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  patchSettingsGeneralClient,
  readSettingsDocument,
  replaceSettingsDocument,
  SETTINGS_EDITOR_DOCUMENT_PATH,
  validateSettingsDocument,
} from "../settings-editor.js";

const SETTINGS_OPEN_ANCHOR = "const response = await this.api.settings.openDocument({});";
const SETTINGS_EDITOR_EVENT = "dsh-auth-open-settings-editor";
const HOST_SOURCE = readFileSync(new URL("../index.js", import.meta.url), "utf8");

test("replaces the native settings-document action with an in-app editor event", () => {
  const source = `async open() {\n\ttry {\n\t\t${SETTINGS_OPEN_ANCHOR}\n\t\tif (!response.result.ok) throw new Error(response.result.error.message);\n\t} finally {}\n}`;
  const patched = patchSettingsGeneralClient(source);

  assert.notEqual(patched, null);
  assert.doesNotMatch(patched, /this\.api\.settings\.openDocument/u);
  assert.doesNotMatch(patched, /location\.assign/u);
  assert.match(patched, new RegExp(`CustomEvent\\("${SETTINGS_EDITOR_EVENT}"`, "u"));
  assert.match(patched, /settingsEditorEvent\.defaultPrevented/u);
});

test("keeps the document endpoint behind session and CSRF without step-up credentials", () => {
  for (const token of [
    "SETTINGS_EDITOR_DOCUMENT_PATH",
    "allowsSettingsEditorTransport",
    "allowInsecureSettingsEditor",
    "requireSettingsEditorSession",
    "requireSession(req, res)",
    "SETTINGS_GENERAL_CLIENT_PATH",
  ]) {
    assert.ok(HOST_SOURCE.includes(token), `gateway must retain ${token}`);
  }
  for (const removed of [
    "SETTINGS_EDITOR_UNLOCK_PATH",
    "handleSettingsEditorUnlock",
    "requireSettingsEditorAuthorization",
    "settingsEditorAuthorizations",
    "settingsEditorStepUpAttempts",
  ]) {
    assert.equal(HOST_SOURCE.includes(removed), false, `gateway must remove ${removed}`);
  }
  assert.match(HOST_SOURCE, /"x-dsh-csrf"/u);
  assert.equal(HOST_SOURCE.includes("SETTINGS_EDITOR_PATH"), false);
});

test("refuses to patch an unknown settings client shape", () => {
  assert.equal(patchSettingsGeneralClient("function differentBundle() {}"), null);
});

test("uses the fixed browser document route", () => {
  assert.equal(SETTINGS_EDITOR_DOCUMENT_PATH, "/_dsh/auth-webserver/settings-editor/document");
});

test("accepts YAML mapping documents but rejects invalid or non-mapping content", () => {
  assert.doesNotThrow(() => validateSettingsDocument("llm-pi-ai:\n  providers: {}\n"));
  assert.throws(() => validateSettingsDocument("llm-pi-ai: [\n"));
  assert.throws(() => validateSettingsDocument("- not\n- a mapping\n"));
});

test("writes only a current, valid settings document revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-settings-editor-"));
  const path = join(directory, "settings.yaml");
  const initial = "models:\n  preferred: alpha\n";
  const next = "models:\n  preferred: beta\n";
  await writeFile(path, initial, { mode: 0o600 });
  const settings = { prepareDocument: async () => path };

  try {
    const loaded = await readSettingsDocument(settings);
    assert.equal(loaded.content, initial);
    const saved = await replaceSettingsDocument(settings, next, loaded.revision);
    assert.deepEqual(saved.conflict, false);
    assert.equal(await readFile(path, "utf8"), next);

    const stale = await replaceSettingsDocument(settings, initial, loaded.revision);
    assert.equal(stale.conflict, true);
    assert.equal(await readFile(path, "utf8"), next);

    await assert.rejects(() => replaceSettingsDocument(settings, "models: [\n", saved.revision));
    assert.equal(await readFile(path, "utf8"), next);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
