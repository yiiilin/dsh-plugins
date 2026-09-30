import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSettingsDocument,
  replaceSettingsDocument,
  SETTINGS_EDITOR_DOCUMENT_PATH,
  MAX_SETTINGS_DOCUMENT_BYTES,
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

test("writes modern profile patch documents without evaluating JavaScript tags", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dsh-profile-editor-"));
  const path = join(directory, "cordis.patch.yml");
  const initial = "- id: fixture\n  config:\n    enabled: false\n";
  const next = "- id: fixture\n  config:\n    expression: !!js ctx.webStartup.port\n";
  await writeFile(path, initial, { mode: 0o600 });
  const settings = { prepareDocument: async () => path, configure() {} };
  try {
    const loaded = await readSettingsDocument(settings);
    assert.equal(loaded.filename, "cordis.patch.yml");
    const saved = await replaceSettingsDocument(settings, next, loaded.revision);
    assert.equal(saved.conflict, false);
    assert.equal(await readFile(path, "utf8"), next);
    assert.equal(validateSettingsDocument(next, "patch")[0].config.expression, "ctx.webStartup.port");
    assert.throws(() => validateSettingsDocument("fixture: {}\n", "patch"));
    assert.throws(() => validateSettingsDocument("- not a patch object\n", "patch"));
    await assert.rejects(() => replaceSettingsDocument(settings, "- id: [\n", saved.revision));
    assert.equal(await readFile(path, "utf8"), next);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses invalid providers, revisions, and oversized documents", async () => {
  assert.throws(() => validateSettingsDocument(42));
  assert.throws(() => validateSettingsDocument("42\n"));
  assert.deepEqual(validateSettingsDocument(""), {});
  assert.deepEqual(validateSettingsDocument("", "patch"), []);
  await assert.rejects(() => readSettingsDocument(undefined));
  await assert.rejects(() => readSettingsDocument({ prepareDocument: async () => "" }));
  const directory = await mkdtemp(join(tmpdir(), "dsh-editor-limits-"));
  const path = join(directory, "settings.yaml");
  const initial = "models: {}\n";
  const settings = { documentPath: path };
  try {
    await writeFile(path, initial);
    const loaded = await readSettingsDocument(settings);
    await assert.rejects(() => readSettingsDocument({ documentPath: directory }));
    await assert.rejects(() => replaceSettingsDocument(settings, 42, loaded.revision));
    await assert.rejects(() => replaceSettingsDocument(settings, initial, "invalid"));
    const oversized = "x".repeat(MAX_SETTINGS_DOCUMENT_BYTES + 1);
    await assert.rejects(() => replaceSettingsDocument(settings, oversized, loaded.revision), RangeError);
    assert.equal(await readFile(path, "utf8"), initial);
    await writeFile(path, oversized);
    await assert.rejects(() => readSettingsDocument(settings), RangeError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    assert.equal(loaded.filename, "settings.yaml");
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
