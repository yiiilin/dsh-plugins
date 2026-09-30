import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply } from "../index.js";

/**
 * A gateway mounted inside an HMR transaction must still be able to save settings.
 *
 * DSH mounts a profile row with `hmr.runExclusive(apply)`, and `dsh-hmr` marks
 * that scope with an `AsyncLocalStorage`. This plugin creates its own HTTP
 * listener inside `apply()`, so every request the listener later serves inherits
 * that mark — and `settings.update()` then rejects with
 * "HMR transactions cannot be nested", which is what made 2FA unsavable.
 *
 * The fake settings service below mirrors that guard exactly: it refuses a write
 * issued while the marker is visible. The gateway must therefore present a clean
 * context for its writes.
 */

const executing = new AsyncLocalStorage();

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
    import("node:http").then(({ request }) => {
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
    }, reject);
  });
}

function cookieValue(response, name) {
  const header = response.headers["set-cookie"];
  const entries = Array.isArray(header) ? header : [header];
  const entry = entries.find((value) => typeof value === "string" && value.startsWith(`${name}=`));
  assert.ok(entry !== undefined, `expected a ${name} cookie`);
  return entry.split(";", 1)[0];
}

/** Settings service that rejects exactly like `dsh-hmr.runExclusive` does. */
function hmrGuardedSettingsService(base) {
  const user = {};
  const watchers = new Set();
  const value = () => ({ ...base, ...user });
  return {
    writable: true,
    updateCalls: [],
    rejectedAsNested: 0,
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
      if (executing.getStore()) {
        this.rejectedAsNested += 1;
        throw new Error("HMR transactions cannot be nested");
      }
      this.updateCalls.push({ ...patch });
      Object.assign(user, patch);
      const next = value();
      for (const callback of watchers) callback(next, value());
    },
  };
}

test("a gateway mounted inside an HMR transaction can still save settings", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-auth-webserver-hmr-"));
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

  const { createServer } = await import("node:http");
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

  const settings = hmrGuardedSettingsService({
    username: "admin",
    password: "gateway-pass",
    realm: "Test",
    twoFactorEnabled: false,
    twoFactorSecret: "",
    authEpoch: 0,
  });

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

  const options = {
    port: gatewayPort,
    targetHost: "127.0.0.1",
    targetPort: corePort,
    addresses: ["127.0.0.2"],
    allowedOrigins: [`http://127.0.0.2:${gatewayPort}`],
    username: "admin",
    password: "gateway-pass",
    requireTwoFactor: false,
  };

  try {
    // Exactly how the host mounts a row: apply() runs inside the HMR transaction.
    await executing.run(true, () => apply(ctx, options));

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

    assert.equal(
      settings.rejectedAsNested,
      0,
      "the gateway must not present the inherited HMR transaction to a settings write",
    );
    assert.equal(write.statusCode, 200, `write should commit, got ${write.statusCode}: ${write.body}`);
    assert.equal(settings.updateCalls.length, 1, "the write reached the settings document");

    // The successful write revokes sessions by design, so a fresh login must work
    // and the saved state must be visible.
    const relogin = await httpRequest({
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
    assert.equal(relogin.statusCode, 200, "the gateway stays usable after a committed write");
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
});