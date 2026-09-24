import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply } from "../index.js";

/**
 * A failed settings write must not invalidate live sessions.
 *
 * `updateSettingsAndRevoke` raises the in-memory auth epoch before it awaits the
 * write and never lowers it again. Session tokens are signed over that epoch, so
 * a write that rejects — a revision conflict, a read-only document, or RC.1's
 * "HMR transactions cannot be nested" — left every issued token unverifiable and
 * turned the next page load into a login redirect.
 */

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve(address.port);
    });
  });
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
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.on("error", reject);
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });
}

function cookieValue(response, name) {
  const header = response.headers["set-cookie"];
  const entries = Array.isArray(header) ? header : [header];
  const entry = entries.find((value) => typeof value === "string" && value.startsWith(`${name}=`));
  assert.ok(entry !== undefined, `expected a ${name} cookie`);
  return entry.split(";", 1)[0];
}

/** Settings service whose `update` rejects, like RC.1 does inside an HMR transaction. */
function rejectingSettingsService(base, failure) {
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
    describe: () => [{ ns: "auth-webserver", revision: 1, user: { ...user }, secrets: [] }],
    async update(_ns, patch) {
      this.updateCalls.push({ ...patch });
      throw failure;
    },
  };
}

async function runFailedWrite(failure) {
  const home = mkdtempSync(join(tmpdir(), "dsh-auth-webserver-epoch-"));
  const saved = {
    DSH_HOME: process.env.DSH_HOME,
    DSH_AUTH_USER: process.env.DSH_AUTH_USER,
    DSH_AUTH_PASS: process.env.DSH_AUTH_PASS,
    AUTH_USER: process.env.AUTH_USER,
    AUTH_PASS: process.env.AUTH_PASS,
  };
  delete process.env.DSH_AUTH_USER;
  delete process.env.DSH_AUTH_PASS;
  delete process.env.AUTH_USER;
  delete process.env.AUTH_PASS;
  process.env.DSH_HOME = home;

  // A loopback core the gateway can bootstrap a session against.
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

  const settings = rejectingSettingsService({
    username: "admin",
    password: "gateway-pass",
    realm: "Test",
    twoFactorEnabled: false,
    twoFactorSecret: "",
    authEpoch: 0,
  }, failure);

  const effects = [];
  const ctx = {
    connection: { authenticatedUrl: (baseUrl) => `${baseUrl}/?token=core-process-token` },
    logger: { warn() {}, info() {} },
    get(name) { return name === "settings" ? settings : undefined; },
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
      requireTwoFactor: false,
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
    assert.equal(login.statusCode, 200, login.body);
    const cookie = cookieValue(login, "dsh_auth_token");
    const csrf = cookieValue(login, "dsh_auth_csrf");

    // The disable action uses the same write path as enabling 2FA, and leaves the
    // security posture untouched because 2FA is already off.
    const twoFactor = JSON.stringify({ action: "disable", currentPassword: "gateway-pass" });
    const write = await httpRequest({
      host: "127.0.0.2",
      port: gatewayPort,
      path: "/_dsh/auth-webserver/2fa",
      method: "POST",
      headers: {
        origin,
        cookie: `${cookie}; ${csrf}`,
        "x-dsh-csrf": csrf.split("=", 2)[1],
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(twoFactor)),
      },
      body: twoFactor,
    });

    const after = await httpRequest({
      host: "127.0.0.2",
      port: gatewayPort,
      path: "/_dsh/auth-webserver/state",
      headers: { origin, cookie },
    });

    return { write, after, updateCalls: settings.updateCalls };
  } finally {
    for (const dispose of effects.reverse()) await dispose();
    await close(core);
    if (saved.DSH_HOME === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = saved.DSH_HOME;
    for (const key of ["DSH_AUTH_USER", "DSH_AUTH_PASS", "AUTH_USER", "AUTH_PASS"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test("a failed settings write keeps the session it was asked to change usable", async () => {
  const failure = new Error("HMR transactions cannot be nested");
  const { write, after, updateCalls } = await runFailedWrite(failure);

  assert.equal(updateCalls.length, 1, "the gateway attempted exactly one settings write");
  assert.equal(write.statusCode, 400, "the caller is told the write failed");
  assert.match(write.body, /HMR transactions cannot be nested/u);
  assert.equal(
    after.statusCode,
    200,
    "a rejected settings write must not invalidate live sessions — the auth epoch may only advance with a committed write",
  );
});

test("a failed settings write leaves the auth epoch where it was", async () => {
  const failure = new Error("settings document is read-only");
  const { write, after } = await runFailedWrite(failure);

  assert.equal(write.statusCode, 400);
  assert.equal(after.statusCode, 200, after.body);
  const state = JSON.parse(after.body).state;
  assert.equal(state.twoFactorEnabled, false, "a failed write changes no security state");
});