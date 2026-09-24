import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLIENT_SOURCE = readFileSync(fileURLToPath(new URL("../client.js", import.meta.url)), "utf8");
const PACKAGE_SOURCE = readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8");

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

test("declares the settings plugin Slot dependencies", () => {
  assert.match(PACKAGE_SOURCE, /@deepseek-ai\/dsh-client-ui-settings-plugins/u);
  // The official `settings.plugins.tab` page is the only settings surface: the
  // collapsible item cards would unfold a row instead of opening the page.
  assert.doesNotMatch(CLIENT_SOURCE, /registerSettingsCard\("settings\.plugin\.item"\)/u);
  assert.doesNotMatch(CLIENT_SOURCE, /registerSettingsCard\("plugins\.item"\)/u);
  assert.match(CLIENT_SOURCE, /const profileForms = ctx\.get\("configForms"\)/u);
  assert.match(CLIENT_SOURCE, /if \(profileForms !== undefined\) registerSettingsCard\("settings\.plugins\.tab"\)/u);
  assert.match(CLIENT_SOURCE, /const changed = meta !== null/u);
  assert.match(CLIENT_SOURCE, /key: "auth-webserver"/u);
  assert.match(CLIENT_SOURCE, /id: "auth-webserver"/u);
});

test("describes credentials without binding storage to settings.yaml", () => {
  const hints = [...CLIENT_SOURCE.matchAll(/"hint\.credentials": "([^"]+)"/gu)].map((match) => match[1]);
  assert.equal(hints.length, 2);
  assert.ok(hints.every((hint) => !hint.includes("settings.yaml")));
  assert.ok(hints.some((hint) => hint.includes("由 DSH 设置管理")));
  assert.ok(hints.some((hint) => hint.includes("Managed by DSH settings")));
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
    "daw-settingsEditorInline",
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

test("lists online clients below the passkey and two-factor sections", () => {
  const clients = CLIENT_SOURCE.indexOf('{ className: "daw-clients"');
  const passkeys = CLIENT_SOURCE.indexOf('{ className: "daw-passkeys"');
  const twoFactor = CLIENT_SOURCE.indexOf('{ className: "daw-twoFactor"');
  const footer = CLIENT_SOURCE.indexOf('{ className: "daw-cardFooter" }');
  assert.notEqual(clients, -1, "the clients section must exist");
  assert.notEqual(passkeys, -1, "the passkeys section must exist");
  assert.ok(passkeys < clients, "passkeys render above the client list");
  assert.ok(twoFactor < clients, "two-factor renders above the client list");
  assert.ok(clients < footer, "the client list stays above the card footer");
});

test("names the cause of a failed passkey operation", () => {
  // A transport the browser or the gateway refuses, and wrong step-up
  // credentials, all used to collapse into the generic retry line.
  assert.ok(CLIENT_SOURCE.includes("window.isSecureContext === false"));
  assert.ok(CLIENT_SOURCE.includes('t("passkeys.insecure")'));
  assert.ok(CLIENT_SOURCE.includes('t("passkeys.credentials")'));
  assert.ok(CLIENT_SOURCE.includes("function passkeyFailureMessage"));
  assert.ok(CLIENT_SOURCE.includes("function httpFailure"));
});

test("edits the session lifetimes through localized, step-up-required fields", () => {
  for (const key of [
    "sessionLifetime.title",
    "sessionLifetime.description",
    "sessionLifetime.idle",
    "sessionLifetime.idleHint",
    "sessionLifetime.maxAge",
    "sessionLifetime.maxAgeHint",
    "sessionLifetime.effective",
    "sessionLifetime.unknown",
    "sessionLifetime.stepUp",
    "sessionLifetime.fromConfig",
  ]) {
    assert.ok(CLIENT_SOURCE.includes(`t("${key}"`), `${key} must be read through the locale helper`);
  }
  // Zero means something different per field, so each passes its own wording.
  assert.match(CLIENT_SOURCE, /lifetimeText\(t, meta\.idleSeconds, "sessionLifetime\.disabled"\)/u);
  assert.match(CLIENT_SOURCE, /lifetimeText\(t, meta\.maxAgeSeconds, "sessionLifetime\.unlimited"\)/u);
  // A host that reports no lifetimes gets no control, rather than empty fields.
  assert.match(CLIENT_SOURCE, /const lifetimeAvailable = meta !== null/u);
  assert.match(CLIENT_SOURCE, /lifetimeAvailable\n\t*\? React\.createElement/u);
  // Both values ride the existing save call, and a lifetime edit demands the
  // same step-up credentials a password change does.
  assert.match(CLIENT_SOURCE, /payload\.sessionIdleTimeoutSeconds = idleInput/u);
  assert.match(CLIENT_SOURCE, /payload\.sessionMaxAgeSeconds = maxAgeInput/u);
  assert.match(CLIENT_SOURCE, /if \(password !== "" \|\| lifetimeChanged\)/u);
  assert.match(CLIENT_SOURCE, /\|\| password !== "" \|\| lifetimeChanged\n/u);
  assert.match(CLIENT_SOURCE, /function lifetimeText\(t, seconds, zeroKey\)/u);
});
