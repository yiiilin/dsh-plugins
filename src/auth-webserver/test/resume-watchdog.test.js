import assert from "node:assert/strict";
import test from "node:test";
import {
  FakeWindow,
  createContext,
  createSlots,
  createTime,
  loadBundle,
  settle,
} from "./support/browser-harness.js";

const AUTH_MODULE = new URL("../client.js", import.meta.url);

function boot() {
  const time = createTime();
  const win = new FakeWindow(time);
  const client = loadBundle(AUTH_MODULE, win);
  const reconnects = [];
  const connection = {
    reconnect: () => {
      reconnects.push(time.now());
    },
  };
  const harness = createContext({ connection, slots: createSlots() });
  client.apply(harness.ctx);
  return { time, win, reconnects, connection, harness };
}

function pageshow(win, persisted) {
  win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));
}

test("BUG-RESUME-1: a page returning after a long suspension rebuilds its connection", async () => {
  const { time, win, reconnects, harness } = boot();
  // The phone locks with dsh in the foreground; its carrier dies silently.
  win.hide();
  time.advance(10 * 60 * 1000);
  win.show();
  await settle();
  assert.equal(reconnects.length, 1, "unlocking after a long suspension must rebuild the connection");
  harness.disposeAll();
});

test("a quick app switch leaves the connection alone", async () => {
  const { time, win, reconnects, harness } = boot();
  win.hide();
  time.advance(5 * 1000);
  win.show();
  await settle();
  assert.equal(reconnects.length, 0, "a five-second switch must not churn the transport");
  harness.disposeAll();
});

test("a narrow viewport forced to desktop keeps a short switch on the live connection", async () => {
  const { time, win, reconnects, harness } = boot();
  win.matchMedia = () => ({ matches: true });
  win.hide();
  time.advance(5 * 1000);
  win.show();
  await settle();
  assert.equal(reconnects.length, 0, "desktop mode must not inherit the mobile resume policy");
  harness.disposeAll();
});

test("a back-forward-cache restore rebuilds even after a short absence", async () => {
  const { time, win, reconnects, harness } = boot();
  win.hide();
  time.advance(1000);
  pageshow(win, true);
  await settle();
  assert.equal(reconnects.length, 1, "a bfcache restore leaves the old carrier dead");
  harness.disposeAll();
});

test("Page Lifecycle resume rebuilds after a frozen page returns", async () => {
  const { win, reconnects, harness } = boot();
  win.document.dispatchEvent(new Event("resume"));
  await settle();
  assert.equal(reconnects.length, 1, "resume is an explicit return from browser suspension");
  harness.disposeAll();
});

test("an ordinary pageshow keeps a fresh connection", async () => {
  const { win, reconnects, harness } = boot();
  pageshow(win, false);
  await settle();
  assert.equal(reconnects.length, 0, "the pageshow of a normal load must not rebuild");
  harness.disposeAll();
});

test("one return announced twice rebuilds only once", async () => {
  const { time, win, reconnects, harness } = boot();
  win.hide();
  time.advance(10 * 60 * 1000);
  win.show();
  pageshow(win, true);
  await settle();
  assert.equal(reconnects.length, 1, "a single return must not fire two reconnects back to back");
  harness.disposeAll();
});

test("BUG-RESUME-2: an expired gateway session reloads to the login page", async () => {
  const { time, win, reconnects, harness } = boot();
  win.fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ ok: false }) });
  win.hide();
  time.advance(10 * 60 * 1000);
  win.show();
  await settle();
  assert.equal(reconnects.length, 1, "the connection is rebuilt first, the session probe decides the rest");
  assert.equal(win.requests.length, 1);
  assert.equal(win.requests[0][0], "/_dsh/auth-webserver/state");
  assert.equal(win.reloads, 1, "an unauthenticated page must reload into the gateway login page");
  harness.disposeAll();
});

test("a live gateway session never reloads the page", async () => {
  const { time, win, harness } = boot();
  win.hide();
  time.advance(10 * 60 * 1000);
  win.show();
  await settle();
  assert.equal(win.requests.length, 1, "the resume still checks the session once");
  assert.equal(win.reloads, 0);
  harness.disposeAll();
});

test("a failed session probe keeps the page in place", async () => {
  const { time, win, harness } = boot();
  win.fetchImpl = async () => {
    throw new Error("network is still down");
  };
  win.hide();
  time.advance(10 * 60 * 1000);
  win.show();
  await settle();
  assert.equal(win.reloads, 0, "an unreachable gateway must not discard the page");
  harness.disposeAll();
});

test("disposing the plugin detaches the resume listeners", async () => {
  const { time, win, reconnects, harness } = boot();
  harness.disposeAll();
  win.hide();
  time.advance(10 * 60 * 1000);
  win.show();
  win.document.dispatchEvent(new Event("resume"));
  await settle();
  assert.equal(reconnects.length, 0);
});
