import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  attachCoreCookie,
  createCoreSessionBridge,
  createLoopbackTarget,
  stripCoreCookies,
  stripCoreSetCookies,
  stripLaunchToken,
} from "../core-session.js";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("builds a loopback target and rejects remote token destinations", () => {
  assert.deepEqual(createLoopbackTarget("127.0.0.1", 3080), {
    hostname: "127.0.0.1",
    port: 3080,
    authority: "127.0.0.1:3080",
    origin: "http://127.0.0.1:3080",
  });
  assert.deepEqual(createLoopbackTarget("[::1]", 3080), {
    hostname: "::1",
    port: 3080,
    authority: "[::1]:3080",
    origin: "http://[::1]:3080",
  });
  assert.throws(() => createLoopbackTarget("192.0.2.20", 3080), /loopback address/u);
  assert.throws(() => createLoopbackTarget("127.0.0.1", 0), /port is invalid/u);
});

test("removes a public launch token and replaces client core cookies", () => {
  assert.equal(stripLaunchToken("/?token=old-secret&view=chat"), "/?view=chat");
  const combo = "/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=boot-1";
  assert.equal(stripLaunchToken(combo), combo);
  assert.equal(stripCoreCookies("dsh-auth-old=attacker; dsh_auth_token=gateway; theme=dark"), "dsh_auth_token=gateway; theme=dark");
  assert.equal(attachCoreCookie("dsh-auth-old=attacker; dsh_auth_token=gateway", {
    name: "dsh-auth-current",
    value: "v1.body.signature",
  }), "dsh_auth_token=gateway; dsh-auth-current=v1.body.signature");
});

test("filters core bearer cookies from public upstream responses", () => {
  const headers = {
    "set-cookie": [
      "dsh-auth-current=v1.body.signature; Max-Age=30; Path=/",
      "app=visible; Path=/",
    ],
  };
  stripCoreSetCookies(headers);
  assert.deepEqual(headers["set-cookie"], ["app=visible; Path=/"]);

  const onlyCore = { "set-cookie": "dsh-auth-current=v1.body.signature; Max-Age=30; Path=/" };
  stripCoreSetCookies(onlyCore);
  assert.equal(Object.hasOwn(onlyCore, "set-cookie"), false);
});

test("bootstraps one current core cookie for concurrent requests", async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: { ...req.headers } });
    res.writeHead(303, {
      location: "/",
      "set-cookie": ["dsh-auth-current=v1.body.signature; Max-Age=60; Path=/; HttpOnly"],
    });
    res.end();
  });
  const port = await listen(server);
  t.after(() => close(server));

  const target = createLoopbackTarget("127.0.0.1", port);
  let tokenCalls = 0;
  const bridge = createCoreSessionBridge({
    authenticatedUrl(baseUrl) {
      tokenCalls += 1;
      return `${baseUrl}/?token=current-process-token`;
    },
  }, target, { timeoutMs: 1000 });
  t.after(() => bridge.dispose());

  const [first, second] = await Promise.all([bridge.ensure(), bridge.ensure()]);
  assert.equal(tokenCalls, 1);
  assert.deepEqual(first, second);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/?token=current-process-token");
  assert.equal(requests[0].headers.host, target.authority);
  assert.equal(requests[0].headers.cookie, undefined);
  assert.equal(requests[0].headers.origin, undefined);

  bridge.invalidate();
  await bridge.ensure();
  assert.equal(tokenCalls, 2);
  assert.equal(requests.length, 2);
});

test("rejects a malformed core exchange and clears the pending request", async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("not an exchange");
  });
  const port = await listen(server);
  t.after(() => close(server));

  const bridge = createCoreSessionBridge({
    authenticatedUrl(baseUrl) {
      return `${baseUrl}/?token=current-process-token`;
    },
  }, createLoopbackTarget("127.0.0.1", port), { timeoutMs: 1000 });
  t.after(() => bridge.dispose());

  await assert.rejects(bridge.ensure(), /exchange was rejected/u);
  await assert.rejects(bridge.ensure(), /exchange was rejected/u);
});
