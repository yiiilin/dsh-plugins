import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSettingsDocument,
  replaceSettingsDocument,
  SETTINGS_EDITOR_DOCUMENT_PATH,
  validateSettingsDocument,
} from "../settings-editor.js";

test("keeps the document endpoint contract and transport protections", () => {
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
