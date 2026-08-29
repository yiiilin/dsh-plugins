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
import { existsSync, mkdirSync, readFileSync, statSync, lstatSync, chmodSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir, networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import { generateTotpSecret, verifyTotp } from "./totp.js";
import { loginErrorMessage, renderLoginPage, selectLoginLocale } from "./login-page.js";
import { PasskeyStore, PASSKEY_ID_PATTERN } from "./passkey-store.js";
import { SessionStore, SESSION_ID_PATTERN } from "./session-store.js";
import { injectPwaSupport, PWA_PUBLIC_PATHS, sendPwaAsset } from "./pwa.js";
import {
  hostMatches,
  originMatches,
  parseAllowedHost,
  parseAllowedOrigin,
  parseList,
  parseRequestHost,
} from "./policy.js";
import { injectMobileLayout } from "./mobile.js";

export const name = "auth-webserver";

// Hard dependency on the settings service: the GUI card and this plugin share
// one namespace ("auth-webserver"), so apply must wait until the service is
// up instead of reading it with ctx.get at an arbitrary boot moment.
export const inject = ["settings"];

const NS = settingsNamespace("auth-webserver");

const COOKIE_NAME = "dsh_auth_token";
const CSRF_COOKIE_NAME = "dsh_auth_csrf";
const SECURE_COOKIE_NAME = "__Host-dsh_auth_token";
const SECURE_CSRF_COOKIE_NAME = "__Host-dsh_auth_csrf";
const DEFAULT_SESSION_MAX_AGE_SECONDS = 24 * 3600;
const DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS = 12 * 3600;
const DEFAULT_PASSKEY_RP_NAME = "DeepSeek Harness";
const DEFAULT_LOGIN_WINDOW_SECONDS = 60;
const DEFAULT_LOGIN_MAX_ATTEMPTS = 10;
const DEFAULT_MAX_LOGIN_ATTEMPT_ENTRIES = 10_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 15_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const STATE_DIR_SEGMENTS = ["plugins", "dsh-plugin-auth-webserver"];
const GATEWAY_REQUEST = Symbol("auth-webserver gateway request");
const RATE_LIMITED_REQUEST = Symbol("auth-webserver rate limited request");
const RATE_LIMIT_RETRY_AFTER = Symbol("auth-webserver rate limit retry after");

// Immutable install metadata, icons, and the pass-through service worker stay
// reachable before login; application HTML, APIs, and WebSocket upgrades remain gated.
const PUBLIC_PWA_PATHS = new Set(["/favicon.svg", ...PWA_PUBLIC_PATHS]);

function isPublicPwaRequest(req, rawPath) {
  return (req.method === "GET" || req.method === "HEAD") && PUBLIC_PWA_PATHS.has(rawPath);
}

function requestPath(req) {
  try {
    return new URL(req.url ?? "/", "http://x").pathname;
  } catch {
    return null;
  }
}

function rejectUpgrade(socket, status, message, extraHeaders = {}) {
  const body = `${message}\n`;
  try {
    const headers = [
      `HTTP/1.1 ${status} ${message}`,
      "Connection: close",
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "X-Content-Type-Options: nosniff",
      ...Object.entries(extraHeaders).map(([key, value]) => `${key}: ${value}`),
      "",
      body,
    ];
    socket.end(headers.join("\r\n"));
  } catch {
    socket.destroy();
  }
}
function writeSocket(socket, value) {
  try {
    if (!socket.destroyed) socket.write(value);
    return true;
  } catch {
    socket.destroy();
    return false;
  }
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
  const removed = new Set([
    COOKIE_NAME,
    CSRF_COOKIE_NAME,
    SECURE_COOKIE_NAME,
    SECURE_CSRF_COOKIE_NAME,
  ]);
  const kept = header.split(";").filter((part) => {
    const key = part.split("=", 1)[0].trim();
    return !removed.has(key);
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

function parseBooleanEnv(value, label) {
  if (value === undefined) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (/^(1|true|yes|on)$/u.test(normalized)) return true;
  if (/^(0|false|no|off)$/u.test(normalized)) return false;
  throw new Error(`auth-webserver: ${label} must be a boolean (true/false)`);
}

function normalizeRemoteAddress(address) {
  if (typeof address !== "string") return "";
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
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

function securityHeaders({ secure = false, noStore = true } = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    ...(secure ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
    ...(noStore ? { "Cache-Control": "no-store" } : {}),
  };
}

function sendJson(res, status, value, extra = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...extra,
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
  /** Require TOTP and thereby disable Basic Auth, regardless of settings. */
  requireTwoFactor: z.boolean().default(false),
  /** Base32 TOTP secret. Keep this in a secret environment variable or settings secret. */
  twoFactorSecret: z.string().role("secret").default(""),
  /** Automatic mobile drawer presentation for narrow browser viewports. */
  mobileMode: z.union([z.const("auto"), z.const("off")]).default("auto"),
  /** Maximum viewport width that receives the mobile drawer shell. */
  mobileBreakpoint: z.natural().min(320).max(1600).default(760),
  /** Allowed public Host authorities; an empty list falls back to bound addresses. */
  allowedHosts: z.array(z.string()).default([]),
  /** Additional allowed browser Origins; requests must still match Host. */
  allowedOrigins: z.array(z.string()).default([]),
  /** Proxy source addresses allowed to assert HTTPS through X-Forwarded-Proto. */
  trustedProxyAddresses: z.array(z.string()).default([]),
  /** Refuse every gateway request that is not observed as HTTPS. */
  requireHttps: z.boolean().default(false),
  /** User-visible WebAuthn relying-party name. */
  passkeyRpName: z.string().min(1).max(64).default(DEFAULT_PASSKEY_RP_NAME),
  /** Optional stable WebAuthn relying-party ID; empty uses the request hostname. */
  passkeyRpId: z.string().default(""),
  /** Absolute lifetime of a browser session. */
  sessionMaxAgeSeconds: z.natural().min(300).max(30 * 24 * 3600).default(DEFAULT_SESSION_MAX_AGE_SECONDS),
  /** Idle lifetime of a browser session; zero disables the idle check. */
  sessionIdleTimeoutSeconds: z.natural().max(30 * 24 * 3600).default(DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS),
  /** Failed authentication attempts allowed per client/user window. */
  loginMaxAttempts: z.natural().min(1).max(1000).default(DEFAULT_LOGIN_MAX_ATTEMPTS),
  /** Duration of the failed-authentication window. */
  loginWindowSeconds: z.natural().min(1).max(3600).default(DEFAULT_LOGIN_WINDOW_SECONDS),
  /** Maximum failed-authentication keys retained in memory. */
  maxLoginAttemptEntries: z.natural().min(100).max(100000).default(DEFAULT_MAX_LOGIN_ATTEMPT_ENTRIES),
  /** Per-request timeout while waiting for an upstream response. */
  upstreamTimeoutMs: z.natural().min(1000).max(10 * 60 * 1000).default(DEFAULT_UPSTREAM_TIMEOUT_MS),
  /** Maximum time allowed to receive one complete incoming request body. */
  requestTimeoutMs: z.natural().min(1000).max(10 * 60 * 1000).default(DEFAULT_REQUEST_TIMEOUT_MS),
  /** Maximum time allowed to receive request headers. */
  headersTimeoutMs: z.natural().min(1000).max(10 * 60 * 1000).default(DEFAULT_HEADERS_TIMEOUT_MS),
  /** Keep-alive timeout for gateway clients. */
  keepAliveTimeoutMs: z.natural().min(1000).max(10 * 60 * 1000).default(DEFAULT_KEEP_ALIVE_TIMEOUT_MS),
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
    if (!lstatSync(stateFile()).isFile()) {
      throw new Error("legacy state is not a regular file");
    }
    chmodSync(stateFile(), 0o600);
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
  } catch (error) {
    ctx.logger?.warn?.("auth-webserver: legacy state could not be secured or migrated: %s", error);
    // Env variables and row config still stand if the legacy backup is unusable.
  }
}

function readPrivateSecret(file) {
  if (!lstatSync(file).isFile()) throw new Error("auth-webserver: persistent session secret must be a regular file");
  const value = readFileSync(file, "utf8").trim();
  if (!value) throw new Error("auth-webserver: persistent session secret is empty");
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    chmodSync(file, 0o600);
    const repaired = statSync(file).mode & 0o777;
    if ((repaired & 0o077) !== 0) {
      throw new Error("auth-webserver: persistent session secret must be owner-readable only");
    }
  }
  return value;
}

function loadOrCreateSecret() {
  const file = join(stateDir(), ".secret");
  if (existsSync(file)) return readPrivateSecret(file);
  const secret = randomBytes(32).toString("hex");
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  } catch {
    // An ephemeral secret keeps the server usable when the home is read-only;
    // sessions can only survive a restart when the persistent state directory
    // is writable.
    return randomBytes(32).toString("hex");
  }
  try {
    writeFileSync(file, secret, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return secret;
  } catch (error) {
    if (error?.code === "EEXIST") return readPrivateSecret(file);
    // An ephemeral secret keeps the server usable when persistent storage is
    // unavailable; sessions can only survive a restart when the state directory
    // is writable.
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



function sendUnauthorized(req, res, realm, rawPath, twoFactorEnabled = false, secure = false, passkeyAvailable = false) {
  const locale = selectLoginLocale(req);
  const limited = req[RATE_LIMITED_REQUEST] === true;
  if (limited) {
    sendJson(res, 429, { ok: false, error: loginErrorMessage(locale, "rateLimited") }, {
      "Retry-After": String(req[RATE_LIMIT_RETRY_AFTER] ?? 60),
      "Content-Language": locale,
    });
    return;
  }
  const accept = req.headers.accept ?? "";
  const wantsHtml = rawPath === "/" || rawPath === "/index.html"
    || (req.method === "GET" && accept.includes("text/html"));
  if (wantsHtml) {
    res.writeHead(200, {
      ...securityHeaders({ secure }),
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Language": locale,
      // The login page is intentionally self-contained; all other script and
      // frame sources remain disallowed by this policy.
      "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    const requestHost = parseRequestHost(req.headers.host);
    const passkeyForPage = passkeyAvailable && (secure || requestHost?.hostname === "localhost");
    res.end(renderLoginPage(realm, twoFactorEnabled, locale, req.url, passkeyForPage));
    return;
  }
  const headers = {
    ...securityHeaders({ secure }),
    "Content-Type": "application/json; charset=utf-8",
  };
  if (!twoFactorEnabled) {
    const safeRealm = String(realm ?? "DeepSeek Harness Authentication")
      .replace(/[^\x20-\x7e]/gu, "?")
      .replace(/[\\"]/gu, "\\$&");
    headers["WWW-Authenticate"] = `Basic realm="${safeRealm}"`;
  }
  res.writeHead(401, headers);
  res.end(JSON.stringify({ ok: false, error: "Authentication required", twoFactorRequired: twoFactorEnabled }));
}

export async function apply(ctx, config) {
  config = {
    port: config?.port ?? 3080,
    targetHost: config?.targetHost ?? "127.0.0.1",
    targetPort: config?.targetPort ?? 3080,
    addresses: config?.addresses ?? [],
    username: config?.username ?? "admin",
    password: config?.password ?? "",
    realm: config?.realm ?? "DeepSeek Harness Authentication",
    twoFactorEnabled: config?.twoFactorEnabled ?? false,
    requireTwoFactor: config?.requireTwoFactor ?? false,
    twoFactorSecret: config?.twoFactorSecret ?? "",
    mobileMode: config?.mobileMode ?? "auto",
    mobileBreakpoint: config?.mobileBreakpoint ?? 760,
    allowedHosts: config?.allowedHosts ?? [],
    allowedOrigins: config?.allowedOrigins ?? [],
    trustedProxyAddresses: config?.trustedProxyAddresses ?? [],
    requireHttps: config?.requireHttps ?? false,
    passkeyRpName: config?.passkeyRpName ?? DEFAULT_PASSKEY_RP_NAME,
    passkeyRpId: config?.passkeyRpId ?? "",
    sessionMaxAgeSeconds: config?.sessionMaxAgeSeconds ?? DEFAULT_SESSION_MAX_AGE_SECONDS,
    sessionIdleTimeoutSeconds: config?.sessionIdleTimeoutSeconds ?? DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS,
    loginMaxAttempts: config?.loginMaxAttempts ?? DEFAULT_LOGIN_MAX_ATTEMPTS,
    loginWindowSeconds: config?.loginWindowSeconds ?? DEFAULT_LOGIN_WINDOW_SECONDS,
    maxLoginAttemptEntries: config?.maxLoginAttemptEntries ?? DEFAULT_MAX_LOGIN_ATTEMPT_ENTRIES,
    upstreamTimeoutMs: config?.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
    requestTimeoutMs: config?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    headersTimeoutMs: config?.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS,
    keepAliveTimeoutMs: config?.keepAliveTimeoutMs ?? DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
  };
  const secret = loadOrCreateSecret();
  const activeSockets = new Map();
  const sessionStore = new SessionStore({
    directory: stateDir(),
    maxAgeSeconds: config.sessionMaxAgeSeconds,
    idleTimeoutSeconds: config.sessionIdleTimeoutSeconds,
    logger: ctx.logger,
  });
  const sessions = sessionStore.records;
  const persistSessions = () => sessionStore.persist();
  const passkeyStore = new PasskeyStore({ directory: stateDir(), logger: ctx.logger });
  const locallyWrittenAuthEpochs = new Set();
  let authEpochFloor = 0;
  let authMutationTail = Promise.resolve();
  const runAuthMutation = (operation) => {
    const current = authMutationTail.then(operation, operation);
    authMutationTail = current.catch(() => undefined);
    return current;
  };

  const destroySocketPair = (clientSocket, upstreamSocket) => {
    for (const socket of [clientSocket, upstreamSocket]) {
      try {
        socket?.destroy?.();
      } catch (_e) {
        // Best-effort teardown during credential changes and disposal.
      }
    }
  };

  const revokeSession = (sessionId) => {
    const record = sessions.get(sessionId);
    if (record === undefined) return { existed: false, persisted: true };
    sessions.delete(sessionId);
    for (const [clientSocket, pair] of activeSockets) {
      if (pair.sessionId !== sessionId) continue;
      if (typeof pair.close === "function") pair.close();
      else {
        pair.closed = true;
        destroySocketPair(clientSocket, pair.upstream ?? pair.request);
      }
    }
    const persisted = persistSessions();
    if (!persisted) sessions.set(sessionId, record);
    return { existed: true, persisted };
  };

  const closeActiveSockets = () => {
    for (const [clientSocket, pair] of activeSockets) {
      if (typeof pair.close === "function") pair.close();
      else {
        pair.closed = true;
        destroySocketPair(clientSocket, pair.upstream ?? pair.request);
      }
    }
    activeSockets.clear();
  };

  const revokeSessions = () => {
    sessions.clear();
    closeActiveSockets();
    persistSessions();
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
      if (typeof html !== "string") return html;
      let output = injectPwaSupport(html);
      output = injectMobileLayout(output, config.mobileMode, config.mobileBreakpoint);
      if (output.includes("dsh-auth-polyfill")) return output;
      if (output.includes("<head>")) return output.replace("<head>", `<head>${frame}`);
      return `${frame}${output}`;
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
    ctx.effect(() => settingsScope.watch((next, previous) => {
      const nextEpoch = Number.isSafeInteger(next.authEpoch) ? next.authEpoch : 0;
      const epochWasWrittenLocally = locallyWrittenAuthEpochs.delete(nextEpoch);
      authEpochFloor = Math.max(authEpochFloor, nextEpoch);
      const credentialsChanged = next.username !== previous.username
        || next.password !== previous.password
        || next.twoFactorEnabled !== previous.twoFactorEnabled
        || next.twoFactorSecret !== previous.twoFactorSecret;
      if (!epochWasWrittenLocally && (credentialsChanged || nextEpoch !== previous.authEpoch)) {
        revokeSessions();
      }
    }), "auth-webserver: revoke sessions on settings changes");
  }

  const envUser = process.env.DSH_AUTH_USER || process.env.AUTH_USER;
  const envPass = process.env.DSH_AUTH_PASS || process.env.AUTH_PASS;
  const envTwoFactorSecret = process.env.DSH_AUTH_2FA_SECRET || process.env.AUTH_2FA_SECRET;
  const rawEnvTwoFactorEnabled = process.env.DSH_AUTH_2FA_ENABLED ?? process.env.AUTH_2FA_ENABLED;
  const envTwoFactorEnabled = parseBooleanEnv(rawEnvTwoFactorEnabled, "AUTH_2FA_ENABLED");
  const rawEnvTwoFactorRequired = process.env.DSH_AUTH_2FA_REQUIRED ?? process.env.AUTH_2FA_REQUIRED;
  const envTwoFactorRequired = parseBooleanEnv(rawEnvTwoFactorRequired, "AUTH_2FA_REQUIRED");
  const envAllowedHosts = parseList(process.env.DSH_AUTH_ALLOWED_HOSTS ?? process.env.AUTH_ALLOWED_HOSTS);
  const envAllowedOrigins = parseList(process.env.DSH_AUTH_ALLOWED_ORIGINS ?? process.env.AUTH_ALLOWED_ORIGINS);
  const envTrustedProxyAddresses = parseList(process.env.DSH_AUTH_TRUSTED_PROXY_ADDRESSES ?? process.env.AUTH_TRUSTED_PROXY_ADDRESSES);
  const envRequireHttps = parseBooleanEnv(process.env.DSH_AUTH_REQUIRE_HTTPS ?? process.env.AUTH_REQUIRE_HTTPS, "AUTH_REQUIRE_HTTPS");
  const envPasskeyRpId = process.env.DSH_AUTH_PASSKEY_RP_ID || process.env.AUTH_PASSKEY_RP_ID;
  const envPasskeyRpName = process.env.DSH_AUTH_PASSKEY_RP_NAME || process.env.AUTH_PASSKEY_RP_NAME;
  const allowedHostValues = envAllowedHosts ?? (config.allowedHosts.length > 0
    ? config.allowedHosts
    : pickAddresses(config));
  const allowedHosts = allowedHostValues.map((value, index) => parseAllowedHost(value, index));
  const allowedOriginValues = envAllowedOrigins ?? config.allowedOrigins;
  const allowedOrigins = allowedOriginValues.map((value, index) => parseAllowedOrigin(value, index));
  const trustedProxyValues = envTrustedProxyAddresses ?? config.trustedProxyAddresses;
  for (const address of trustedProxyValues) {
    if (isIP(normalizeRemoteAddress(address)) === 0) {
      throw new Error(`auth-webserver: trustedProxyAddresses entry ${JSON.stringify(address)} must be an IP address`);
    }
  }
  const trustedProxyAddresses = new Set(trustedProxyValues.map(normalizeRemoteAddress));
  const requireHttps = envRequireHttps ?? config.requireHttps;
  const isTrustedProxy = (req) => trustedProxyAddresses.has(normalizeRemoteAddress(req.socket?.remoteAddress));
  const clientAddress = (req) => {
    if (isTrustedProxy(req)) {
      const forwarded = req.headers["x-forwarded-for"];
      const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const values = typeof first === "string" ? first.split(",").map((value) => value.trim()).filter(Boolean) : [];
      if (values.length === 1 && isIP(normalizeRemoteAddress(values[0])) !== 0) {
        return normalizeRemoteAddress(values[0]);
      }
    }
    return normalizeRemoteAddress(req.socket?.remoteAddress) || "unknown";
  };
  const isSecureRequest = (req) => {
    if (req.socket?.encrypted) return true;
    if (!isTrustedProxy(req)) return false;
    const forwardedProto = req.headers["x-forwarded-proto"];
    return typeof forwardedProto === "string" && forwardedProto.trim().toLowerCase() === "https";
  };
  const validateGatewayRequest = (req) => {
    const host = req.headers.host;
    if (!hostMatches(host, allowedHosts, isSecureRequest(req))) {
      return { ok: false, status: 421, error: "Misdirected request" };
    }
    const origin = req.headers.origin;
    if (req.headers["sec-fetch-site"] === "cross-site" || !originMatches(origin, host, allowedOrigins)) {
      return { ok: false, status: 403, error: "Cross-origin request rejected" };
    }
    if (requireHttps && !isSecureRequest(req)) {
      return { ok: false, status: 400, error: "HTTPS is required" };
    }
    return { ok: true };
  };
  const passkeyContext = (req) => {
    const host = parseRequestHost(req.headers.host);
    if (host === undefined) throw new Error("A valid Host is required for Passkeys");
    const localDevelopmentHost = host.hostname === "localhost";
    const secure = isSecureRequest(req) || localDevelopmentHost;
    if (!secure) throw new Error("Passkeys require HTTPS (except localhost)");
    const origin = new URL(`${isSecureRequest(req) ? "https" : "http"}://${host.host}`).origin;
    const rpId = String(envPasskeyRpId || config.passkeyRpId || host.hostname).trim();
    const rpName = String(envPasskeyRpName || config.passkeyRpName || DEFAULT_PASSKEY_RP_NAME).trim().slice(0, 64);
    if (rpId === "" || rpName === "") throw new Error("Passkey RP configuration is invalid");
    return { origin, rpId, rpName };
  };

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
    const configuredTwoFactorEnabled = envTwoFactorEnabled ?? (Boolean(value.twoFactorEnabled) || Boolean(envTwoFactorSecret));
    const twoFactorEnabled = envTwoFactorRequired === true
      || Boolean(config.requireTwoFactor)
      || configuredTwoFactorEnabled;
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
  const snapshot = (currentId) => {
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
      twoFactorOverriddenByEnv: rawEnvTwoFactorEnabled !== undefined || rawEnvTwoFactorRequired !== undefined || Boolean(envTwoFactorSecret),
      twoFactorOverriddenByConfig: Boolean(config.twoFactorEnabled || config.requireTwoFactor || config.twoFactorSecret),
      twoFactorRequiredByConfig: Boolean(config.requireTwoFactor),
      twoFactorOverriddenBySettings: userLayerHasField(descriptor, "twoFactorEnabled") || userLayerHasField(descriptor, "twoFactorSecret"),
      sessions: listSessions(currentId),
      passkeys: passkeyStore.list(),
    };
  };

  const updateSettingsAndRevoke = async (next) => runAuthMutation(async () => {
    const currentEpoch = Math.max(
      Number.isSafeInteger(resolved().authEpoch) ? resolved().authEpoch : 0,
      authEpochFloor,
    );
    const nextEpoch = currentEpoch + 1;
    authEpochFloor = nextEpoch;
    locallyWrittenAuthEpochs.add(nextEpoch);
    try {
      await settings.update(NS, {
        ...next,
        authEpoch: nextEpoch,
      });
    } catch (error) {
      locallyWrittenAuthEpochs.delete(nextEpoch);
      throw error;
    }
    revokeSessions();
  });

  const handleState = (req, res, auth) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    sendJson(res, 200, { ok: true, state: snapshot(auth?.kind === "cookie" ? auth.sessionId : undefined) });
  };

  const handleClients = (req, res, auth) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    const currentId = auth?.kind === "cookie" ? auth.sessionId : undefined;
    sendJson(res, 200, {
      ok: true,
      clients: listSessions(currentId),
      currentClientId: currentId ?? null,
    });
  };

  const handleSessionRevoke = async (req, res, providedAuth) => {
    const auth = requireSession(req, res, providedAuth);
    if (auth === null) return;
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    const mediaType = typeof req.headers["content-type"] === "string"
      ? req.headers["content-type"].split(";", 1)[0].trim().toLowerCase()
      : "";
    if (mediaType !== "application/json") {
      sendJson(res, 415, { ok: false, error: "Content-Type must be application/json" });
      return;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid request body" });
      return;
    }
    const sessionId = body !== null && typeof body === "object" && !Array.isArray(body)
      && typeof (body.sessionId ?? body.clientId) === "string"
      ? (body.sessionId ?? body.clientId)
      : "";
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      sendJson(res, 400, { ok: false, error: "Invalid session id" });
      return;
    }
    return runAuthMutation(async () => {
      if (!sessions.has(sessionId)) {
        sendJson(res, 404, { ok: false, error: "Session not found" });
        return;
      }
      const current = auth.kind === "cookie" && auth.sessionId === sessionId;
            const result = revokeSession(sessionId);
      if (!result.persisted) {
        sendJson(res, 503, { ok: false, error: "Session revocation could not be persisted" });
        return;
      }
      const secure = isSecureRequest(req);
      sendJson(res, 200, {
        ok: true,
        current,
        state: snapshot(current ? undefined : auth.sessionId),
      }, current ? { "Set-Cookie": clearCookieHeaders(secure) } : {});
    });
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
    const environmentControlsTwoFactor = rawEnvTwoFactorEnabled !== undefined
      || rawEnvTwoFactorRequired !== undefined
      || Boolean(envTwoFactorSecret)
      || Boolean(config.requireTwoFactor);
    if (environmentControlsTwoFactor) {
      sendJson(res, 400, {
        ok: false,
        error: "2FA is controlled by deployment configuration and cannot be changed here",
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

  const handlePwaAsset = (req, res) => {
    const path = requestPath(req);
    if (path !== null && sendPwaAsset(req, res, path, securityHeaders, false)) return;
    sendJson(res, 405, { ok: false, error: "Method not allowed" });
  };

  if (webServer !== undefined && typeof webServer.register === "function") {
    for (const path of PWA_PUBLIC_PATHS) {
      ctx.effect(() => webServer.register({ kind: "exact", path, handler: handlePwaAsset }));
    }
    ctx.effect(() => webServer.register({ kind: "exact", path: "/_dsh/auth-webserver/state", handler: handleState }));
    ctx.effect(() => webServer.register({ kind: "exact", path: "/_dsh/auth-webserver/clients", handler: (req, res) => handleClients(req, res, authenticateRequest(req)) }));
    ctx.effect(() => webServer.register({ kind: "exact", path: "/_dsh/auth-webserver/clients/revoke", handler: handleSessionRevoke }));
    ctx.effect(() => webServer.register({ kind: "exact", path: "/_dsh/auth-webserver/sessions/revoke", handler: handleSessionRevoke }));
    ctx.effect(() => webServer.register({ kind: "exact", path: "/_dsh/auth-webserver/save", handler: handleSave }));
    ctx.effect(() => webServer.register({ kind: "exact", path: "/_dsh/auth-webserver/2fa", handler: handleTwoFactorSetup }));
    ctx.effect(() => webServer.register({ kind: "exact", path: "/_dsh/auth-webserver/passkeys", handler: (req, res) => handlePasskeys(req, res) }));
    ctx.effect(() => webServer.register({ kind: "exact", path: "/_dsh/auth-webserver/passkeys/register/options", handler: (req, res) => handlePasskeyRegistrationOptions(req, res) }));
    ctx.effect(() => webServer.register({ kind: "exact", path: "/_dsh/auth-webserver/passkeys/register/verify", handler: (req, res) => handlePasskeyRegistrationVerify(req, res) }));
    ctx.effect(() => webServer.register({ kind: "exact", path: "/_dsh/auth-webserver/passkeys/revoke", handler: (req, res) => handlePasskeyRevoke(req, res) }));
  }


  const credentials = () => {
    const value = resolved();
    const storedEpoch = Number.isSafeInteger(value.authEpoch) ? value.authEpoch : 0;
    authEpochFloor = Math.max(authEpochFloor, storedEpoch);
    return {
      user: process.env.DSH_AUTH_USER || process.env.AUTH_USER || value.username || "admin",
      pass: process.env.DSH_AUTH_PASS || process.env.AUTH_PASS || value.password || "",
      realm: value.realm || "DeepSeek Harness Authentication",
      twoFactorEnabled: Boolean(value.twoFactorEnabled),
      twoFactorSecret: value.twoFactorSecret || "",
      authEpoch: Math.max(
        Number.isSafeInteger(value.authEpoch) ? value.authEpoch : 0,
        authEpochFloor,
      ),
    };
  };

  const currentAuthEpoch = credentials().authEpoch;
  let staleSessionRecords = false;
  for (const [sessionId, record] of sessions) {
    if (record.authEpoch === currentAuthEpoch) continue;
    sessions.delete(sessionId);
    staleSessionRecords = true;
  }
  if (staleSessionRecords) persistSessions();

  const listSessions = (currentId) => sessionStore.list(currentId);

  const tokenFactor = (twoFactorEnabled, twoFactorSecret) =>
    twoFactorEnabled ? `mfa\u0000${twoFactorSecret}` : "pwd";
  const generateToken = (req, user, pass, authEpoch, twoFactorEnabled, twoFactorSecret) => {
    const record = sessionStore.create({
      username: user,
      address: clientAddress(req),
      userAgent: req.headers["user-agent"],
      secure: isSecureRequest(req),
      authEpoch,
    });
    const sessionId = record.id;
    const now = record.issuedAt;
    const signature = createHmac("sha256", secret)
      .update(`${sessionId}\u0000${user}\u0000${pass}\u0000${authEpoch}\u0000${tokenFactor(twoFactorEnabled, twoFactorSecret)}\u0000${now}`)
      .digest("hex");
    return `${sessionId}.${now}.${signature}`;
  };

  const csrfForToken = (token) => createHmac("sha256", secret)
    .update(`csrf\u0000${token}`)
    .digest("base64url");

  const verifyToken = (token, user, pass, authEpoch, twoFactorEnabled, twoFactorSecret) => {
    if (typeof token !== "string") return false;
    const parts = token.split(".");
    if (parts.length !== 3 || !SESSION_ID_PATTERN.test(parts[0]) || !/^[a-f0-9]{64}$/iu.test(parts[2])) return false;
    const sessionId = parts[0];
    const timestamp = Number(parts[1]);
    if (!Number.isSafeInteger(timestamp)) return false;
    const age = Date.now() - timestamp;
    const maxAgeMs = config.sessionMaxAgeSeconds * 1000;
    if (age < -60000 || age > maxAgeMs) return false;
    const record = sessions.get(sessionId);
    if (record === undefined || record.issuedAt !== timestamp) return false;
    const expected = createHmac("sha256", secret)
      .update(`${sessionId}\u0000${user}\u0000${pass}\u0000${authEpoch}\u0000${tokenFactor(twoFactorEnabled, twoFactorSecret)}\u0000${timestamp}`)
      .digest();
    const actual = Buffer.from(parts[2], "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };

  const sessionIsActive = (sessionId, issuedAt) => sessionStore.touch(sessionId, issuedAt) !== null;

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
  const clientLoginAttempts = new Map();
  const loginWindowMs = config.loginWindowSeconds * 1000;
  const loginAttemptKey = (req, username) => `${clientAddress(req)}:${String(username).slice(0, 256)}`;
  const clientLoginAttemptKey = (req) => clientAddress(req);
  const pruneAttempts = (attempts, now) => {
    for (const [key, attempt] of attempts) {
      if (attempt.expiresAt <= now) attempts.delete(key);
    }
  };
  const pruneLoginAttempts = (now) => {
    pruneAttempts(loginAttempts, now);
    pruneAttempts(clientLoginAttempts, now);
  };
  const evictAttempt = (attempts) => {
    const oldest = attempts.keys().next().value;
    if (oldest !== undefined) attempts.delete(oldest);
  };
  const loginRateLimited = (req, username) => {
    req[RATE_LIMITED_REQUEST] = false;
    req[RATE_LIMIT_RETRY_AFTER] = config.loginWindowSeconds;
    const now = Date.now();
    pruneLoginAttempts(now);
    const userAttempt = loginAttempts.get(loginAttemptKey(req, username));
    const clientAttempt = clientLoginAttempts.get(clientLoginAttemptKey(req));
    if ((userAttempt?.count ?? 0) >= config.loginMaxAttempts
      || (clientAttempt?.count ?? 0) >= config.loginMaxAttempts) {
      req[RATE_LIMITED_REQUEST] = true;
      return true;
    }
    return false;
  };
  const noteLoginFailure = (req, username) => {
    const now = Date.now();
    pruneLoginAttempts(now);
    const entries = [
      [loginAttempts, loginAttemptKey(req, username)],
      [clientLoginAttempts, clientLoginAttemptKey(req)],
    ];
    for (const [attempts, key] of entries) {
      const current = attempts.get(key);
      if (current === undefined || current.expiresAt <= now) {
        if (attempts.size >= config.maxLoginAttemptEntries) evictAttempt(attempts);
        attempts.set(key, { count: 1, expiresAt: now + loginWindowMs });
      } else {
        current.count += 1;
      }
    }
  };
  const clearLoginFailures = (req, username) => {
    loginAttempts.delete(loginAttemptKey(req, username));
    clientLoginAttempts.delete(clientLoginAttemptKey(req));
  };

  const cookieNames = (secure) => secure
    ? { token: SECURE_COOKIE_NAME, csrf: SECURE_CSRF_COOKIE_NAME, legacyToken: COOKIE_NAME, legacyCsrf: CSRF_COOKIE_NAME }
    : { token: COOKIE_NAME, csrf: CSRF_COOKIE_NAME, legacyToken: SECURE_COOKIE_NAME, legacyCsrf: SECURE_CSRF_COOKIE_NAME };
  const cookieValue = (cookies, names, key) => cookies[names[key]];
  const cookieHeader = (name, value, secure, maxAge, httpOnly) =>
    `${name}=${value}; Path=/;${httpOnly ? " HttpOnly;" : ""} SameSite=Strict; Max-Age=${maxAge}${secure || name.startsWith("__Host-") ? "; Secure" : ""}`;
  const loginCookieHeaders = (token, csrf, secure) => {
    const names = cookieNames(secure);
    return [
      cookieHeader(names.token, token, secure, config.sessionMaxAgeSeconds, true),
      cookieHeader(names.csrf, csrf, secure, config.sessionMaxAgeSeconds, false),
      cookieHeader(names.legacyToken, "", secure, 0, true),
      cookieHeader(names.legacyCsrf, "", secure, 0, false),
    ];
  };
  const clearCookieHeaders = (secure) => [
    cookieHeader(COOKIE_NAME, "", secure, 0, true),
    cookieHeader(CSRF_COOKIE_NAME, "", secure, 0, false),
    cookieHeader(SECURE_COOKIE_NAME, "", true, 0, true),
    cookieHeader(SECURE_CSRF_COOKIE_NAME, "", true, 0, false),
  ];

  const authenticateRequest = (req) => {
    const { user, pass, twoFactorEnabled, twoFactorSecret, authEpoch } = credentials();
    if (!pass) return null;

    const cookies = parseCookies(req);
    const names = cookieNames(isSecureRequest(req));
    const token = cookieValue(cookies, names, "token");
    if (token && verifyToken(token, user, pass, authEpoch, twoFactorEnabled, twoFactorSecret)) {
      const parts = token.split(".");
      const sessionId = parts[0];
      const issuedAt = Number(parts[1]);
      if (sessionIsActive(sessionId, issuedAt)) {
        return { kind: "cookie", token, sessionId, issuedAt, csrf: csrfForToken(token) };
      }
    }

    // Basic Auth cannot carry a second factor and is deliberately disabled when
    // TOTP is active. Use the password + OTP login endpoint to obtain a cookie.
    if (twoFactorEnabled) return null;
    const basic = parseBasic(req.headers.authorization);
    if (!basic) return null;
    if (loginRateLimited(req, basic.user)) return null;
    if (safeEqual(basic.user, user) && safeEqual(basic.pass, pass)) {
      clearLoginFailures(req, basic.user);
      return { kind: "basic", issuedAt: Date.now(), csrf: null };
    }
    noteLoginFailure(req, basic.user);
    return null;
  };

  const checkAuth = (req) => authenticateRequest(req);

  const requireSession = (req, res, providedAuth) => {
    const auth = providedAuth ?? authenticateRequest(req);
    if (auth === null || auth.kind !== "cookie") {
      if (req[GATEWAY_REQUEST] !== true && isLoopbackAddress(req.socket?.remoteAddress)) {
        return { kind: "local", csrf: null };
      }
      sendJson(res, 403, { ok: false, error: "A browser login session is required" });
      return null;
    }
    const cookies = parseCookies(req);
    const names = cookieNames(isSecureRequest(req));
    const csrfCookie = cookieValue(cookies, names, "csrf");
    const header = req.headers["x-dsh-csrf"];
    const submitted = Array.isArray(header) ? header[0] : header;
    if (!csrfCookie || typeof submitted !== "string" ||
      !safeEqual(csrfCookie, auth.csrf) || !safeEqual(submitted, auth.csrf)) {
      sendJson(res, 403, { ok: false, error: "CSRF validation failed" });
      return null;
    }
    return auth;
  };

  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const sendPasskeyJson = (res, status, value, extra = {}) => sendJson(res, status, value, {
    "Cache-Control": "no-store",
    ...extra,
  });
  const readPasskeyBody = async (req, res) => {
    const mediaType = typeof req.headers["content-type"] === "string"
      ? req.headers["content-type"].split(";", 1)[0].trim().toLowerCase()
      : "";
    if (mediaType !== "application/json") {
      sendPasskeyJson(res, 415, { ok: false, error: "Content-Type must be application/json" });
      return undefined;
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendPasskeyJson(res, 400, { ok: false, error: "Invalid request body" });
      return undefined;
    }
    if (!isObject(body)) {
      sendPasskeyJson(res, 400, { ok: false, error: "Invalid request body" });
      return undefined;
    }
    return body;
  };
  const passkeyUserId = (username) => createHmac("sha256", secret)
    .update(`passkey-user\u0000${username}`)
    .digest();
  const passkeyDescriptors = () => passkeyStore.list().map((entry) => ({
    id: entry.id,
    transports: entry.transports,
  }));
  const issueLoginSession = (req, res, current, locale) => {
    const token = generateToken(req, current.user, current.pass, current.authEpoch, current.twoFactorEnabled, current.twoFactorSecret);
    const csrf = csrfForToken(token);
    const secure = isSecureRequest(req);
    sendJson(res, 200, { ok: true, username: current.user }, {
      "Content-Language": locale,
      "Set-Cookie": loginCookieHeaders(token, csrf, secure),
      ...securityHeaders({ secure }),
    });
  };

  const handlePasskeyLoginOptions = async (req, res) => {
    const locale = selectLoginLocale(req);
    if (req.method !== "POST") {
      sendPasskeyJson(res, 405, { ok: false, error: loginErrorMessage(locale, "methodNotAllowed") }, { "Content-Language": locale });
      return;
    }
    if (await readPasskeyBody(req, res) === undefined) return;
    if (!passkeyStore.hasAny()) {
      sendPasskeyJson(res, 404, { ok: false, error: "No passkeys are registered" }, { "Content-Language": locale });
      return;
    }
    if (loginRateLimited(req, "passkey")) {
      sendPasskeyJson(res, 429, { ok: false, error: loginErrorMessage(locale, "rateLimited") }, {
        "Content-Language": locale,
        "Retry-After": String(config.loginWindowSeconds),
      });
      return;
    }
    let webauthn;
    try {
      webauthn = passkeyContext(req);
      const options = await generateAuthenticationOptions({
        rpID: webauthn.rpId,
        allowCredentials: passkeyDescriptors(),
        userVerification: "required",
        timeout: 60_000,
      });
      passkeyStore.createChallenge({
        purpose: "login",
        challenge: options.challenge,
        rpId: webauthn.rpId,
        origin: webauthn.origin,
        address: clientAddress(req),
      });
      sendPasskeyJson(res, 200, { ok: true, challenge: options.challenge, options }, { "Content-Language": locale });
    } catch {
      sendPasskeyJson(res, 400, { ok: false, error: "Passkeys require HTTPS (except localhost)" }, { "Content-Language": locale });
    }
  };

  const handlePasskeyLoginVerify = async (req, res) => {
    const locale = selectLoginLocale(req);
    if (req.method !== "POST") {
      sendPasskeyJson(res, 405, { ok: false, error: loginErrorMessage(locale, "methodNotAllowed") }, { "Content-Language": locale });
      return;
    }
    const body = await readPasskeyBody(req, res);
    if (body === undefined) return;
    const pending = passkeyStore.consumeChallenge(body.challenge, "login", { address: clientAddress(req) });
    if (pending === null || !isObject(body.response)) {
      sendPasskeyJson(res, 400, { ok: false, error: "Passkey challenge expired or invalid" }, { "Content-Language": locale });
      return;
    }
    const credentialId = body.response.id;
    const credential = typeof credentialId === "string" && PASSKEY_ID_PATTERN.test(credentialId)
      ? passkeyStore.credential(credentialId)
      : null;
    if (credential === null) {
      noteLoginFailure(req, "passkey");
      sendPasskeyJson(res, 401, { ok: false, error: "Passkey verification failed" }, { "Content-Language": locale });
      return;
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpId,
        credential,
        requireUserVerification: true,
      });
    } catch {
      verification = { verified: false };
    }
    if (!verification.verified) {
      noteLoginFailure(req, "passkey");
      sendPasskeyJson(res, 401, { ok: false, error: "Passkey verification failed" }, { "Content-Language": locale });
      return;
    }
    const authenticationInfo = verification.authenticationInfo;
    if (!passkeyStore.updateAuthentication(
      credentialId,
      authenticationInfo.newCounter,
      authenticationInfo.credentialDeviceType,
      authenticationInfo.credentialBackedUp,
    )) {
      sendPasskeyJson(res, 503, { ok: false, error: "Passkey state could not be persisted" }, { "Content-Language": locale });
      return;
    }
    clearLoginFailures(req, "passkey");
    issueLoginSession(req, res, credentials(), locale);
  };

  const handlePasskeyRegistrationOptions = async (req, res, providedAuth) => {
    const auth = requireSession(req, res, providedAuth);
    if (auth === null) return;
    if (req.method !== "POST") {
      sendPasskeyJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    const body = await readPasskeyBody(req, res);
    if (body === undefined) return;
    const current = credentials();
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    if (!current.pass || !safeEqual(currentPassword, current.pass)
      || (current.twoFactorEnabled && !consumeTotp(current.twoFactorSecret, body.currentOtp))) {
      sendPasskeyJson(res, 403, { ok: false, error: "Current password and authenticator code are required" });
      return;
    }
    let webauthn;
    try {
      webauthn = passkeyContext(req);
      const options = await generateRegistrationOptions({
        rpName: webauthn.rpName,
        rpID: webauthn.rpId,
        userName: current.user,
        userID: passkeyUserId(current.user),
        userDisplayName: current.user,
        timeout: 60_000,
        attestationType: "none",
        excludeCredentials: passkeyDescriptors(),
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
        },
      });
      passkeyStore.createChallenge({
        purpose: "register",
        challenge: options.challenge,
        sessionId: auth.kind === "cookie" ? auth.sessionId : undefined,
        rpId: webauthn.rpId,
        origin: webauthn.origin,
        address: clientAddress(req),
      });
      sendPasskeyJson(res, 200, { ok: true, challenge: options.challenge, options });
    } catch {
      sendPasskeyJson(res, 400, { ok: false, error: "Passkeys require HTTPS (except localhost)" });
    }
  };

  const handlePasskeyRegistrationVerify = async (req, res, providedAuth) => {
    const auth = requireSession(req, res, providedAuth);
    if (auth === null) return;
    if (req.method !== "POST") {
      sendPasskeyJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    const body = await readPasskeyBody(req, res);
    if (body === undefined) return;
    const pending = passkeyStore.consumeChallenge(body.challenge, "register", {
      sessionId: auth.kind === "cookie" ? auth.sessionId : undefined,
      address: clientAddress(req),
    });
    if (pending === null || !isObject(body.response)) {
      sendPasskeyJson(res, 400, { ok: false, error: "Passkey challenge expired or invalid" });
      return;
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpId,
        requireUserVerification: true,
      });
    } catch {
      verification = { verified: false };
    }
    if (!verification.verified || verification.registrationInfo === undefined) {
      sendPasskeyJson(res, 400, { ok: false, error: "Passkey registration failed" });
      return;
    }
    let added;
    try {
      added = passkeyStore.add({
        credential: verification.registrationInfo.credential,
        name: body.name,
        deviceType: verification.registrationInfo.credentialDeviceType,
        backedUp: verification.registrationInfo.credentialBackedUp,
      });
    } catch (error) {
      sendPasskeyJson(res, 409, { ok: false, error: error instanceof Error ? error.message : "Passkey is already registered" });
      return;
    }
    if (!added.persisted) {
      sendPasskeyJson(res, 503, { ok: false, error: "Passkey could not be persisted" });
      return;
    }
    sendPasskeyJson(res, 200, {
      ok: true,
      passkeys: passkeyStore.list(),
      state: snapshot(auth.kind === "cookie" ? auth.sessionId : undefined),
    });
  };

  const handlePasskeys = (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendPasskeyJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    sendPasskeyJson(res, 200, { ok: true, passkeys: passkeyStore.list() });
  };

  const handlePasskeyRevoke = async (req, res, providedAuth) => {
    const auth = requireSession(req, res, providedAuth);
    if (auth === null) return;
    if (req.method !== "POST") {
      sendPasskeyJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    const body = await readPasskeyBody(req, res);
    if (body === undefined) return;
    const credentialId = typeof body.credentialId === "string" ? body.credentialId : "";
    if (!PASSKEY_ID_PATTERN.test(credentialId)) {
      sendPasskeyJson(res, 400, { ok: false, error: "Invalid passkey id" });
      return;
    }
    const current = credentials();
    const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
    if (!current.pass || !safeEqual(currentPassword, current.pass)
      || (current.twoFactorEnabled && !consumeTotp(current.twoFactorSecret, body.currentOtp))) {
      sendPasskeyJson(res, 403, { ok: false, error: "Current password and authenticator code are required" });
      return;
    }
    const result = passkeyStore.remove(credentialId);
    if (!result.existed) {
      sendPasskeyJson(res, 404, { ok: false, error: "Passkey not found" });
      return;
    }
    if (!result.persisted) {
      sendPasskeyJson(res, 503, { ok: false, error: "Passkey revocation could not be persisted" });
      return;
    }
    sendPasskeyJson(res, 200, {
      ok: true,
      passkeys: passkeyStore.list(),
      state: snapshot(auth.kind === "cookie" ? auth.sessionId : undefined),
    });
  };

  const handleLogin = async (req, res) => {
    const locale = selectLoginLocale(req);
    const sendLoginJson = (status, value, extra = {}) => sendJson(res, status, value, {
      "Content-Language": locale,
      ...extra,
    });
    if (req.method !== "POST") {
      sendLoginJson(405, { ok: false, error: loginErrorMessage(locale, "methodNotAllowed") });
      return;
    }
    const mediaType = typeof req.headers["content-type"] === "string"
      ? req.headers["content-type"].split(";", 1)[0].trim().toLowerCase()
      : "";
    if (mediaType !== "application/json") {
      sendLoginJson(415, { ok: false, error: loginErrorMessage(locale, "contentType") });
      return;
    }

    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendLoginJson(400, { ok: false, error: loginErrorMessage(locale, "invalidBody") });
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      sendLoginJson(400, { ok: false, error: loginErrorMessage(locale, "invalidBody") });
      return;
    }

    return runAuthMutation(async () => {
      const { user, pass, twoFactorEnabled, twoFactorSecret, authEpoch } = credentials();
      const submittedUser = typeof body.username === "string" ? body.username.slice(0, 256) : "";
      const submittedPass = typeof body.password === "string" ? body.password : "";
      if (loginRateLimited(req, submittedUser)) {
        sendLoginJson(429, { ok: false, error: loginErrorMessage(locale, "rateLimited") }, { "Retry-After": String(config.loginWindowSeconds) });
        return;
      }
      const passwordValid = Boolean(pass) && safeEqual(submittedUser, user) && safeEqual(submittedPass, pass);
      const otpValid = !twoFactorEnabled || (passwordValid && consumeTotp(twoFactorSecret, body.otp));
      if (!passwordValid || !otpValid) {
        noteLoginFailure(req, submittedUser);
        sendLoginJson(401, { ok: false, error: loginErrorMessage(locale, "invalid") });
        return;
      }
      clearLoginFailures(req, submittedUser);

      issueLoginSession(req, res, { user, pass, authEpoch, twoFactorEnabled, twoFactorSecret }, locale);
    });
  };

  const handleLogout = async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }
    return runAuthMutation(async () => {
      const auth = authenticateRequest(req);
      if (auth?.kind === "cookie") {
        const cookies = parseCookies(req);
        const names = cookieNames(isSecureRequest(req));
        const csrfCookie = cookieValue(cookies, names, "csrf");
        const header = req.headers["x-dsh-csrf"];
        const submitted = Array.isArray(header) ? header[0] : header;
        if (!csrfCookie || typeof submitted !== "string" ||
          !safeEqual(csrfCookie, auth.csrf) || !safeEqual(submitted, auth.csrf)) {
          sendJson(res, 403, { ok: false, error: "CSRF validation failed" });
          return;
        }
                const result = revokeSession(auth.sessionId);
        if (!result.persisted) {
          sendJson(res, 503, { ok: false, error: "Session revocation could not be persisted" });
          return;
        }
      }
      const secure = isSecureRequest(req);
      sendJson(res, 200, { ok: true }, {
        "Set-Cookie": clearCookieHeaders(secure),
        ...securityHeaders({ secure }),
      });
    });
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

  const gatewayResponseHeaders = (headers, req, rawPath) => {
    const publicPwaRequest = isPublicPwaRequest(req, rawPath);
    const additions = securityHeaders({ secure: isSecureRequest(req), noStore: !publicPwaRequest });
    const result = { ...headers };
    for (const [key, value] of Object.entries(additions)) {
      if (result[key.toLowerCase()] === undefined) result[key.toLowerCase()] = value;
    }
    if (!publicPwaRequest) result["cache-control"] = "no-store";
    return result;
  };

  const cleanForwardedHeaders = (headers) => {
    for (const header of [
      "authorization",
      "proxy-authorization",
      "x-dsh-otp",
      "x-dsh-csrf",
      "forwarded",
      "via",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-forwarded-port",
    ]) delete headers[header];
    return headers;
  };

  const proxyRequest = (req, res, rawPath) => {
    const shouldPatchConnectionClient = req.method === "GET" && rawPath === CONNECTION_CLIENT_PATH;
    const headers = cleanForwardedHeaders({ ...req.headers });
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
    // the rewritten Host header, so a validated public Origin is translated
    // to the local upstream authority after the gateway policy has run.
    if (headers.origin !== undefined) headers.origin = `http://${targetHost}:${targetPort}`;
    headers["x-forwarded-for"] = clientAddress(req);

    let proxyResponse;
    const abortUpstream = () => {
      proxyReq.destroy();
      proxyResponse?.destroy();
    };

    const proxyReq = request({
      hostname: targetHost,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers,
    }, (proxyRes) => {
      proxyResponse = proxyRes;
      const respondProxyError = () => {
        if (res.headersSent || res.writableEnded || res.destroyed) {
          res.destroy();
          return;
        }
        res.writeHead(502, gatewayResponseHeaders({ "content-type": "application/json; charset=utf-8" }, req, rawPath));
        res.end(JSON.stringify({ ok: false, error: "upstream response failed" }));
      };
      proxyRes.once("error", respondProxyError);
      res.once("error", () => proxyRes.destroy());
      const resHeaders = gatewayResponseHeaders({ ...proxyRes.headers }, req, rawPath);
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
    });
    res.once("close", () => {
      if (!res.writableEnded) abortUpstream();
    });
    proxyReq.setTimeout(config.upstreamTimeoutMs, () => {
      proxyReq.destroy(new Error("upstream request timed out"));
    });
    proxyReq.on("error", (error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, gatewayResponseHeaders({ "content-type": "application/json; charset=utf-8" }, req, rawPath));
      res.end(JSON.stringify({ ok: false, error: `upstream unreachable: ${error.code ?? error.message}` }));
    });
    req.on("aborted", () => proxyReq.destroy());
    req.pipe(proxyReq);
  };

  const proxyUpgrade = (req, socket, head, auth) => {
    if (disposed) {
      rejectUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    const rawPath = requestPath(req);
    if (rawPath === null) {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    const headers = cleanForwardedHeaders({ ...req.headers });
    if (headers.cookie !== undefined) {
      headers.cookie = stripGatewayCookies(headers.cookie);
      if (headers.cookie === undefined) delete headers.cookie;
    }
    headers.host = `${targetHost}:${targetPort}`;
    if (headers.origin) headers.origin = `http://${targetHost}:${targetPort}`;
    headers["x-forwarded-for"] = clientAddress(req);
    for (const h of ["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding"]) {
      delete headers[h];
    }
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
    const proxyReq = request({
      hostname: targetHost,
      port: targetPort,
      path: req.url,
      method: "GET",
      headers,
    });
    const pair = { request: proxyReq, upstream: null, closed: false, close: null, sessionId: auth?.sessionId };
    const removePair = () => {
      if (activeSockets.get(socket) === pair) activeSockets.delete(socket);
    };
    let idleTimer;
    let expiryTimer;
    let activityListener;
    const closePair = () => {
      if (pair.closed) return;
      pair.closed = true;
      removePair();
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (expiryTimer !== undefined) clearTimeout(expiryTimer);
      if (activityListener !== undefined) {
        socket.removeListener("data", activityListener);
        pair.upstream?.removeListener("data", activityListener);
      }
      destroySocketPair(socket, pair.upstream ?? pair.request);
    };
    pair.close = closePair;
    activeSockets.set(socket, pair);
    socket.once("close", closePair);
    socket.once("error", closePair);
    proxyReq.once("error", closePair);
    proxyReq.setTimeout(config.upstreamTimeoutMs, () => {
      proxyReq.destroy(new Error("upstream WebSocket handshake timed out"));
    });
    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      if (pair.closed || activeSockets.get(socket) !== pair) {
        destroySocketPair(socket, proxySocket);
        return;
      }
      pair.request = null;
      pair.upstream = proxySocket;
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
      if (writeSocket(socket, lines.join("\r\n")) === false) return;
      const idleMs = config.sessionIdleTimeoutSeconds * 1000;
      activityListener = () => {
        if (pair.closed) return;
        if (pair.sessionId !== undefined && sessionStore.touch(pair.sessionId, auth.issuedAt) === null) {
          closePair();
          return;
        }
        if (idleMs <= 0) return;
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        idleTimer = setTimeout(closePair, idleMs);
      };
      const expiryDeadline = auth?.issuedAt + config.sessionMaxAgeSeconds * 1000;
      const armExpiry = () => {
        if (!Number.isFinite(expiryDeadline) || pair.closed) return;
        const remaining = expiryDeadline - Date.now();
        if (remaining <= 0) {
          closePair();
          return;
        }
        expiryTimer = setTimeout(armExpiry, Math.min(remaining, 0x7fffffff));
      };
      socket.once("close", closePair);
      socket.once("error", closePair);
      proxySocket.once("close", closePair);
      proxySocket.once("error", closePair);
      if (idleMs > 0) {
        socket.on("data", activityListener);
        proxySocket.on("data", activityListener);
        activityListener();
      }
      armExpiry();
      if (head && head.length) writeSocket(proxySocket, head);
      if (proxyHead && proxyHead.length) writeSocket(socket, proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    // Upstream refused the upgrade (e.g. 403): relay that response instead of
    // leaving the browser socket hanging without a handshake answer.
    proxyReq.on("response", (proxyRes) => {
      pair.closed = true;
      removePair();
      socket.off("close", closePair);
      socket.off("error", closePair);
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
      if (writeSocket(socket, lines.join("\r\n")) === false) return;
      socket.once("error", () => proxyRes.destroy());
      proxyRes.once("error", () => socket.destroy());
      proxyRes.pipe(socket);
    });
    proxyReq.end();
  };

  const servers = [];
  const addresses = pickAddresses(config);
  if (addresses.length === 0) {
    ctx.logger?.warn?.("auth-webserver: no non-loopback network addresses found; LAN gateway is idle");
  }

  const closeServer = async (record) => {
    const cancellation = record.cancelListen?.();
    if (cancellation !== undefined) await cancellation;
    try {
      record.server.closeAllConnections?.();
    } catch (_e) {
      // Best-effort teardown.
    }
    if (!record.server.listening) return;
    await new Promise((resolve) => {
      record.server.close(() => resolve());
    });
  };

  const listenServer = (record) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      record.cancelListen = undefined;
      record.server.off("error", onError);
      callback(value);
    };
    const onError = (error) => {
      if (settled) {
        ctx.logger?.warn?.(`auth-webserver: listener error on ${record.address}:${config.port}`, error);
        return;
      }
      finish(reject, error);
    };
    record.cancelListen = () => {
      if (settled) return undefined;
      record.cancelled = true;
      return new Promise((resolveClose) => {
        const finishCancellation = () => {
          finish(reject, new Error("auth-webserver: listener startup cancelled"));
          resolveClose();
        };
        try {
          record.server.close(finishCancellation);
        } catch {
          finishCancellation();
        }
      });
    };
    record.server.once("error", onError);
    record.server.listen(config.port, record.address, () => {
      if (record.cancelled) {
        try {
          record.server.close(() => {});
        } catch (_e) {
          // The cancellation path already owns teardown.
        }
        finish(reject, new Error("auth-webserver: listener startup cancelled"));
        return;
      }
      finish(resolve);
      record.server.on("error", (error) => {
        ctx.logger?.warn?.(`auth-webserver: listener error on ${record.address}:${config.port}`, error);
      });
    });
  });

  for (const address of addresses) {
    const server = createServer((req, res) => {
      void Promise.resolve().then(() => {
        if (disposed) {
          sendJson(res, 503, { ok: false, error: "Service unavailable" });
          return;
        }
        const policy = validateGatewayRequest(req);
        if (!policy.ok) {
          sendJson(res, policy.status, { ok: false, error: policy.error });
          return;
        }
        const rawPath = requestPath(req);
        if (rawPath === null) {
          sendJson(res, 400, { ok: false, error: "Invalid request target" });
          return;
        }
        req[GATEWAY_REQUEST] = true;
        if (sendPwaAsset(req, res, rawPath, securityHeaders, isSecureRequest(req))) return;
        if (rawPath === "/api/auth.login") {
          return handleLogin(req, res);
        }
        if (rawPath === "/api/auth.passkey.login.options") {
          return handlePasskeyLoginOptions(req, res);
        }
        if (rawPath === "/api/auth.passkey.login.verify") {
          return handlePasskeyLoginVerify(req, res);
        }
        if (rawPath === "/api/auth.logout") {
          return handleLogout(req, res);
        }
        if (rawPath === "/_dsh/auth-webserver/state" ||
          rawPath === "/_dsh/auth-webserver/clients" ||
          rawPath === "/_dsh/auth-webserver/passkeys" ||
          rawPath === "/_dsh/auth-webserver/passkeys/register/options" ||
          rawPath === "/_dsh/auth-webserver/passkeys/register/verify" ||
          rawPath === "/_dsh/auth-webserver/passkeys/revoke" ||
          rawPath === "/_dsh/auth-webserver/save" ||
          rawPath === "/_dsh/auth-webserver/2fa" ||
          rawPath === "/_dsh/auth-webserver/clients/revoke" ||
          rawPath === "/_dsh/auth-webserver/sessions/revoke") {
          const auth = checkAuth(req);
          if (!auth) {
            sendUnauthorized(req, res, credentials().realm, rawPath, credentials().twoFactorEnabled, isSecureRequest(req), passkeyStore.hasAny());
            return;
          }
          if (rawPath === "/_dsh/auth-webserver/state") return handleState(req, res, auth);
          if (rawPath === "/_dsh/auth-webserver/clients") return handleClients(req, res, auth);
          if (rawPath === "/_dsh/auth-webserver/passkeys") return handlePasskeys(req, res);
          if (rawPath === "/_dsh/auth-webserver/passkeys/register/options") return handlePasskeyRegistrationOptions(req, res, auth);
          if (rawPath === "/_dsh/auth-webserver/passkeys/register/verify") return handlePasskeyRegistrationVerify(req, res, auth);
          if (rawPath === "/_dsh/auth-webserver/passkeys/revoke") return handlePasskeyRevoke(req, res, auth);
          if (rawPath === "/_dsh/auth-webserver/clients/revoke" || rawPath === "/_dsh/auth-webserver/sessions/revoke") return handleSessionRevoke(req, res, auth);
          if (rawPath === "/_dsh/auth-webserver/save") return handleSave(req, res);
          return handleTwoFactorSetup(req, res);
        }
        const publicPwaRequest = isPublicPwaRequest(req, rawPath);
        if (!publicPwaRequest && !checkAuth(req)) {
          sendUnauthorized(req, res, credentials().realm, rawPath, credentials().twoFactorEnabled, isSecureRequest(req), passkeyStore.hasAny());
          return;
        }
        return proxyRequest(req, res, rawPath);
      }).catch((error) => {
        ctx.logger?.warn?.("auth-webserver: request handler failed", error);
        if (res.headersSent) res.destroy();
        else sendJson(res, 500, { ok: false, error: "Request handling failed" });
      });
    });
    server.on("upgrade", (req, socket, head) => {
      void Promise.resolve().then(() => {
        if (disposed) {
          rejectUpgrade(socket, 503, "Service Unavailable");
          return;
        }
        const policy = validateGatewayRequest(req);
        if (!policy.ok) {
          rejectUpgrade(socket, policy.status, policy.error);
          return;
        }
        const rawPath = requestPath(req);
        if (rawPath === null) {
          rejectUpgrade(socket, 400, "Bad Request");
          return;
        }
        req[GATEWAY_REQUEST] = true;
        const auth = checkAuth(req);
        if (auth === null) {
          rejectUpgrade(socket, req[RATE_LIMITED_REQUEST] === true ? 429 : 401,
            req[RATE_LIMITED_REQUEST] === true ? "Too Many Requests" : "Unauthorized",
            req[RATE_LIMITED_REQUEST] === true ? { "Retry-After": String(config.loginWindowSeconds) } : {});
          return;
        }
        return proxyUpgrade(req, socket, head, auth);
      }).catch((error) => {
        ctx.logger?.warn?.("auth-webserver: upgrade handler failed", error);
        socket.destroy();
      });
    });
    server.requestTimeout = config.requestTimeoutMs;
    server.headersTimeout = config.headersTimeoutMs;
    server.keepAliveTimeout = config.keepAliveTimeoutMs;
    servers.push({ address, server });
  }

  let disposed = false;
  let closeAllPromise;
  const closeAll = () => {
    if (closeAllPromise !== undefined) return closeAllPromise;
    disposed = true;
    persistSessions();
    closeActiveSockets();
    closeAllPromise = Promise.all(servers.map(closeServer)).then(() => undefined);
    return closeAllPromise;
  };
  ctx.effect(() => closeAll, "auth-webserver: listeners and sessions");

  try {
    for (const record of servers) {
      if (disposed) return;
      await listenServer(record);
    }
    if (disposed) return;
  } catch (error) {
    await closeAll();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`auth-webserver: failed to bind gateway on ${config.port}: ${detail}`);
  }

  for (const { address } of servers) {
    ctx.logger?.info?.(`auth-webserver: LAN gateway listening on http://${address}:${config.port} -> http://${targetHost}:${targetPort}`);
  }
}
