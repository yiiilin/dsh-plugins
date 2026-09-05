import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLIENT_SOURCE = readFileSync(fileURLToPath(new URL("../client.js", import.meta.url)), "utf8");

function dictionaryKeys(name, endMarker) {
  const start = CLIENT_SOURCE.indexOf(`const ${name} = {`);
  assert.notEqual(start, -1, `${name} dictionary must exist`);
  const end = CLIENT_SOURCE.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${name} dictionary must have a boundary`);
  const block = CLIENT_SOURCE.slice(start, end);
  return new Set([...block.matchAll(/^\s*(?:"([^"]+)"|([A-Za-z_$][\w.$]*))\s*:/gmu)]
    .map((match) => match[1] ?? match[2]));
}

test("keeps the zh/en dictionary key sets identical", () => {
  const zh = dictionaryKeys("ZH_DICT", "const EN_DICT");
  const en = dictionaryKeys("EN_DICT", "function applyParams");
  assert.deepEqual([...zh].sort(), [...en].sort());
});

test("declares the online-client and revoke contracts in the client bundle", () => {
  assert.match(CLIENT_SOURCE, /const ONLINE_CLIENTS_PATH = "\/_dsh\/auth-webserver\/clients";/u);
  assert.match(CLIENT_SOURCE, /const REVOKE_CLIENT_PATH = "\/_dsh\/auth-webserver\/clients\/revoke";/u);
  assert.match(CLIENT_SOURCE, /api\(ONLINE_CLIENTS_PATH\)/u);
  assert.match(CLIENT_SOURCE, /api\(REVOKE_CLIENT_PATH, \{ clientId: client\.id \}\)/u);
  assert.match(CLIENT_SOURCE, /data-auth-client-id/u);
});

test("preserves CSRF, current-session reload, and non-current refresh behavior", () => {
  assert.match(CLIENT_SOURCE, /X-DSH-CSRF/u);
  assert.match(CLIENT_SOURCE, /window\.location\.reload\(\)/u);
  assert.match(CLIENT_SOURCE, /if \(await refreshClients\(\)\) setNotice\(t\("notice\.clientRevoked"\)\)/u);
});

test("owns the settings editor overlay inside the Settings layer", () => {
  for (const token of [
    "dsh-auth-open-settings-editor",
    "/_dsh/auth-webserver/settings-editor/document",
    "settings.action",
    "settingsEditor.open",
    "daw-settingsEditorOverlay",
    "api(SETTINGS_EDITOR_DOCUMENT_PATH",
    "X-DSH-CSRF",
  ]) {
    assert.ok(CLIENT_SOURCE.includes(token), `auth client must include ${token}`);
  }
  assert.match(CLIENT_SOURCE, /id: "open-document"/u);
  assert.match(CLIENT_SOURCE, /priority: -1/u);
  assert.equal(CLIENT_SOURCE.includes('slots.inject("shell.overlay"'), false);
});


test("declares the passkey registration and revoke contracts", () => {
  assert.match(CLIENT_SOURCE, /const PASSKEYS_PATH = "\/_dsh\/auth-webserver\/passkeys";/u);
  assert.match(CLIENT_SOURCE, /const PASSKEY_REGISTER_OPTIONS_PATH = "\/_dsh\/auth-webserver\/passkeys\/register\/options";/u);
  assert.match(CLIENT_SOURCE, /const PASSKEY_REGISTER_VERIFY_PATH = "\/_dsh\/auth-webserver\/passkeys\/register\/verify";/u);
  assert.match(CLIENT_SOURCE, /const PASSKEY_REVOKE_PATH = "\/_dsh\/auth-webserver\/passkeys\/revoke";/u);
  assert.match(CLIENT_SOURCE, /api\(PASSKEYS_PATH\)/u);
  assert.match(CLIENT_SOURCE, /api\(PASSKEY_REGISTER_OPTIONS_PATH, \{ currentPassword, currentOtp \}\)/u);
  assert.match(CLIENT_SOURCE, /navigator\.credentials\.create\(\{ publicKey: publicKeyCreationOptions\(optionsData\.options\) \}\)/u);
  assert.match(CLIENT_SOURCE, /api\(PASSKEY_REGISTER_VERIFY_PATH, \{/u);
  assert.match(CLIENT_SOURCE, /challenge: optionsData\.challenge/u);
  assert.match(CLIENT_SOURCE, /response: serializeRegistrationCredential\(credential\)/u);
  assert.match(CLIENT_SOURCE, /name: passkeyName\.trim\(\)/u);
  assert.match(CLIENT_SOURCE, /api\(PASSKEY_REVOKE_PATH, \{/u);
  assert.match(CLIENT_SOURCE, /credentialId: passkey\.id/u);
});

test("serializes WebAuthn registration data as SimpleWebAuthn base64url JSON", () => {
  assert.match(CLIENT_SOURCE, /challenge: typeof value\.challenge === "string" \? decodeBase64url\(value\.challenge\)/u);
  assert.match(CLIENT_SOURCE, /id: typeof value\.user\.id === "string" \? decodeBase64url\(value\.user\.id\)/u);
  assert.match(CLIENT_SOURCE, /id: typeof entry\.id === "string" \? decodeBase64url\(entry\.id\)/u);
  assert.match(CLIENT_SOURCE, /rawId: encodeBase64url\(credential\.rawId\)/u);
  assert.match(CLIENT_SOURCE, /clientDataJSON: encodeBase64url\(response\.clientDataJSON\)/u);
  assert.match(CLIENT_SOURCE, /attestationObject: encodeBase64url\(response\.attestationObject\)/u);
  assert.match(CLIENT_SOURCE, /getClientExtensionResults\(\)/u);
});


test("renders all online-client metadata through localized keys", () => {
  for (const key of [
    "clients.title",
    "clients.created",
    "clients.lastSeen",
    "clients.address",
    "clients.userAgent",
    "clients.current",
    "clients.revoke",
    "clients.revoking",
    "clients.revokeAria",
  ]) {
    assert.ok(CLIENT_SOURCE.includes(`t("${key}"`), `${key} must be read through the locale helper`);
  }
});

test("renders passkey enrollment and metadata through localized keys", () => {
  for (const key of [
    "passkeys.title",
    "passkeys.description",
    "passkeys.loading",
    "passkeys.empty",
    "passkeys.error",
    "passkeys.cancelled",
    "passkeys.unsupported",
    "passkeys.name",
    "passkeys.namePlaceholder",
    "passkeys.add",
    "passkeys.registering",
    "passkeys.created",
    "passkeys.lastUsed",
    "passkeys.never",
    "passkeys.revoke",
    "passkeys.revoking",
    "passkeys.revokeAria",
    "notice.passkeyRegistered",
    "notice.passkeyRevoked",
  ]) {
    assert.ok(CLIENT_SOURCE.includes(`t("${key}"`), `${key} must be read through the locale helper`);
  }
});
