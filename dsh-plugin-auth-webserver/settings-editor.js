import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import yaml from "js-yaml";

export const SETTINGS_EDITOR_EVENT = "dsh-auth-open-settings-editor";
export const SETTINGS_EDITOR_DOCUMENT_PATH = "/_dsh/auth-webserver/settings-editor/document";

const SETTINGS_OPEN_DOCUMENT_BLOCK = /const response = await this\.api\.settings\.openDocument\(\{\}\);\s*if \(!response\.result\.ok\) throw new Error\(response\.result\.error\.message\);/u;
const REVISION_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const MAX_SETTINGS_DOCUMENT_BYTES = 1024 * 1024;

/**
 * Rewire the stock Settings action only through the auth gateway. The matching
 * file-explorer client owns the overlay and calls preventDefault(), so local
 * DSH pages retain native opening while remote pages never navigate away.
 */
export function patchSettingsGeneralClient(source) {
  if (typeof source !== "string" || !SETTINGS_OPEN_DOCUMENT_BLOCK.test(source)) return null;
  let patched = source.replace(
    SETTINGS_OPEN_DOCUMENT_BLOCK,
    `const settingsEditorEvent = new CustomEvent("${SETTINGS_EDITOR_EVENT}", { cancelable: true });\n\t\t\t\t\tglobalThis.dispatchEvent(settingsEditorEvent);\n\t\t\t\t\tif (!settingsEditorEvent.defaultPrevented) throw new Error("settings-editor-unavailable");\n\t\t\t\t\treturn;`,
  );
  patched = patched.replace(
    '"openDocument": "打开配置文件",',
    '"openDocument": "在应用内编辑配置文件",',
  );
  patched = patched.replace(
    '"openDocument.error": "无法打开配置文件",',
    '"openDocument.error": "无法打开内嵌配置编辑器",',
  );
  patched = patched.replace(
    '"openDocument": "Open configuration file",',
    '"openDocument": "Edit configuration file",',
  );
  patched = patched.replace(
    '"openDocument.error": "Could not open configuration file",',
    '"openDocument.error": "Could not open the in-app configuration editor",',
  );
  return patched;
}

/** Reject malformed documents before replacing the live settings file. */
export function validateSettingsDocument(content) {
  if (typeof content !== "string") throw new TypeError("settings document content must be text");
  let value;
  try {
    value = yaml.load(content, { json: false, maxAliasCount: 100 });
  } catch {
    throw new TypeError("settings document is not valid YAML");
  }
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("settings document must be a YAML mapping");
  }
  return value;
}

function assertSettingsDocumentText(content) {
  if (Buffer.byteLength(content, "utf8") > MAX_SETTINGS_DOCUMENT_BYTES) {
    throw new RangeError(`settings document exceeds ${String(MAX_SETTINGS_DOCUMENT_BYTES)} bytes`);
  }
}

async function settingsDocumentPath(settings) {
  if (settings === undefined || settings === null) {
    throw new Error("settings service is unavailable");
  }
  const prepared = typeof settings.prepareDocument === "function"
    ? await settings.prepareDocument()
    : settings.documentPath;
  if (typeof prepared !== "string" || prepared === "") {
    throw new Error("settings provider has no local document");
  }
  return prepared;
}

async function readSettingsDocumentFile(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile()) throw new Error("settings document must be a regular file");
  if (metadata.size > MAX_SETTINGS_DOCUMENT_BYTES) {
    throw new RangeError(`settings document exceeds ${String(MAX_SETTINGS_DOCUMENT_BYTES)} bytes`);
  }
  const content = await readFile(path, "utf8");
  assertSettingsDocumentText(content);
  return content;
}

export function settingsDocumentRevision(content) {
  return createHash("sha256").update(content, "utf8").digest("base64url");
}

/** Read the file-backed settings document as one revisioned browser-editor value. */
export async function readSettingsDocument(settings) {
  const path = await settingsDocumentPath(settings);
  const content = await readSettingsDocumentFile(path);
  return { content, revision: settingsDocumentRevision(content) };
}

/**
 * Replace the settings document only when the browser still holds its current
 * content revision. The same lock and atomic-replace primitives as the file
 * settings provider prevent a raw-document edit from racing a settings API
 * write.
 */
export async function replaceSettingsDocument(settings, content, expectedRevision) {
  if (typeof content !== "string") throw new TypeError("settings document content must be text");
  assertSettingsDocumentText(content);
  validateSettingsDocument(content);
  if (typeof expectedRevision !== "string" || !REVISION_PATTERN.test(expectedRevision)) {
    throw new TypeError("settings document revision is invalid");
  }
  const path = await settingsDocumentPath(settings);
  return withFileLock(path, async () => {
    const current = await readSettingsDocumentFile(path);
    const currentRevision = settingsDocumentRevision(current);
    if (currentRevision !== expectedRevision) {
      return { conflict: true, revision: currentRevision };
    }
    await writeFileAtomic(path, content, { mode: 0o600, dirMode: 0o700 });
    return { conflict: false, revision: settingsDocumentRevision(content) };
  });
}
