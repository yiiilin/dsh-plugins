import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply } from "../index.js";

const CRLF = String.fromCharCode(13, 10);

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

function httpRequest({ host, port, path, method = "GET", headers = {} }) {
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
    outgoing.end();
  });
}

function websocketRequest({ host, port, path, headers }) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, host);
    let response = "";
    socket.once("error", reject);
    socket.once("connect", () => {
      const lines = [`GET ${path} HTTP/1.1`, `Host: ${host}:${port}`];
      for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
      lines.push("", "");
      socket.write(lines.join(CRLF));
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (!response.includes(CRLF + CRLF)) return;
      resolve({ response, socket });
    });
  });
}

test("bridges gateway-authenticated traffic to core after a stale public token", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "dsh-auth-webserver-integration-"));
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

  const coreRequests = [];
  const coreUpgrades = [];
  const coreSockets = [];
  const core = createServer((req, res) => {
    coreRequests.push({ url: req.url, headers: { ...req.headers } });
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
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "set-cookie": [
        "dsh-auth-leak=v1.body.signature; Max-Age=60; Path=/",
        "app=visible; Path=/",
      ],
    });
    res.end(req.url ?? "");
  });
  core.on("upgrade", (req, socket) => {
    coreSockets.push(socket);
    coreUpgrades.push({ url: req.url, headers: { ...req.headers } });
    if (req.headers.cookie !== "dsh-auth-current=v1.body.signature") {
      socket.end(["HTTP/1.1 401 Unauthorized", "Connection: close", "", ""].join(CRLF));
      return;
    }
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Set-Cookie: dsh-auth-leak=v1.body.signature; Max-Age=60; Path=/",
      "",
      "",
    ].join(CRLF));
  });
  const corePort = await listen(core);
  const gatewayProbe = createServer();
  const gatewayPort = await listen(gatewayProbe, "127.0.0.2");
  await close(gatewayProbe);

  const effects = [];
  const settingsScope = {
    get: () => ({ username: "admin", password: "gateway-pass", realm: "Test", twoFactorEnabled: false, twoFactorSecret: "", authEpoch: 0 }),
    watch: () => () => {},
  };
  const settings = {
    writable: false,
    register: () => settingsScope,
    describe: () => [{ ns: "auth-webserver", user: {}, secrets: [] }],
    update: async () => {},
  };
  const webServer = {
    tapIndex: () => () => {},
    register: () => () => {},
  };
  const ctx = {
    connection: {
      authenticatedUrl(baseUrl) {
        return `${baseUrl}/?token=core-process-token`;
      },
    },
    logger: {
      warn() {},
      info() {},
    },
    get(name) {
      if (name === "settings") return settings;
      if (name === "webServer") return webServer;
      return undefined;
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
      allowedHosts: ["127.0.0.2"],
      username: "admin",
      password: "gateway-pass",
    });

    const authorization = `Basic ${Buffer.from("admin:gateway-pass").toString("base64")}`;
    const publicOrigin = `http://127.0.0.2:${gatewayPort}`;
    const response = await httpRequest({
      host: "127.0.0.2",
      port: gatewayPort,
      path: "/?token=stale-process-token&view=chat",
      headers: {
        authorization,
        origin: publicOrigin,
        cookie: "dsh-auth-attacker=bad; dsh_auth_token=gateway-cookie",
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body, "/?view=chat");
    assert.deepEqual(response.headers["set-cookie"], ["app=visible; Path=/"]);
    assert.equal(coreRequests.length, 2);
    assert.equal(coreRequests[0].url, "/?token=core-process-token");
    assert.equal(coreRequests[0].headers.cookie, undefined);
    assert.equal(coreRequests[1].url, "/?view=chat");
    assert.equal(coreRequests[1].headers.host, `127.0.0.1:${corePort}`);
    assert.equal(coreRequests[1].headers.origin, `http://127.0.0.1:${corePort}`);
    assert.equal(coreRequests[1].headers.cookie, "dsh-auth-current=v1.body.signature");
    assert.equal(coreRequests[1].headers.authorization, undefined);

    const apiResponse = await httpRequest({
      host: "127.0.0.2",
      port: gatewayPort,
      path: "/api/health?token=another-stale-token",
      method: "GET",
      headers: { authorization, origin: publicOrigin },
    });
    assert.equal(apiResponse.statusCode, 200);
    assert.equal(apiResponse.body, "/api/health");
    assert.equal(coreRequests.length, 3);

    const upgrade = await websocketRequest({
      host: "127.0.0.2",
      port: gatewayPort,
      path: "/api/remote.mux?token=stale-websocket-token",
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        Origin: publicOrigin,
        Authorization: authorization,
        Cookie: "dsh-auth-attacker=bad",
        "Sec-WebSocket-Key": "dGVzdC1rZXk=",
        "Sec-WebSocket-Version": "13",
      },
    });
    assert.match(upgrade.response, /^HTTP\/1\.1 101 Switching Protocols\r\n/u);
    assert.equal(upgrade.response.includes("dsh-auth-leak"), false);
    assert.equal(coreUpgrades.length, 1);
    assert.equal(coreUpgrades[0].url, "/api/remote.mux");
    assert.equal(coreUpgrades[0].headers.host, `127.0.0.1:${corePort}`);
    assert.equal(coreUpgrades[0].headers.origin, `http://127.0.0.1:${corePort}`);
    assert.equal(coreUpgrades[0].headers.cookie, "dsh-auth-current=v1.body.signature");
    upgrade.socket.destroy();
  } finally {
    const closeGateway = effects.at(-1);
    if (typeof closeGateway === "function") await closeGateway();
    for (const socket of coreSockets) socket.destroy();
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
