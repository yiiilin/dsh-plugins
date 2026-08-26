/**
 * dsh-plugin-auth-webserver
 *
 * An auth-gated reverse proxy for the DSH web server.
 *
 * The stock `dsh web` server stays untouched and keeps listening on
 * 127.0.0.1:3080 (loopback, no auth). This bundle instead listens on every
 * non-loopback network interface address at the same port (e.g. 192.168.1.5:3080),
 * requires HTTP Basic Auth or an HMAC-signed login cookie (optionally protected
 * by TOTP), and proxies every accepted request — including WebSocket upgrades — to 127.0.0.1:3080.
 *
 * Credential precedence is DSH_AUTH_USER/DSH_AUTH_PASS (or AUTH_USER/AUTH_PASS)
 * > the settings user document (namespace `auth-webserver`, written by the GUI
 * card) > the cordis row config (the composed base layer). A legacy
 * state.json from older releases is migrated into the settings namespace once.
 */

import { createServer, request } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { generateTotpSecret, verifyTotp } from "./totp.js";

export const name = "auth-webserver";

// Hard dependency on the settings service: the GUI card and this plugin share
// one namespace ("auth-webserver"), so apply must wait until the service is
// up instead of reading it with ctx.get at an arbitrary boot moment.
export const inject = ["settings"];

const NS = settingsNamespace("auth-webserver");

const COOKIE_NAME = "dsh_auth_token";
const CSRF_COOKIE_NAME = "dsh_auth_csrf";
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 3600;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;
const STATE_DIR_SEGMENTS = ["plugins", "dsh-plugin-auth-webserver"];

// These files contain only install metadata and the public app icon. Keeping
// them reachable before login lets the browser discover the PWA entry point;
// all application HTML, APIs, assets, and WebSocket upgrades remain gated.
const PUBLIC_PWA_PATHS = new Set(["/manifest.webmanifest", "/favicon.svg"]);

function isPublicPwaRequest(req, rawPath) {
  return (req.method === "GET" || req.method === "HEAD") && PUBLIC_PWA_PATHS.has(rawPath);
}
function dshHome() {
  const env = process.env.DSH_HOME;
  if (env !== undefined && env.trim().length > 0) {
    const value = env.trim();
    if (value === "~") return homedir();
    if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
    return resolve(value);
  }
  return join(homedir(), ".dsh");
}

function stateDir() {
  return join(dshHome(), ...STATE_DIR_SEGMENTS);
}

/** Constant-time string comparison without leaking lengths through Node APIs. */
function safeEqual(left, right) {
  const a = createHmac("sha256", "dsh-auth-compare").update(String(left)).digest();
  const b = createHmac("sha256", "dsh-auth-compare").update(String(right)).digest();
  return timingSafeEqual(a, b);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const cookies = {};
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    const key = pair.slice(0, index).trim();
    let value = pair.slice(index + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // Keep the raw value; the auth check still treats it as invalid.
    }
    cookies[key] = value;
  }
  return cookies;
}

function stripGatewayCookies(header) {
  if (typeof header !== "string") return header;
  const kept = header.split(";").filter((part) => {
    const key = part.split("=", 1)[0].trim();
    return key !== COOKIE_NAME && key !== CSRF_COOKIE_NAME;
  });
  return kept.length > 0 ? kept.join(";") : undefined;
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function parseBasic(header) {
  if (typeof header !== "string") return null;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(header.trim());
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const index = decoded.indexOf(":");
  if (index === -1) return null;
  return {
    user: decoded.slice(0, index),
    pass: decoded.slice(index + 1),
  };
}

async function readBody(req, limit = 65536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export const Config = z.object({
  /** Port the gateway listens on for each non-loopback address. */
  port: z.natural().max(65535).default(3080),
  /** Upstream host the gateway proxies to (the stock DSH web server). */
  targetHost: z.string().default("127.0.0.1"),
  /** Upstream port the gateway proxies to. */
  targetPort: z.natural().max(65535).default(3080),
  /** Explicit bind addresses; when empty, all non-loopback NIC addresses are used. */
  addresses: z.array(z.string()).default([]),
  username: z.string().default("admin"),
  password: z.string().role("secret").default(""),
  realm: z.string().default("DeepSeek Harness Authentication"),
  /** Enable time-based one-time passwords for the LAN gateway. */
  twoFactorEnabled: z.boolean().default(false),
  /** Base32 TOTP secret. Keep this in a secret environment variable or settings secret. */
  twoFactorSecret: z.string().role("secret").default(""),
});

/**
 * The settings namespace schema. Password is a secret-role field: it never
 * rides a describe response, and the GUI card treats it as write-only.
 */
const SettingsSchema = z.object({
  username: z.string().min(1).default("admin"),
  password: z.string().role("secret").default(""),
  realm: z.string().min(1).default("DeepSeek Harness Authentication"),
  twoFactorEnabled: z.boolean().default(false),
  twoFactorSecret: z.string().role("secret").default(""),
  authEpoch: z.natural().default(0),
});

function stateFile() {
  return join(stateDir(), "state.json");
}

/**
 * One-time migration from the pre-settings state.json (written by older
 * releases of this plugin) into the auth-webserver settings namespace. Runs
 * only when the user document does not already carry credentials, so a
 * settings-level override made by the user is never clobbered. The legacy file
 * is left in place as a backup; later releases may drop it.
 */
function migrateLegacyState(ctx, settings, scope) {
  try {
    if (!existsSync(stateFile())) return;
    const descriptor = settings
      .describe({ redactSecrets: true })
      .find((entry) => entry.ns === NS);
    if (descriptor === undefined) return;
    const userHasCredential = (descriptor.user !== undefined &&
      Object.keys(descriptor.user).length > 0) ||
      (descriptor.secrets ?? []).some((entry) => entry.path?.[0] === "password" && entry.set);
    if (userHasCredential) return;
    const state = JSON.parse(readFileSync(stateFile(), "utf8"));
    if (state === null || typeof state !== "object") return;
    const next = {};
    if (typeof state.username === "string") next.username = state.username;
    if (typeof state.password === "string") next.password = state.password;
    if (typeof state.realm === "string") next.realm = state.realm;
    if (Object.keys(next).length === 0) return;
    void settings.update(NS, next, descriptor.revision).catch((error) => {
      ctx.logger?.warn?.("auth-webserver: legacy state migration failed: %s", error);
    });
  } catch {
    // Keep the old file untouched; env variables and row config still stand.
  }
}

function loadOrCreateSecret() {
  const file = join(stateDir(), ".secret");
  try {
    if (existsSync(file)) {
      const value = readFileSync(file, "utf8").trim();
      if (value) return value;
    }
    const secret = randomBytes(32).toString("hex");
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(file, secret, { encoding: "utf8", mode: 0o600 });
    return secret;
  } catch {
    // An ephemeral secret keeps the server usable when the home is read-only.
    return randomBytes(32).toString("hex");
  }
}

function pickAddresses(config) {
  const override = config.addresses.filter((entry) => typeof entry === "string" && entry.trim() !== "");
  if (override.length > 0) return override;
  const out = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.internal) continue;
      if (info.family === "IPv4" || info.family === 4) out.push(info.address);
    }
  }
  return out;
}

function renderLoginPage(realm, twoFactorEnabled = false) {
  const safeRealm = String(realm ?? "DeepSeek Harness Authentication")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const otpField = twoFactorEnabled ? `
    <label for="otp">Authenticator code</label>
    <input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
  ` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>DeepSeek Harness - Sign in</title>
  <style>
    :root { color-scheme: dark; --bg: #0a0d14; --panel: #121826; --line: #334155; --text: #e2e8f0; --muted: #94a3b8; --accent: #3b82f6; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; padding: 20px; }
    form { width: 100%; max-width: 360px; padding: 28px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
    h1 { margin: 0 0 6px; font-size: 20px; }
    p { margin: 0 0 22px; color: var(--muted); font-size: 13px; }
    label { display: block; margin: 12px 0 6px; font-size: 13px; color: var(--muted); }
    input { width: 100%; height: 40px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: #0b1120; color: var(--text); outline: none; }
    input:focus { border-color: var(--accent); }
    button { width: 100%; height: 42px; margin-top: 20px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font-weight: 600; cursor: pointer; }
    #error { display: none; margin-top: 14px; padding: 8px 10px; border-radius: 8px; background: rgba(239, 68, 68, 0.15); color: #f87171; font-size: 13px; }
  </style>
</head>
<body>
  <form id="login">
    <h1>DeepSeek Harness</h1>
    <p>${safeRealm}</p>
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" autofocus required>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
         ${otpField}
     <button type="submit">Sign in</button>
    <div id="error">Invalid username, password, or authenticator code</div>
  </form>
  <script>
    const form = document.getElementById("login");
    const error = document.getElementById("error");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.style.display = "none";
      const button = form.querySelector("button");
      button.disabled = true;
      try {
        const response = await fetch("/api/auth.login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: document.getElementById("username").value,
            password: document.getElementById("password").value,
             otp: document.getElementById("otp")?.value ?? ""
          })
        });
        const data = await response.json();
        if (data.ok) {
          window.location.reload();
        } else {
          error.style.display = "block";
          button.disabled = false;
        }
      } catch {
        error.style.display = "block";
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function sendUnauthorized(req, res, realm, rawPath, twoFactorEnabled = false) {
  const accept = req.headers.accept ?? "";
  const wantsHtml = rawPath === "/" || rawPath === "/index.html"
    || (req.method === "GET" && accept.includes("text/html"));
  if (wantsHtml) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(renderLoginPage(realm, twoFactorEnabled));
    return;
  }
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (!twoFactorEnabled) {
    headers["WWW-Authenticate"] = `Basic realm="${String(realm ?? "DeepSeek Harness Authentication").replace(/"/g, '\\"')}"`;
  }
  res.writeHead(401, headers);
  res.end(JSON.stringify({ ok: false, error: "Authentication required", twoFactorRequired: twoFactorEnabled }));
}

export function apply(ctx, config) {
  const secret = loadOrCreateSecret();
  let sessionGeneration = 0;
  const activeSockets = new Set();

  const revokeSessions = () => {
    sessionGeneration += 1;
    for (const socket of activeSockets) {
      try {
        socket.destroy();
      } catch (_e) {
        // Best-effort teardown during credential changes.
      }
    }
    activeSockets.clear();
  };

  // In non-secure contexts (plain http on a LAN address) `crypto.randomUUID`
  // does not exist, which breaks the DSH client RPC layer. The old replacement
  // webserver injected this polyfill into every index response itself; now the
  // stock webserver serves index, so register the polyfill as an index tap on
  // that service instead.
  const webServer = ctx.get("webServer");
  if (webServer !== undefined && typeof webServer.tapIndex === "function") {
    const frame = `<script data-dsh-auth-polyfill="1">(function(){var c=window.crypto||(window.crypto={});if(typeof c.randomUUID!=="function"){if(typeof c.getRandomValues==="function"){c.randomUUID=function(){return([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,function(x){return(x^c.getRandomValues(new Uint8Array(1))[0]&15>>x/4).toString(16)})}}else{c.randomUUID=function(){return"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(x){var r=Math.random()*16|0,v=x==="x"?r:(r&0x3|0x8);return v.toString(16)})}}}})();</script>`;
    ctx.effect(() => webServer.tapIndex((html) => {
      if (typeof html !== "string" || html.includes("dsh-auth-polyfill")) return html;
      if (html.includes("<head>")) return html.replace("<head>", `<head>${frame}`);
      return `${frame}${html}`;
    }));
  }

  // Settings namespace: the row config acts as the composed base layer and
  // the settings document (settings.yaml) overrides it; env vars outrank both
  // at read time. The GUI card reads/writes this namespace through the shared
  // settings service, so no plugin-specific state file is needed anymore.
  const settings = ctx.get("settings");
  let settingsScope;
  if (settings !== undefined) {
    settingsScope = settings.register(NS, SettingsSchema, {
      base: {
        ...(config.username !== undefined ? { username: config.username } : {}),
        ...(config.password !== undefined ? { password: config.password } : {}),
        ...(config.realm !== undefined ? { realm: config.realm } : {}),
        ...(config.twoFactorEnabled !== undefined ? { twoFactorEnabled: config.twoFactorEnabled } : {}),
        ...(config.twoFactorSecret !== undefined ? { twoFactorSecret: config.twoFactorSecret } : {}),
      },
      applies: "live",
    });
    migrateLegacyState(ctx, settings, settingsScope);
  }

  const envUser = process.env.DSH_AUTH_USER || process.env.AUTH_USER;
  const envPass = process.env.DSH_AUTH_PASS || process.env.AUTH_PASS;
  const envTwoFactorSecret = process.env.DSH_AUTH_2FA_SECRET || process.env.AUTH_2FA_SECRET;
  const rawEnvTwoFactorEnabled = process.env.DSH_AUTH_2FA_ENABLED ?? process.env.AUTH_2FA_ENABLED;
  const envTwoFactorEnabled = rawEnvTwoFactorEnabled === undefined
    ? undefined
    : /^(1|true|yes|on)$/i.test(String(rawEnvTwoFactorEnabled).trim());
  const resolved = () => {
    const value = settingsScope?.get() ?? {
      username: config.username,
      password: config.password,
      realm: config.realm,
      twoFactorEnabled: config.twoFactorEnabled,
      twoFactorSecret: config.twoFactorSecret,
      authEpoch: 0,
    };
    const twoFactorSecret = envTwoFactorSecret || value.twoFactorSecret || "";
    const twoFactorEnabled = envTwoFactorEnabled ?? (Boolean(value.twoFactorEnabled) || Boolean(envTwoFactorSecret));
    return { ...value, twoFactorEnabled, twoFactorSecret };
  };
  const description = () => settings
    ?.describe({ redactSecrets: true })
    .find((entry) => entry.ns === NS);
  const userLayerHasField = (descriptor, field) =>
    (descriptor?.user !== undefined && Object.prototype.hasOwnProperty.call(descriptor.user, field)) ||
    (descriptor?.secrets ?? []).some((entry) => entry.path?.[0] === field && entry.set);
  const userLayerHasCredential = (descriptor) =>
    userLayerHasField(descriptor, "username") || userLayerHasField(descriptor, "password");
  const snapshot = () => {
    const value = resolved();
    const descriptor = description();
    return {
      username: value.username || "admin",
      realm: value.realm || "DeepSeek Harness Authentication",
      hasPassword: Boolean(envPass || value.password),
      overriddenByEnv: Boolean(envUser || envPass),
      overriddenByConfig: Boolean(config.username || config.password),
      overriddenBySettings: userLayerHasCredential(descriptor),
      twoFactorEnabled: Boolean(value.twoFactorEnabled),
      hasTwoFactorSecret: Boolean(value.twoFactorSecret),
      twoFactorOverriddenByEnv: rawEnvTwoFactorEnabled !== undefined || Boolean(envTwoFactorSecret),
      twoFactorOverriddenByConfig: Boolean(config.twoFactorEnabled || config.twoFactorSecret),
      twoFactorOverriddenBySettings: userLayerHasField(descriptor, "twoFactorEnabled") || userLayerHasField(descriptor, "twoFactorSecret"),
    };
  };

  const updateSettingsAndRevoke = async (next) => {
    const currentEpoch = Number.isSafeInteger(resolved().authEpoch) ? resolved().authEpoch : 0;
    await settings.update(NS, {
      ...next,
      authEpoch: currentEpoch + 1,
    }, description()?.revision);
    revokeSessions();
  };

  const handleState = (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    sendJson(res, 200, { ok: true, state: snapshot() });
  };

  const handleSave = async (req, res) => {
    if (requireSession(req, res) === null) return;
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    if (settings === undefined || !settings.writable) {
      sendJson(res, 400, {
        ok: false,
        error: "settings are not writable in this deployment",
      });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid request body" });
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: "Invalid request body" });
      return;
    }

    const next = {};
    if (typeof body.username === "string") {
      if (body.username.trim() === "") {
        sendJson(res, 400, { ok: false, error: "Username must not be empty" });
        return;
      }
      next.username = body.username.trim();
    }
    // Password changes require a step-up check in addition to the session and CSRF token.
    if (typeof body.password === "string" && body.password !== "") {
      const current = credentials();
      const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
      if (!safeEqual(currentPassword, current.pass) ||
        (current.twoFactorEnabled && !consumeTotp(current.twoFactorSecret, body.currentOtp))) {
        sendJson(res, 403, { ok: false, error: "Current password and authenticator code are required" });
        return;
      }
      next.password = body.password;
    }
    if (typeof body.realm === "string" && body.realm.trim() !== "") {
      next.realm = body.realm.trim();
    }

    if (Object.keys(next).length === 0) {
      sendJson(res, 200, { ok: true, state: snapshot() });
      return;
    }

    try {
      await updateSettingsAndRevoke(next);
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    sendJson(res, 200, { ok: true, state: snapshot() });
  };

  const handleTwoFactorSetup = async (req, res) => {
    if (requireSession(req, res) === null) return;
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    if (settings === undefined || !settings.writable) {
      sendJson(res, 400, {
        ok: false,
        error: "settings are not writable in this deployment",
      });
      return;
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid request body" });
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: "Invalid request body" });
      return;
    }

    const action = typeof body.action === "string" ? body.action : "";
    const current = resolved();
    const environmentControlsTwoFactor = rawEnvTwoFactorEnabled !== undefined || Boolean(envTwoFactorSecret);
    if (environmentControlsTwoFactor) {
      sendJson(res, 400, {
        ok: false,
        error: "2FA is controlled by AUTH_2FA_* environment variables",
      });
      return;
    }

    if (action === "verify" || action === "disable") {
      const currentCredentials = credentials();
      if (!currentCredentials.pass) {
        sendJson(res, 400, { ok: false, error: "Set a gateway password before enabling 2FA" });
        return;
      }
      const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
      if (!safeEqual(currentPassword, currentCredentials.pass)) {
        sendJson(res, 403, { ok: false, error: "Current password is required" });
        return;
      }
      if (current.twoFactorEnabled && !verifyTotp(current.twoFactorSecret, body.currentOtp)) {
        sendJson(res, 403, { ok: false, error: "Current authenticator code is required" });
        return;
      }
    }

    if (action === "start") {
      const secretValue = generateTotpSecret();
      const issuer = "DeepSeek Harness";
      const label = `${issuer}:${current.username || "admin"}`;
      const otpauthUrl = `otpauth://totp/${encodeURIComponent(label)}?secret=${secretValue}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
      sendJson(res, 200, {
        ok: true,
        setup: { secret: secretValue, otpauthUrl },
      });
      return;
    }

    if (action !== "verify" && action !== "disable") {
      sendJson(res, 400, { ok: false, error: "Unknown 2FA action" });
      return;
    }

    if (action === "verify") {
      const secretValue = typeof body.secret === "string"
        ? body.secret.trim().toUpperCase().replace(/[\s-]/g, "")
        : "";
      if (!consumeTotp(secretValue, body.code)) {
        sendJson(res, 400, { ok: false, error: "Invalid authenticator code" });
        return;
      }
      if (current.twoFactorEnabled && !consumeTotp(current.twoFactorSecret, body.currentOtp)) {
        sendJson(res, 403, { ok: false, error: "Current authenticator code is required" });
        return;
      }
      try {
        await updateSettingsAndRevoke({
          twoFactorEnabled: true,
          twoFactorSecret: secretValue,
        });
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      sendJson(res, 200, { ok: true, state: snapshot() });
      return;
    }

    if (current.twoFactorEnabled && !consumeTotp(current.twoFactorSecret, body.currentOtp)) {
      sendJson(res, 403, { ok: false, error: "Current authenticator code is required" });
      return;
    }
    try {
      await updateSettingsAndRevoke({
        twoFactorEnabled: false,
        twoFactorSecret: "",
      });
    } catch (error) {
      sendJson(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    sendJson(res, 200, { ok: true, state: snapshot() });
  };

  if (webServer !== undefined && typeof webServer.register === "function") {
    ctx.effect(() => webServer.register({ kind: "exact", path: "/_dsh/auth-webserver/state", handler: handleState }));
    ctx.effect(() => webServer.register({ kind: "exact", path: "/_dsh/auth-webserver/save", handler: handleSave }));
    ctx.effect(() => webServer.register({ kind: "exact", path: "/_dsh/auth-webserver/2fa", handler: handleTwoFactorSetup }));
  }


  const credentials = () => {
    const value = resolved();
    return {
      user: process.env.DSH_AUTH_USER || process.env.AUTH_USER || value.username || "admin",
      pass: process.env.DSH_AUTH_PASS || process.env.AUTH_PASS || value.password || "",
      realm: value.realm || "DeepSeek Harness Authentication",
      twoFactorEnabled: Boolean(value.twoFactorEnabled),
      twoFactorSecret: value.twoFactorSecret || "",
      authEpoch: Number.isSafeInteger(value.authEpoch) ? value.authEpoch : 0,
    };
  };

  const tokenFactor = (twoFactorEnabled, twoFactorSecret) =>
    twoFactorEnabled ? `mfa\u0000${twoFactorSecret}` : "pwd";
  const generateToken = (user, pass, authEpoch, twoFactorEnabled, twoFactorSecret) => {
    const now = Date.now();
    const signature = createHmac("sha256", secret)
      .update(`${user}\u0000${pass}\u0000${authEpoch}\u0000${sessionGeneration}\u0000${tokenFactor(twoFactorEnabled, twoFactorSecret)}\u0000${now}`)
      .digest("hex");
    return `${now}.${signature}`;
  };

  const csrfForToken = (token) => createHmac("sha256", secret)
    .update(`csrf\u0000${token}`)
    .digest("base64url");

  const verifyToken = (token, user, pass, authEpoch, twoFactorEnabled, twoFactorSecret) => {
    if (typeof token !== "string") return false;
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    const timestamp = Number(parts[0]);
    if (!Number.isFinite(timestamp)) return false;
    const age = Date.now() - timestamp;
    if (age < -60000 || age > SESSION_MAX_AGE_MS) return false;
    const expected = createHmac("sha256", secret)
      .update(`${user}\u0000${pass}\u0000${authEpoch}\u0000${sessionGeneration}\u0000${tokenFactor(twoFactorEnabled, twoFactorSecret)}\u0000${timestamp}`)
      .digest();
    let actual;
    try {
      actual = Buffer.from(parts[1], "hex");
    } catch {
      return false;
    }
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  };

  const usedTotpCodes = new Map();
  const normalizeOtp = (value) => typeof value === "string" ? value.replace(/[\s-]/g, "") : "";
  const consumeTotp = (secretValue, submitted) => {
    const code = normalizeOtp(submitted);
    if (!verifyTotp(secretValue, code)) return false;
    const now = Date.now();
    for (const [key, expiresAt] of usedTotpCodes) {
      if (expiresAt <= now) usedTotpCodes.delete(key);
    }
    const key = `${secretValue}:${code}`;
    if ((usedTotpCodes.get(key) ?? 0) > now) return false;
    usedTotpCodes.set(key, now + 90_000);
    return true;
  };

  const loginAttempts = new Map();
  const LOGIN_WINDOW_MS = 60_000;
  const LOGIN_MAX_ATTEMPTS = 10;
  const loginAttemptKey = (req, username) => `${req.socket?.remoteAddress ?? "unknown"}:${username}`;
  const loginRateLimited = (req, username) => {
    const key = loginAttemptKey(req, username);
    const current = loginAttempts.get(key);
    const now = Date.now();
    if (current === undefined || current.expiresAt <= now) {
      loginAttempts.delete(key);
      return false;
    }
    return current.count >= LOGIN_MAX_ATTEMPTS;
  };
  const noteLoginFailure = (req, username) => {
    const key = loginAttemptKey(req, username);
    const now = Date.now();
    const current = loginAttempts.get(key);
    if (current === undefined || current.expiresAt <= now) {
      loginAttempts.set(key, { count: 1, expiresAt: now + LOGIN_WINDOW_MS });
      return;
    }
    current.count += 1;
  };
  const clearLoginFailures = (req, username) => {
    loginAttempts.delete(loginAttemptKey(req, username));
  };

  const authenticateRequest = (req) => {
    const { user, pass, twoFactorEnabled, twoFactorSecret, authEpoch } = credentials();
    if (!pass) return null;

    const cookies = parseCookies(req);
    const token = cookies[COOKIE_NAME];
    if (token && verifyToken(token, user, pass, authEpoch, twoFactorEnabled, twoFactorSecret)) {
      return { kind: "cookie", csrf: csrfForToken(token) };
    }

    // Basic Auth cannot carry a second factor and is deliberately disabled when
    // TOTP is active. Use the password + OTP login endpoint to obtain a cookie.
    if (twoFactorEnabled) return null;
    const basic = parseBasic(req.headers.authorization);
    if (basic && safeEqual(basic.user, user) && safeEqual(basic.pass, pass)) {
      return { kind: "basic", csrf: null };
    }
    return null;
  };

  const checkAuth = (req) => authenticateRequest(req) !== null;

  const requireSession = (req, res) => {
    const auth = authenticateRequest(req);
    if (auth === null || auth.kind !== "cookie") {
      if (isLoopbackAddress(req.socket?.remoteAddress)) return { kind: "local", csrf: null };
      sendJson(res, 403, { ok: false, error: "A browser login session is required" });
      return null;
    }
    const cookies = parseCookies(req);
    const header = req.headers["x-dsh-csrf"];
    const submitted = Array.isArray(header) ? header[0] : header;
    if (!cookies[CSRF_COOKIE_NAME] || typeof submitted !== "string" ||
      !safeEqual(cookies[CSRF_COOKIE_NAME], auth.csrf) || !safeEqual(submitted, auth.csrf)) {
      sendJson(res, 403, { ok: false, error: "CSRF validation failed" });
      return null;
    }
    return auth;
  };

  const handleLogin = async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
      return;
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Invalid request body" }));
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Invalid request body" }));
      return;
    }

    const { user, pass, twoFactorEnabled, twoFactorSecret, authEpoch } = credentials();
    const submittedUser = typeof body.username === "string" ? body.username : "";
    const submittedPass = typeof body.password === "string" ? body.password : "";
    if (loginRateLimited(req, submittedUser)) {
      res.writeHead(429, {
        "Content-Type": "application/json; charset=utf-8",
        "Retry-After": "60",
      });
      res.end(JSON.stringify({ ok: false, error: "Too many login attempts" }));
      return;
    }
    const passwordValid = Boolean(pass) && safeEqual(submittedUser, user) && safeEqual(submittedPass, pass);
    const otpValid = !twoFactorEnabled || (passwordValid && consumeTotp(twoFactorSecret, body.otp));
    if (!passwordValid || !otpValid) {
      noteLoginFailure(req, submittedUser);
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: "Invalid username, password, or authenticator code" }));
      return;
    }
    clearLoginFailures(req, submittedUser);

    const token = generateToken(user, pass, authEpoch, twoFactorEnabled, twoFactorSecret);
    const csrf = csrfForToken(token);
    const secure = req.socket?.encrypted ? "; Secure" : "";
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": [
        `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`,
        `${CSRF_COOKIE_NAME}=${csrf}; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`,
      ],
    });
    res.end(JSON.stringify({ ok: true, username: user }));
  };

  const handleLogout = (req, res) => {
    if (authenticateRequest(req) !== null) revokeSessions();
    const secure = req.socket?.encrypted ? "; Secure" : "";
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": [
        `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
        `${CSRF_COOKIE_NAME}=; Path=/; SameSite=Lax; Max-Age=0${secure}`,
      ],
    });
    res.end(JSON.stringify({ ok: true }));
  };

  const targetHost = config.targetHost;
  const targetPort = config.targetPort;
  const CONNECTION_CLIENT_PATH = "/plugins/@deepseek-ai/dsh-client-connection/client.js";
  const LOOPBACK_ASSIGNMENT = /isLoopback:\s*pageLocation\s*===\s*void 0\s*\|\|\s*isLoopbackHostname\(pageLocation\.hostname\)/;
  let connectionPatchWarned = false;

  const patchConnectionClient = (source) => {
    const patched = source.replace(LOOPBACK_ASSIGNMENT, "isLoopback: true");
    if (patched === source && !connectionPatchWarned) {
      connectionPatchWarned = true;
      ctx.logger?.warn?.("auth-webserver: official connection client marker was not found; LAN settings patch was not applied");
    }
    return patched;
  };

  const proxyRequest = (req, res) => {
    const rawPath = new URL(req.url ?? "/", "http://x").pathname;
    const shouldPatchConnectionClient = req.method === "GET" && rawPath === CONNECTION_CLIENT_PATH;
    const headers = { ...req.headers };
    delete headers.authorization;
    delete headers["x-dsh-otp"];
    delete headers["x-dsh-csrf"];
    if (headers.cookie !== undefined) {
      headers.cookie = stripGatewayCookies(headers.cookie);
      if (headers.cookie === undefined) delete headers.cookie;
    }
    if (shouldPatchConnectionClient) headers["accept-encoding"] = "identity";
    // Hop-by-hop request headers must not be forwarded to the upstream.
    for (const h of ["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]) {
      delete headers[h];
    }
    headers.host = `${targetHost}:${targetPort}`;
    // The upstream API guard accepts a request only when its Origin matches
    // the (rewritten) Host header, so a LAN Origin must be rewritten too —
    // otherwise every stateful /api call comes back 403 from the stock server.
    if (headers.origin !== undefined) {
      headers.origin = `http://${targetHost}:${targetPort}`;
    }
    const remote = req.socket?.remoteAddress;
    if (remote) {
      headers["x-forwarded-for"] = headers["x-forwarded-for"]
        ? `${headers["x-forwarded-for"]}, ${remote}`
        : remote;
    }

    const proxyReq = request({
      hostname: targetHost,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers,
    }, (proxyRes) => {
      const resHeaders = { ...proxyRes.headers };
      for (const h of ["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]) {
        delete resHeaders[h];
      }
      if (!shouldPatchConnectionClient || proxyRes.statusCode !== 200) {
        res.writeHead(proxyRes.statusCode, resHeaders);
        proxyRes.pipe(res);
        return;
      }
      const chunks = [];
      proxyRes.on("data", (chunk) => chunks.push(chunk));
      proxyRes.on("end", () => {
        const source = Buffer.concat(chunks).toString("utf8");
        const body = patchConnectionClient(source);
        delete resHeaders["content-encoding"];
        delete resHeaders["content-length"];
        delete resHeaders.etag;
        resHeaders["cache-control"] = "no-store";
        resHeaders["content-length"] = Buffer.byteLength(body);
        res.writeHead(proxyRes.statusCode, resHeaders);
        res.end(body);
      });
      proxyRes.on("error", () => {
        if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "upstream connection client response failed" }));
      });
    });
    proxyReq.on("error", (error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: `upstream unreachable: ${error.code ?? error.message}` }));
    });
    req.pipe(proxyReq);
  };

  const proxyUpgrade = (req, socket, head) => {
    const headers = { ...req.headers };
    delete headers.authorization;
    delete headers["x-dsh-otp"];
    delete headers["x-dsh-csrf"];
    if (headers.cookie !== undefined) {
      headers.cookie = stripGatewayCookies(headers.cookie);
      if (headers.cookie === undefined) delete headers.cookie;
    }
    headers.host = `${targetHost}:${targetPort}`;
    if (headers.origin) headers.origin = `http://${targetHost}:${targetPort}`;
    const proxyReq = request({
      hostname: targetHost,
      port: targetPort,
      path: req.url,
      method: "GET",
      headers,
    });
    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      const statusMessage = proxyRes.statusMessage || "Switching Protocols";
      // A 101 response is only valid for the browser when it carries the
      // Connection/Upgrade hop-by-hop headers, so re-add them explicitly.
      const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${statusMessage}`];
      lines.push(`Upgrade: ${proxyRes.headers.upgrade ?? "websocket"}`);
      lines.push("Connection: Upgrade");
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (key.toLowerCase() === "connection" || key.toLowerCase() === "upgrade") continue;
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${key}: ${item}`);
        } else {
          lines.push(`${key}: ${value}`);
        }
      }
      lines.push("", "");
      socket.write(lines.join("\r\n"));
     activeSockets.add(socket);
       const removeSocket = () => activeSockets.delete(socket);
       socket.once("close", removeSocket);
       proxySocket.once("close", removeSocket);
       if (proxyHead && proxyHead.length) socket.write(proxyHead);
      proxySocket.pipe(socket).pipe(proxySocket);
    });
    // Upstream refused the upgrade (e.g. 403): relay that response instead of
    // leaving the browser socket hanging without a handshake answer.
    proxyReq.on("response", (proxyRes) => {
      const statusMessage = proxyRes.statusMessage || "";
      const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${statusMessage}`.trimEnd()];
      for (const [key, value] of Object.entries(proxyRes.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${key}: ${item}`);
        } else {
          lines.push(`${key}: ${value}`);
        }
      }
      lines.push("", "");
      socket.write(lines.join("\r\n"));
      proxyRes.pipe(socket);
    });
    proxyReq.on("error", () => {
      socket.destroy();
    });
    proxyReq.end();
  };

  const servers = [];
  const addresses = pickAddresses(config);
  if (addresses.length === 0) {
    ctx.logger?.warn?.("auth-webserver: no non-loopback network addresses found; LAN gateway is idle");
  }

  for (const address of addresses) {
    const server = createServer((req, res) => {
      const rawPath = new URL(req.url ?? "/", "http://x").pathname;
      if (rawPath === "/api/auth.login") {
        handleLogin(req, res);
        return;
      }
      if (rawPath === "/api/auth.logout") {
        handleLogout(req, res);
        return;
      }
      if (rawPath === "/_dsh/auth-webserver/state" ||
        rawPath === "/_dsh/auth-webserver/save" ||
        rawPath === "/_dsh/auth-webserver/2fa") {
        if (!checkAuth(req)) {
          sendUnauthorized(req, res, credentials().realm, rawPath, credentials().twoFactorEnabled);
          return;
        }
        if (rawPath === "/_dsh/auth-webserver/state") handleState(req, res);
        else if (rawPath === "/_dsh/auth-webserver/save") handleSave(req, res);
        else handleTwoFactorSetup(req, res);
        return;
      }
      const publicPwaRequest = isPublicPwaRequest(req, rawPath);
      if (!publicPwaRequest && !checkAuth(req)) {
        sendUnauthorized(req, res, credentials().realm, rawPath, credentials().twoFactorEnabled);
        return;
      }
      proxyRequest(req, res);
    });

    server.on("upgrade", (req, socket, head) => {
      if (!checkAuth(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      proxyUpgrade(req, socket, head);
    });

    server.on("error", (error) => {
      ctx.logger?.warn?.(`auth-webserver: failed to listen on ${address}:${config.port}`, error);
    });

    server.listen(config.port, address);
    servers.push({ address, server });
    ctx.logger?.info?.(`auth-webserver: LAN gateway listening on http://${address}:${config.port} -> http://${targetHost}:${targetPort}`);
  }

  ctx.effect(() => () => {
    for (const { server } of servers) {
      try {
        server.closeAllConnections?.();
      } catch (_e) {
        // Best-effort teardown.
      }
      try {
        server.close();
      } catch (_e) {
        // Already closed.
      }
    }
  });
}
