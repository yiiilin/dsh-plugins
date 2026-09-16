import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply } from "../index.js";

const DAY_SECONDS = 24 * 3600;

async function listen(server, host = "127.0.0.1") {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function httpRequest({ host, port, path, method = "GET", headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host, port, path, method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

/**
 * A minimal stand-in for the settings service: the row config seeds the base
 * layer, `update` writes the user layer, and every write notifies the watchers
 * exactly like the real service's live-apply path does.
 */
function createSettingsService(base) {
  const user = {};
  const watchers = new Set();
  const value = () => ({ ...base, ...user });
  return {
    writable: true,
    updateCalls: [],
    register() {
      return {
        get: value,
        watch(callback) {
          watchers.add(callback);
          return () => watchers.delete(callback);
        },
      };
    },
    describe: () => [{ ns: "auth-webserver", user: { ...user }, secrets: [] }],
    async update(_ns, patch) {
      const previous = value();
      this.updateCalls.push({ ...patch });
      Object.assign(user, patch);
      const next = value();
      for (const callback of watchers) callback(next, previous);
    },
  };
}

function cookieValue(response, name) {
  const header = response.headers["set-cookie"];
  const entries = Array.isArray(header) ? header : [header];
  const entry = entries.find((value) => typeof value === "string" && value.startsWith(`${name}=`));
  assert.ok(entry !== undefined, `expected a ${name} cookie`);
  return entry.split(";", 1)[0];
}

test("edits the session lifetimes behind a step-up check and applies them live", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-auth-webserver-policy-"));
  const savedHome = process.env.DSH_HOME;
  const savedAuthUser = process.env.DSH_AUTH_USER;
  const savedAuthPass = process.env.DSH_AUTH_PASS;
  const savedUser = process.env.AUTH_USER;
  const savedPass = process.env.AUTH_PASS;
  delete process.env.DSH_AUTH_USER;
  delete process.env.DSH_AUTH_PASS;
  delete process.env.AUTH_USER;
  delete process.env.AUTH_PASS;
  process.env.DSH_HOME = home;

  const core = createServer((req, res) => {
    if (req.url?.startsWith("/?token=core-process-token") === true) {
      res.writeHead(303, {
        location: "/",
        "set-cookie": ["dsh-auth-current=v1.body.signature; Max-Age=60; Path=/; HttpOnly"],
      });
      res.end();
      return;
    }
    if (req.headers.cookie !== "dsh-auth-current=v1.body.signature") {
      res.writeHead(401);
      res.end("core unauthorized");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(req.url ?? "");
  });
  const corePort = await listen(core);
  const gatewayProbe = createServer();
  const gatewayPort = await listen(gatewayProbe, "127.0.0.2");
  await close(gatewayProbe);

  const settings = createSettingsService({
    username: "admin",
    password: "gateway-pass",
    realm: "Test",
    twoFactorEnabled: false,
    twoFactorSecret: "",
    authEpoch: 0,
  });
  const effects = [];
  const ctx = {
    connection: {
      authenticatedUrl(baseUrl) {
        return `${baseUrl}/?token=core-process-token`;
      },
    },
    logger: { warn() {}, info() {} },
    get(name) {
      return name === "settings" ? settings : undefined;
    },
    effect(factory) {
      const disposer = factory();
      effects.push(disposer);
      return disposer;
    },
  };

  try {
    await apply(ctx, {
      port: gatewayPort,
      targetHost: "127.0.0.1",
      targetPort: corePort,
      addresses: ["127.0.0.2"],
      allowedOrigins: [`http://127.0.0.2:${gatewayPort}`],
      username: "admin",
      password: "gateway-pass",
      // The row config seeds the settings base layer; the card overrides it.
      sessionIdleTimeoutSeconds: 3 * DAY_SECONDS,
    });

    const origin = `http://127.0.0.2:${gatewayPort}`;
    const submitted = JSON.stringify({ username: "admin", password: "gateway-pass" });
    const login = await httpRequest({
      host: "127.0.0.2",
      port: gatewayPort,
      path: "/api/auth.login",
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(submitted)),
      },
      body: submitted,
    });
    assert.equal(login.statusCode, 200);
    const cookie = cookieValue(login, "dsh_auth_token");
    const csrf = cookieValue(login, "dsh_auth_csrf");

    const save = (payload) => {
      const body = JSON.stringify(payload);
      return httpRequest({
        host: "127.0.0.2",
        port: gatewayPort,
        path: "/_dsh/auth-webserver/save",
        method: "POST",
        headers: {
          origin,
          cookie: `${cookie}; ${csrf}`,
          "x-dsh-csrf": csrf.split("=", 2)[1],
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
        body,
      });
    };
    const state = async () => {
      const response = await httpRequest({
        host: "127.0.0.2",
        port: gatewayPort,
        path: "/_dsh/auth-webserver/state",
        headers: { origin, cookie },
      });
      assert.equal(response.statusCode, 200);
      return JSON.parse(response.body).state;
    };

    const initial = await state();
    assert.equal(initial.idleSeconds, 3 * DAY_SECONDS, "the row config seeds the effective lifetime");
    assert.equal(initial.maxAgeSeconds, 0);
    assert.equal(initial.sessionLifetimeFromSettings, false);
    assert.equal(initial.sessions.length, 1);

    // Policy is a privilege change: the session and CSRF token alone are not enough.
    const refused = await save({ sessionIdleTimeoutSeconds: 600 });
    assert.equal(refused.statusCode, 403);
    assert.deepEqual(settings.updateCalls, []);
    assert.equal((await state()).idleSeconds, 3 * DAY_SECONDS);

    // An unchanged value needs no step-up at all.
    const unchanged = await save({ sessionIdleTimeoutSeconds: 3 * DAY_SECONDS, sessionMaxAgeSeconds: 0 });
    assert.equal(unchanged.statusCode, 200);
    assert.deepEqual(settings.updateCalls, []);

    // Out-of-range values are rejected before anything is written.
    const tooLong = await save({ sessionMaxAgeSeconds: 31 * DAY_SECONDS, currentPassword: "gateway-pass" });
    assert.equal(tooLong.statusCode, 400);
    assert.deepEqual(settings.updateCalls, []);

    const applied = await save({
      sessionIdleTimeoutSeconds: 600,
      sessionMaxAgeSeconds: 2 * DAY_SECONDS,
      currentPassword: "gateway-pass",
    });
    assert.equal(applied.statusCode, 200, applied.body);
    const next = JSON.parse(applied.body).state;
    assert.equal(next.idleSeconds, 600);
    assert.equal(next.maxAgeSeconds, 2 * DAY_SECONDS);
    assert.equal(next.sessionLifetimeFromSettings, true);
    assert.deepEqual(settings.updateCalls, [{ sessionIdleTimeoutSeconds: 600, sessionMaxAgeSeconds: 2 * DAY_SECONDS }]);

    // The running store adopted the new window, and the change did not revoke
    // the session that made it.
    assert.deepEqual(next.sessions.map((session) => session.id), initial.sessions.map((session) => session.id));
    const deadline = next.sessions[0].expiresAt - Date.now();
    assert.ok(deadline > 0 && deadline <= 600 * 1000 + 2000, `the new idle window must govern, got ${String(deadline)}ms`);
    assert.ok((await state()).sessions.length === 1);
  } finally {
    const closeGateway = effects.at(-1);
    if (typeof closeGateway === "function") await closeGateway();
    await close(core);
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    if (savedAuthUser === undefined) delete process.env.DSH_AUTH_USER;
    else process.env.DSH_AUTH_USER = savedAuthUser;
    if (savedAuthPass === undefined) delete process.env.DSH_AUTH_PASS;
    else process.env.DSH_AUTH_PASS = savedAuthPass;
    if (savedUser === undefined) delete process.env.AUTH_USER;
    else process.env.AUTH_USER = savedUser;
    if (savedPass === undefined) delete process.env.AUTH_PASS;
    else process.env.AUTH_PASS = savedPass;
  }
});

test("a lifetime change keeps other sessions and their deadlines intact", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-auth-webserver-policy-"));
  const savedHome = process.env.DSH_HOME;
  const savedAuthUser = process.env.DSH_AUTH_USER;
  const savedAuthPass = process.env.DSH_AUTH_PASS;
  const savedUser = process.env.AUTH_USER;
  const savedPass = process.env.AUTH_PASS;
  delete process.env.DSH_AUTH_USER;
  delete process.env.DSH_AUTH_PASS;
  delete process.env.AUTH_USER;
  delete process.env.AUTH_PASS;
  process.env.DSH_HOME = home;

  const core = createServer((req, res) => {
    if (req.url?.startsWith("/?token=core-process-token") === true) {
      res.writeHead(303, {
        location: "/",
        "set-cookie": ["dsh-auth-current=v1.body.signature; Max-Age=60; Path=/; HttpOnly"],
      });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(req.url ?? "");
  });
  const corePort = await listen(core);
  const gatewayProbe = createServer();
  const gatewayPort = await listen(gatewayProbe, "127.0.0.2");
  await close(gatewayProbe);

  const settings = createSettingsService({
    username: "admin",
    password: "gateway-pass",
    realm: "Test",
    twoFactorEnabled: false,
    twoFactorSecret: "",
    authEpoch: 0,
  });
  const effects = [];
  const ctx = {
    connection: {
      authenticatedUrl(baseUrl) {
        return `${baseUrl}/?token=core-process-token`;
      },
    },
    logger: { warn() {}, info() {} },
    get(name) {
      return name === "settings" ? settings : undefined;
    },
    effect(factory) {
      const disposer = factory();
      effects.push(disposer);
      return disposer;
    },
  };

  try {
    await apply(ctx, {
      port: gatewayPort,
      targetHost: "127.0.0.1",
      targetPort: corePort,
      addresses: ["127.0.0.2"],
      allowedOrigins: [`http://127.0.0.2:${gatewayPort}`],
      username: "admin",
      password: "gateway-pass",
      sessionIdleTimeoutSeconds: 3600,
      sessionMaxAgeSeconds: 2 * DAY_SECONDS,
    });

    const origin = `http://127.0.0.2:${gatewayPort}`;
    const submitted = JSON.stringify({ username: "admin", password: "gateway-pass" });
    const login = (agent) => httpRequest({
      host: "127.0.0.2",
      port: gatewayPort,
      path: "/api/auth.login",
      method: "POST",
      headers: {
        origin,
        "user-agent": agent,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(submitted)),
      },
      body: submitted,
    });
    const first = await login("Desktop");
    const second = await login("Mobile");
    assert.equal(second.statusCode, 200);
    const cookie = cookieValue(first, "dsh_auth_token");
    const csrf = cookieValue(first, "dsh_auth_csrf");
    const token = csrf.split("=", 2)[1];

    const list = async () => {
      const response = await httpRequest({
        host: "127.0.0.2",
        port: gatewayPort,
        path: "/_dsh/auth-webserver/state",
        headers: { origin, cookie },
      });
      assert.equal(response.statusCode, 200);
      return JSON.parse(response.body).state.sessions;
    };
    const before = await list();
    assert.equal(before.length, 2);

    const body = JSON.stringify({ sessionMaxAgeSeconds: 0, currentPassword: "gateway-pass" });
    const response = await httpRequest({
      host: "127.0.0.2",
      port: gatewayPort,
      path: "/_dsh/auth-webserver/save",
      method: "POST",
      headers: {
        origin,
        cookie: `${cookie}; ${csrf}`,
        "x-dsh-csrf": token,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
    });
    assert.equal(response.statusCode, 200, response.body);
    const after = JSON.parse(response.body).state.sessions;
    assert.deepEqual(after.map((session) => session.id).sort(), before.map((session) => session.id).sort());
    assert.equal(JSON.parse(response.body).state.maxAgeSeconds, 0);
    // Dropping the ceiling lets the idle window govern again.
    for (const session of after) {
      const remaining = session.expiresAt - Date.now();
      assert.ok(remaining > 0 && remaining <= 3600 * 1000 + 2000, `unexpected remaining lifetime: ${String(remaining)}`);
    }
  } finally {
    const closeGateway = effects.at(-1);
    if (typeof closeGateway === "function") await closeGateway();
    await close(core);
    rmSync(home, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    if (savedAuthUser === undefined) delete process.env.DSH_AUTH_USER;
    else process.env.DSH_AUTH_USER = savedAuthUser;
    if (savedAuthPass === undefined) delete process.env.DSH_AUTH_PASS;
    else process.env.DSH_AUTH_PASS = savedAuthPass;
    if (savedUser === undefined) delete process.env.AUTH_USER;
    else process.env.AUTH_USER = savedUser;
    if (savedPass === undefined) delete process.env.AUTH_PASS;
    else process.env.AUTH_PASS = savedPass;
  }
});
