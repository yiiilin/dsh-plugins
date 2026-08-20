/**
 * dsh-plugin-auth-webserver
 *
 * A DSH web bundle that replaces the stock webserver with a compatible
 * `webServer` service, binds to 0.0.0.0 by default, and requires either HTTP
 * Basic Auth or an HMAC-signed login cookie before routes/fallbacks run.
 *
 * Credential precedence is DSH_AUTH_USER/DSH_AUTH_PASS (or AUTH_USER/AUTH_PASS)
 * > cordis row config > plugin state at
 * $DSH_HOME/plugins/dsh-plugin-auth-webserver/state.json.
 */

import { createServer } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

export const name = "auth-webserver";

const COOKIE_NAME = "dsh_auth_token";
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 3600;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;
const STATE_DIR_SEGMENTS = ["plugins", "dsh-plugin-auth-webserver"];

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

export class AuthWebServer extends Service {
  static Config = z.object({
    host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).default("0.0.0.0"),
    port: z.natural().max(65535).default(3080),
    username: z.string().default("admin"),
    password: z.string().default(""),
    realm: z.string().default("DeepSeek Harness Authentication"),
  });

  exact = new Map();
  prefixes = new Map();
  upgrades = new Map();
  upgradedSockets = new Set();
  indexTaps = [];
  fallback;
  server;
  listenedPort;
  secret;

  constructor(ctx, config) {
    super(ctx, "webServer");
    this.config = config;
    this.loadState();
    this.secret = this.loadOrCreateSecret();

    this.register({
      kind: "exact",
      path: "/api/auth.login",
      handler: (req, res) => this.handleLogin(req, res),
    });
    this.register({
      kind: "exact",
      path: "/api/auth.logout",
      handler: (req, res) => this.handleLogout(req, res),
    });
  }

  loadState() {
    let state;
    try {
      state = JSON.parse(readFileSync(join(stateDir(), "state.json"), "utf8"));
    } catch {
      return;
    }
    if (state === null || typeof state !== "object") return;
    if (typeof state.username === "string") this.config.username = state.username;
    if (typeof state.password === "string") this.config.password = state.password;
    if (typeof state.realm === "string") this.config.realm = state.realm;
  }

  saveState() {
    try {
      const dir = stateDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state.json"), JSON.stringify({
        username: this.config.username ?? "admin",
        password: this.config.password ?? "",
        realm: this.config.realm ?? "DeepSeek Harness Authentication",
      }, null, 2), { encoding: "utf8", mode: 0o600 });
    } catch (error) {
      this.ctx.logger?.warn("auth-webserver: failed to persist auth state", error);
    }
  }

  loadOrCreateSecret() {
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

  credentials() {
    return {
      user: process.env.DSH_AUTH_USER || process.env.AUTH_USER || this.config.username || "admin",
      pass: process.env.DSH_AUTH_PASS || process.env.AUTH_PASS || this.config.password || "",
      realm: this.config.realm || "DeepSeek Harness Authentication",
    };
  }

  generateToken(user, pass) {
    const now = Date.now();
    const signature = createHmac("sha256", this.secret)
      .update(`${user}\u0000${pass}\u0000${now}`)
      .digest("hex");
    return `${now}.${signature}`;
  }

  verifyToken(token, user, pass) {
    if (typeof token !== "string") return false;
    const parts = token.split(".");
    if (parts.length !== 2) return false;
    const timestamp = Number(parts[0]);
    if (!Number.isFinite(timestamp)) return false;
    const age = Date.now() - timestamp;
    if (age < -60000 || age > SESSION_MAX_AGE_MS) return false;
    const expected = createHmac("sha256", this.secret)
      .update(`${user}\u0000${pass}\u0000${timestamp}`)
      .digest();
    let actual;
    try {
      actual = Buffer.from(parts[1], "hex");
    } catch {
      return false;
    }
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }

  checkAuth(req) {
    const { user, pass } = this.credentials();
    if (!pass) return false;

    const basic = parseBasic(req.headers.authorization);
    if (basic && safeEqual(basic.user, user) && safeEqual(basic.pass, pass)) {
      return true;
    }

    const cookies = parseCookies(req);
    if (cookies[COOKIE_NAME] && this.verifyToken(cookies[COOKIE_NAME], user, pass)) {
      return true;
    }
    return false;
  }

  async handleLogin(req, res) {
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

    const { user, pass } = this.credentials();
    const submittedUser = typeof body.username === "string" ? body.username : "";
    const submittedPass = typeof body.password === "string" ? body.password : "";
    if (!pass || !safeEqual(submittedUser, user) || !safeEqual(submittedPass, pass)) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Invalid username or password" }));
      return;
    }

    const token = this.generateToken(user, pass);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    });
    res.end(JSON.stringify({ ok: true, username: user }));
  }

  async handleLogout(req, res) {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    });
    res.end(JSON.stringify({ ok: true }));
  }

  renderLoginPage(res) {
    const realm = String(this.config.realm ?? "DeepSeek Harness Authentication")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
    <p>${realm}</p>
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" autofocus required>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in</button>
    <div id="error">Invalid username or password</div>
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
            password: document.getElementById("password").value
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
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(html);
  }

  sendUnauthorized(req, res, rawPath) {
    const accept = req.headers.accept ?? "";
    const wantsHtml = rawPath === "/" || rawPath === "/index.html"
      || (req.method === "GET" && accept.includes("text/html"));
    if (wantsHtml) {
      this.renderLoginPage(res);
      return;
    }
    res.writeHead(401, {
      "Content-Type": "application/json; charset=utf-8",
      "WWW-Authenticate": `Basic realm="${String(this.config.realm ?? "DeepSeek Harness Authentication").replace(/"/g, '\\"')}"`,
    });
    res.end(JSON.stringify({ ok: false, error: "Authentication required" }));
  }

  get port() {
    return this.listenedPort;
  }

  get host() {
    return this.config.host;
  }

  register(route) {
    const table = route.kind === "exact" ? this.exact : this.prefixes;
    if (table.has(route.path)) {
      throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
    }
    table.set(route.path, route);
    return () => {
      table.delete(route.path);
    };
  }

  registerUpgrade(route) {
    if (this.upgrades.has(route.path)) {
      throw new Error(`webserver: duplicate upgrade route "${route.path}"`);
    }
    this.upgrades.set(route.path, route);
    return () => {
      this.upgrades.delete(route.path);
    };
  }

  registerFallback(handler) {
    if (this.fallback !== undefined) {
      throw new Error("webserver: fallback already registered");
    }
    this.fallback = handler;
    return () => {
      this.fallback = undefined;
    };
  }

  tapIndex(transform) {
    this.indexTaps.push(transform);
    return () => {
      const index = this.indexTaps.indexOf(transform);
      if (index !== -1) this.indexTaps.splice(index, 1);
    };
  }

  match(pathname) {
    const exact = this.exact.get(pathname);
    if (exact !== undefined) return exact;
    let best;
    for (const [prefix, route] of this.prefixes) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
      if (best === undefined || prefix.length > best.path.length) best = route;
    }
    return best;
  }

  applyIndexTaps(html) {
    let output = html;
    for (const transform of this.indexTaps) output = transform(output);

    const polyfill = `<script>
(function() {
  var c = window.crypto || (window.crypto = {});
  if (typeof c.randomUUID !== 'function') {
    c.randomUUID = function() {
      if (typeof c.getRandomValues === 'function') {
        return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, function(ch) {
          return (ch ^ c.getRandomValues(new Uint8Array(1))[0] & 15 >> ch / 4).toString(16);
        });
      }
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(ch) {
        var r = Math.random() * 16 | 0, v = ch === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    };
  }
})();
</script>`;
    if (output.includes("<head>")) {
      output = output.replace("<head>", `<head>${polyfill}`);
    } else {
      output = `${polyfill}${output}`;
    }
    return output;
  }

  async [Service.init]() {
    const credentials = this.credentials();
    if (!credentials.pass) {
      throw new Error(
        "auth-webserver: a password is required before listening on the network; set DSH_AUTH_PASS/AUTH_PASS, row config password, or plugin state",
      );
    }

    const handle = async (req, res) => {
      const rawPath = new URL(req.url ?? "/", "http://x").pathname;
      if (rawPath === "/api/auth.login" || rawPath === "/api/auth.logout") {
        const route = this.exact.get(rawPath);
        if (route !== undefined) {
          await route.handler(req, res);
          return;
        }
      }

      if (!this.checkAuth(req)) {
        this.sendUnauthorized(req, res, rawPath);
        return;
      }

      const route = this.match(rawPath);
      if (route !== undefined) {
        await route.handler(req, res);
        return;
      }
      const fallback = this.fallback;
      if (fallback === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      await fallback(req, res);
    };

    this.server = createServer((req, res) => {
      handle(req, res).catch((error) => {
        this.ctx.logger?.warn(error instanceof Error ? error : new Error(String(error)));
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(400);
        res.end();
      });
    });

    this.server.on("upgrade", (req, socket, head) => {
      const onError = (error) => {
        this.ctx.logger?.warn(error);
        socket.destroy();
      };
      socket.on("error", onError);
      socket.once("close", () => {
        socket.off("error", onError);
        this.upgradedSockets.delete(socket);
      });

      if (!this.checkAuth(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      let route;
      try {
        route = this.upgrades.get(new URL(req.url ?? "/", "http://x").pathname);
      } catch (error) {
        this.ctx.logger?.warn(error instanceof Error ? error : new Error(String(error)));
        socket.destroy();
        return;
      }
      if (route === undefined) {
        socket.destroy();
        return;
      }
      this.upgradedSockets.add(socket);
      try {
        Promise.resolve(route.handler(req, socket, head)).catch((error) => {
          this.ctx.logger?.warn(error instanceof Error ? error : new Error(String(error)));
          socket.destroy();
        });
      } catch (error) {
        this.ctx.logger?.warn(error instanceof Error ? error : new Error(String(error)));
        socket.destroy();
      }
    });

    await new Promise((resolvePromise, rejectPromise) => {
      this.server.once("error", rejectPromise);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off("error", rejectPromise);
        this.server.on("error", (error) => {
          this.ctx.logger?.error(error);
        });
        this.listenedPort = this.server.address().port;
        resolvePromise();
      });
    });

    this.ctx.effect(() => async () => {
      const serverClosed = new Promise((resolvePromise) => {
        this.server.close(() => {
          resolvePromise();
        });
      });
      this.server.closeAllConnections();
      const upgradedClosed = [...this.upgradedSockets].map((socket) => new Promise((resolvePromise) => {
        socket.once("close", () => {
          resolvePromise();
        });
        socket.destroy();
      }));
      await Promise.all([serverClosed, ...upgradedClosed]);
    }, "webServer.listen");
  }
}

export default AuthWebServer;
