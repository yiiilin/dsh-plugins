import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply } from "../index.js";

/**
 * A passkey request refused for transport reasons must say why: the browser runs
 * no WebAuthn call at all, so the HTTP status and the log line are the only
 * evidence a user (or an operator) ever gets. Before this contract the endpoint
 * answered every failure with "Passkeys require HTTPS (except localhost)" and
 * the client folded it into a generic retry message.
 */

const CONFIG = {
  username: "admin",
  password: "gateway-pass",
};

async function listen(server, host) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

function postJson({ host, port, path, body, cookie, csrf }) {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      host,
      port,
      path,
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: `http://${host}:${port}`,
        "sec-fetch-site": "same-origin",
        ...(cookie === undefined ? {} : { cookie }),
        ...(csrf === undefined ? {} : { "x-dsh-csrf": csrf }),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.once("error", reject);
    outgoing.end(JSON.stringify(body));
  });
}

test("answers a plain-HTTP passkey registration with the transport reason and logs it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "dsh-auth-webserver-passkey-"));
  const savedHome = process.env.DSH_HOME;
  const savedEnv = ["DSH_AUTH_USER", "DSH_AUTH_PASS", "AUTH_USER", "AUTH_PASS"].map((name) => [name, process.env[name]]);
  for (const [name] of savedEnv) delete process.env[name];
  process.env.DSH_HOME = home;

  const warnings = [];
  const effects = [];
  const settingsScope = {
    get: () => ({ ...CONFIG, realm: "Test", twoFactorEnabled: false, twoFactorSecret: "", authEpoch: 0 }),
    watch: () => () => {},
  };
  const ctx = {
    connection: { authenticatedUrl: (baseUrl) => baseUrl },
    logger: { warn: (...args) => warnings.push(args.map(String).join(" ")), info() {} },
    get(name) {
      if (name === "settings") {
        return {
          writable: false,
          register: () => settingsScope,
          describe: () => [{ ns: "auth-webserver", user: {}, secrets: [] }],
          update: async () => {},
        };
      }
      if (name === "webServer") return { tapIndex: () => () => {}, register: () => () => {} };
      return undefined;
    },
    effect(factory) {
      const disposer = factory();
      effects.push(disposer);
      return disposer;
    },
  };

  const probe = createServer();
  const port = await listen(probe, "127.0.0.2");
  await new Promise((resolve) => probe.close(resolve));

  try {
    await apply(ctx, {
      port,
      targetHost: "127.0.0.1",
      targetPort: 1,
      addresses: ["127.0.0.2"],
      allowedOrigins: [`http://127.0.0.2:${port}`],
      ...CONFIG,
    });

    // Passkey management needs the browser session, so sign in first: the
    // endpoint answers a bare Basic request with "session required" before it
    // ever reaches the transport rule this test is about.
    const login = await postJson({
      host: "127.0.0.2",
      port,
      path: "/api/auth.login",
      body: { username: CONFIG.username, password: CONFIG.password },
    });
    assert.equal(login.statusCode, 200, `login should succeed, got ${login.body}`);
    const setCookies = (login.headers["set-cookie"] ?? [])
      .map((entry) => entry.split(";")[0])
      .filter((entry) => !entry.endsWith("="));
    const cookie = setCookies.join("; ");
    const csrf = (setCookies.find((entry) => entry.includes("csrf")) ?? "").split("=").slice(1).join("=");
    assert.ok(cookie.includes("dsh_auth_token"), `session cookie expected, got ${cookie}`);
    assert.notEqual(csrf, "", "csrf cookie expected");

    const refused = await postJson({
      host: "127.0.0.2",
      port,
      path: "/_dsh/auth-webserver/passkeys/register/options",
      body: { currentPassword: CONFIG.password, currentOtp: "" },
      cookie,
      csrf,
    });
    assert.equal(refused.statusCode, 400);
    assert.match(JSON.parse(refused.body).error, /HTTPS/u, "the refusal names the transport rule");
    assert.ok(
      warnings.some((line) => line.includes("passkey") && line.includes("refused")
        && line.includes("registration options") && /tls=(false|%s)/u.test(line) && line.includes("127.0.0.1")),
      `the transport facts are logged, got: ${JSON.stringify(warnings)}`,
    );

    const wrongStepUp = await postJson({
      host: "127.0.0.2",
      port,
      path: "/_dsh/auth-webserver/passkeys/register/options",
      body: { currentPassword: "not-the-password", currentOtp: "" },
      cookie,
      csrf,
    });
    assert.equal(wrongStepUp.statusCode, 403, "step-up credentials are still required first");
  } finally {
    for (const dispose of effects.reverse()) {
      if (typeof dispose === "function") await dispose();
    }
    rmSync(home, { recursive: true, force: true });
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
  }
});
