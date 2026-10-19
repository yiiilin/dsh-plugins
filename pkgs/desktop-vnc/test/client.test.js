/**
 * Client-half tests for the desktop-vnc page.
 *
 * Two layers:
 *  - source-level checks (dictionaries, contract identities, no stray copy),
 *  - execution of the real bundle in a `node:vm` context with a fake `window`
 *    and cordis context, exactly the way `scripts/build-client.mjs` loads it,
 *    so `apply()` and the tab registration are exercised as the browser runs
 *    them rather than as a copy.
 *
 * The automatic-connection policy (contract v2 §8.1) is a pure function so its
 * bound is assertable here without a renderer; `client-lifecycle.test.js`
 * drives the same policy through the real component.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const CLIENT_PATH = fileURLToPath(new URL("../client.js", import.meta.url));
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, "utf8");
const NOVNC_RFB = fileURLToPath(new URL("../novnc/core/rfb.js", import.meta.url));

/** Contract §7 keys; both dictionaries must carry all of them. */
const CONTRACT_KEYS = [
  "title",
  "guide.description",
  "action.connect",
  "action.reconnect",
  "action.disconnect",
  "action.fullscreen",
  "action.exitFullscreen",
  "action.scale",
  "action.readOnly",
  "action.clipboard",
  "status.idle",
  "status.loading",
  "status.connecting",
  "status.autoConnecting",
  "status.connected",
  "status.disconnected",
  "status.error",
  "password.prompt",
  "password.placeholder",
  "password.submit",
  "password.cancel",
  "error.hint",
  "error.asset",
  "error.state",
];

const REACT_STUB = new Proxy({}, {
  get: (_target, name) => (name === "Fragment" ? "fragment" : () => null),
});

/**
 * Execute the shipped bundle and return its factory exports.
 * @param sandboxExtras - extra globals beyond the minimal build-time `window`.
 * @returns the object the factory returned.
 */
function loadFactory(sandboxExtras = {}) {
  let entry = null;
  const window = sandboxExtras.window ?? {};
  window.__ModuleLoader__ = { load(spec) { entry = spec } };
  // `URL` and `document` are browser globals the bundle resolves its routes
  // against; the sandbox has to provide them the way a real page does.
  const sandbox = {
    URL,
    document: {
    baseURI: "http://127.0.0.1:3080/main/",
    head: { append() {} },
    createElement: () => ({ id: "", dataset: {}, textContent: "", remove() {} }),
    addEventListener() {},
    removeEventListener() {},
    fullscreenElement: null,
  },
    ...sandboxExtras,
    window,
  };
  sandbox.window = window;
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SOURCE, sandbox, { filename: CLIENT_PATH, timeout: 2000 });
  assert.notEqual(entry, null, "the bundle must register with window.__ModuleLoader__");
  assert.equal(typeof entry.factory, "function", "the registration must carry a factory");
  return entry.factory((name) => {
    if (name === "react") return REACT_STUB;
    throw new Error(`unexpected client require: ${name}`);
  });
}

/** Extract one `const NAME = { ... }` dictionary's key set from the source. */
function dictionaryKeys(name, endMarker) {
  const start = CLIENT_SOURCE.indexOf(`const ${name} = {`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = CLIENT_SOURCE.indexOf(endMarker, start);
  assert.notEqual(end, -1, `${name} must have a boundary`);
  const block = CLIENT_SOURCE.slice(start, end);
  return new Set([...block.matchAll(/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w.$]*))\s*:/gmu)]
    .map((match) => match[1] ?? match[2] ?? match[3]));
}

function exportsOf() {
  return loadFactory();
}

// ===== locale =====

test("keeps the zh/en dictionary key sets identical and complete", () => {
  const zh = dictionaryKeys("ZH_DICT", "const EN_DICT");
  const en = dictionaryKeys("EN_DICT", "const VNC_STATES");
  assert.deepEqual([...zh].sort(), [...en].sort());
  for (const key of CONTRACT_KEYS) {
    assert.ok(zh.has(key), `zh dictionary is missing ${key}`);
    assert.ok(en.has(key), `en dictionary is missing ${key}`);
  }
});

test("keeps user-visible Chinese copy inside the zh dictionary only", () => {
  const start = CLIENT_SOURCE.indexOf("const ZH_DICT = {");
  const end = CLIENT_SOURCE.indexOf("const EN_DICT = {");
  const outside = CLIENT_SOURCE.slice(0, start) + CLIENT_SOURCE.slice(end);
  const offenders = [...outside.matchAll(/.{0,40}[\u4e00-\u9fff]+.{0,40}/gu)].map((match) => match[0].trim());
  assert.deepEqual(offenders, [], "hardcoded Chinese copy found outside ZH_DICT");
});

test("registers the frozen locale namespace", () => {
  const { __test } = exportsOf();
  assert.equal(__test.LOCALE_NS, "desktop-vnc");
});

// ===== contract identities =====

test("declares the frozen contract identities", () => {
  const { inject, name, __test } = exportsOf();
  assert.equal(name, "desktop-vnc-client");
  assert.deepEqual([...inject].sort(), ["connection", "locale", "sidebarRightTabs", "slots"]);
  assert.equal(__test.VNC_TAB_ID, "@yiln-dsh/dsh-desktop-vnc");
  assert.equal(__test.VNC_TAB_KIND, "desktop-vnc");
    // These are readers, not constants: each resolves against `document.baseURI` at
    // call time so the environment prefix the GUI is served under survives.
    assert.equal(typeof __test.ASSET_BASE, "function");
    assert.equal(typeof __test.RFB_MODULE_PATH, "function");
    assert.equal(typeof __test.WS_PATH, "function");
    assert.equal(typeof __test.STATE_PATH, "function");
    assert.match(__test.ASSET_BASE(), /\/_dsh\/desktop-vnc\/asset$/u);
    assert.match(__test.WS_PATH(), /\/_dsh\/desktop-vnc\/ws$/u);
    assert.match(__test.STATE_PATH(), /\/_dsh\/desktop-vnc\/state$/u);
});

test("loads noVNC core through the host route, never the app bundle", () => {
  const { __test } = exportsOf();
    assert.match(__test.rfbModuleUrl(), /\/_dsh\/desktop-vnc\/asset\/core\/rfb\.js$/u);
  assert.doesNotMatch(CLIENT_SOURCE, /\/_dsh\/desktop-vnc\/asset\/app\//u);
  // The asset route only exists if the served tree the URL points at exists.
  assert.doesNotThrow(() => readFileSync(NOVNC_RFB, "utf8"));
});

test("builds the WebSocket URL from the page scheme", () => {
  const { __test } = exportsOf();
    // The prefix must survive: building from a bare path dropped it and connected to a
    // route that answers with the login page.
    assert.equal(__test.wsUrlFor("http://127.0.0.1:3080/main/_dsh/desktop-vnc/ws"),
      "ws://127.0.0.1:3080/main/_dsh/desktop-vnc/ws");
    assert.equal(__test.wsUrlFor("https://dsh.yiln.de/env-6-13/_dsh/desktop-vnc/ws"),
      "wss://dsh.yiln.de/env-6-13/_dsh/desktop-vnc/ws");
});

// ===== state machine =====

test("starts idle and keeps a status line for every state", () => {
  const { __test } = exportsOf();
  assert.equal(__test.VNC_INITIAL_STATE, "idle");
  assert.deepEqual([...__test.VNC_STATES].sort(),
    ["connected", "connecting", "disconnected", "error", "idle", "loading"]);
  // Every state the page can show has to have a status line.
  for (const state of __test.VNC_STATES) {
    assert.ok(__test.ZH_DICT[__test.statusKeyFor(state)], `missing zh status for ${state}`);
    assert.ok(__test.EN_DICT[__test.statusKeyFor(state)], `missing en status for ${state}`);
  }
});

// ===== automatic connection (contract v2 §8) =====

test("labels an automatic attempt differently from a manual one", () => {
  const { __test } = exportsOf();
  // Only the in-flight states can be automatic; the label must not linger once
  // the connection settles, or a manual retry would read as automatic.
  assert.equal(__test.connectionStatusKeyFor("loading", true), "status.autoConnecting");
  assert.equal(__test.connectionStatusKeyFor("connecting", true), "status.autoConnecting");
  assert.equal(__test.connectionStatusKeyFor("loading", false), "status.loading");
  assert.equal(__test.connectionStatusKeyFor("connecting", false), "status.connecting");
  assert.equal(__test.connectionStatusKeyFor("connected", true), "status.connected");
  assert.equal(__test.connectionStatusKeyFor("error", true), "status.error");
  assert.equal(__test.connectionStatusKeyFor("idle", true), "status.idle");
});

test("auto-connects a revealed idle page exactly once per reveal", () => {
  const { __test } = exportsOf();
  assert.equal(__test.AUTO_RETRY_LIMIT, 1);
  // First attempt of a fresh reveal: always allowed while startable.
  assert.equal(__test.shouldAutoConnect({ visible: true, state: "idle", revealFresh: true, attempts: 0 }), true);
  assert.equal(__test.shouldAutoConnect({ visible: true, state: "error", revealFresh: true, attempts: 0 }), true);
  assert.equal(__test.shouldAutoConnect({ visible: true, state: "disconnected", revealFresh: true, attempts: 0 }), true);
  // A hidden page never connects, whatever else is true.
  assert.equal(__test.shouldAutoConnect({ visible: false, state: "idle", revealFresh: true, attempts: 0 }), false);
  // States that are already in flight or live must not be restarted.
  for (const state of ["loading", "connecting", "connected"]) {
    assert.equal(__test.shouldAutoConnect({ visible: true, state, revealFresh: true, attempts: 0 }), false,
      `${state} must not auto-connect`);
  }
});

test("bounds automatic retries after a failure and then waits for the user", () => {
  const { __test } = exportsOf();
  const limit = __test.AUTO_RETRY_LIMIT;
  // The retry follows a failure, not a settled disconnect.
  assert.equal(__test.shouldAutoConnect({ visible: true, state: "error", revealFresh: false, attempts: 1 }), true);
  assert.equal(__test.shouldAutoConnect({ visible: true, state: "error", revealFresh: false, attempts: 2 }), false);
  // Only one automatic retry beyond the first attempt, and the limit is the
  // boundary that stops the loop.
  assert.equal(limit, 1);
  assert.equal(__test.shouldAutoConnect({ visible: true, state: "error", revealFresh: false, attempts: limit + 1 }), false);
  // A settled session is never re-opened on its own.
  assert.equal(__test.shouldAutoConnect({ visible: true, state: "disconnected", revealFresh: false, attempts: 0 }), false);
  assert.equal(__test.shouldAutoConnect({ visible: true, state: "idle", revealFresh: false, attempts: 0 }), false);
  // A manual attempt exhausts the budget, so a following failure stays put.
  assert.equal(__test.shouldAutoConnect({ visible: true, state: "error", revealFresh: false, attempts: limit + 1 }), false);
  // Unknown states and missing input are inert rather than throwing.
  assert.equal(__test.shouldAutoConnect({ visible: true, state: "nonsense", revealFresh: true, attempts: 0 }), false);
  assert.equal(__test.shouldAutoConnect(undefined), false);
  assert.equal(__test.shouldAutoConnect({ state: "idle", revealFresh: true, attempts: 0 }), false);
});

test("drives the happy path through the documented transitions", () => {
  const { __test } = exportsOf();
  let state = __test.VNC_INITIAL_STATE;
  assert.equal(state, "idle");
  state = __test.reduceVncState(state, "connect");
  assert.equal(state, "loading");
  state = __test.reduceVncState(state, "ready");
  assert.equal(state, "connecting");
  state = __test.reduceVncState(state, "connected");
  assert.equal(state, "connected");
  state = __test.reduceVncState(state, "closed");
  assert.equal(state, "disconnected");
  // A session that ended can be started again.
  assert.equal(__test.reduceVncState(state, "connect"), "loading");
});

test("routes failures to error and recovers only through connect", () => {
  const { __test } = exportsOf();
  assert.equal(__test.reduceVncState("loading", "failed"), "error");
  assert.equal(__test.reduceVncState("connecting", "failed"), "error");
  assert.equal(__test.reduceVncState("connected", "failed"), "error");
  assert.equal(__test.reduceVncState("error", "connect"), "loading");
  assert.equal(__test.reduceVncState("error", "connected"), "error");
  // A late socket callback cannot resurrect a finished page.
  assert.equal(__test.reduceVncState("disconnected", "connected"), "disconnected");
  assert.equal(__test.reduceVncState("idle", "closed"), "idle");
});

test("treats a replaced host generation as a lost connection", () => {
  const { __test } = exportsOf();
  assert.equal(__test.reduceVncState("connected", "lost"), "disconnected");
  assert.equal(__test.reduceVncState("connecting", "lost"), "error");
  assert.equal(__test.reduceVncState("loading", "lost"), "error");
  assert.equal(__test.reduceVncState("idle", "lost"), "idle");
});

test("leaves unknown states and events inert", () => {
  const { __test } = exportsOf();
  assert.equal(__test.reduceVncState("nonsense", "connect"), "nonsense");
  assert.equal(__test.reduceVncState("idle", "nonsense"), "idle");
  assert.equal(__test.reduceVncState(undefined, "connect"), undefined);
  assert.equal(__test.isVncState("connected"), true);
  assert.equal(__test.isVncState("connected "), false);
});

test("classifies a close by who caused it and whether it ever connected", () => {
  const { __test } = exportsOf();
  assert.equal(__test.classifyDisconnect({ intentional: true, superseded: false, connectedOnce: true }), "ignore");
  assert.equal(__test.classifyDisconnect({ intentional: false, superseded: true, connectedOnce: true }), "ignore");
  assert.equal(__test.classifyDisconnect({ intentional: false, superseded: false, connectedOnce: true }), "disconnected");
  assert.equal(__test.classifyDisconnect({ intentional: false, superseded: false, connectedOnce: false }), "error");
  assert.equal(__test.classifyDisconnect(undefined), "error");
});

// ===== registration =====

test("contributes the guide entry with the frozen order and identity", () => {
  const { __test } = exportsOf();
  const definition = __test.createTabDefinition((key) => key);
  assert.equal(definition.id, "@yiln-dsh/dsh-desktop-vnc");
  assert.equal(definition.kind, "desktop-vnc");
  assert.equal(definition.priority, "extension");
  assert.equal(definition.title(), "title");
  assert.equal(definition.guide.length, 1);
  const [entry] = definition.guide;
  assert.equal(entry.id, "desktop-vnc");
  assert.equal(entry.order, 24);
  assert.equal(entry.title(), "title");
  assert.equal(entry.description(), "guide.description");
  assert.equal(typeof entry.icon, "function");
});

test("registers the tab kind and the pane body under the same key", () => {
  const loaded = loadFactory();
  const registered = [];
  const injected = [];
  const effects = [];
  const locales = [];
  const services = {
    locale: { register: (ns, dicts) => { locales.push([ns, dicts]); return () => {} }, bind: () => (key) => key },
    sidebarRightTabs: { register: (definition) => { registered.push(definition); return () => {} } },
    slots: {
      inject: (name, callback) => { injected.push(name); callback(); return () => {} },
      register: (descriptor, component) => { registered.push({ descriptor, component }); return () => {} },
    },
    connection: {},
  };
  const ctx = {
    get: (name) => services[name],
    effect: (callback, label) => { effects.push(label); const dispose = callback(); return typeof dispose === "function" ? dispose : () => {}; },
  };
  loaded.apply(ctx);

  assert.equal(locales.length, 1);
  assert.equal(locales[0][0], "desktop-vnc");
  assert.deepEqual(Object.keys(locales[0][1]).sort(), ["en", "zh"]);

  const type = registered.find((row) => row.id !== undefined && row.descriptor === undefined);
  assert.equal(type.id, "@yiln-dsh/dsh-desktop-vnc");
  assert.equal(type.kind, "desktop-vnc");

  assert.deepEqual(injected, ["sidebar.right.pane.tab"]);
  const body = registered.find((row) => row.descriptor !== undefined);
  assert.equal(body.descriptor.name, "sidebar.right.pane.tab");
  assert.equal(body.descriptor.key, "@yiln-dsh/dsh-desktop-vnc");
  assert.equal(body.descriptor.locale, "desktop-vnc");
  assert.equal(typeof body.component, "function");
  assert.ok(effects.some((label) => /locale/u.test(label ?? "")));
  assert.ok(effects.some((label) => /stylesheet/u.test(label ?? "")));
});

test("apply is a no-op when the product has no right sidebar", () => {
  const loaded = loadFactory();
  const calls = [];
  const ctx = {
    get: () => undefined,
    effect: (callback, label) => { calls.push(label); const dispose = callback(); return typeof dispose === "function" ? dispose : () => {}; },
  };
  assert.equal(loaded.apply(ctx), undefined);
  assert.deepEqual(calls, [], "nothing may be registered without the sidebar seats");
});

test("apply tolerates a missing locale or connection service", () => {
  const loaded = loadFactory();
  for (const missing of ["locale", "connection"]) {
    const registered = [];
    const services = {
      locale: { register: () => () => {}, bind: () => (key) => key },
      sidebarRightTabs: { register: (definition) => { registered.push(definition); return () => {} } },
      slots: {
        inject: (_name, callback) => { callback(); return () => {} },
        register: () => () => {},
      },
      connection: {},
    };
    delete services[missing];
    const ctx = {
      get: (name) => services[name],
      effect: (callback) => { const dispose = callback(); return typeof dispose === "function" ? dispose : () => {}; },
    };
    assert.doesNotThrow(() => loaded.apply(ctx), `apply must tolerate a missing ${missing}`);
    assert.equal(registered.length, 1, `the tab kind must still register without ${missing}`);
    assert.equal(typeof registered[0].title(), "string");
  }
});

test("apply registers nothing when the pane seat itself is missing", () => {
  // The body seat is what makes the kind renderable; contributing a type whose
  // body can never mount would leave a tab that opens to nothing.
  const loaded = loadFactory();
  for (const missing of ["slots", "sidebarRightTabs"]) {
    const calls = [];
    const services = {
      locale: { register: () => () => {}, bind: () => (key) => key },
      sidebarRightTabs: { register: () => () => {} },
      slots: { inject: (_name, callback) => { callback(); return () => {} }, register: () => () => {} },
      connection: {},
    };
    delete services[missing];
    const ctx = {
      get: (name) => services[name],
      effect: (callback, label) => { calls.push(label); const dispose = callback(); return typeof dispose === "function" ? dispose : () => {}; },
    };
    assert.doesNotThrow(() => loaded.apply(ctx), `apply must tolerate a missing ${missing}`);
    assert.deepEqual(calls, [], `nothing may be registered without ${missing}`);
  }
});

test("falls back to a local (unbound) translator without the locale service", () => {
  const loaded = loadFactory();
  const ctx = {
    get: (name) => (name === "sidebarRightTabs"
      ? { register: () => () => {} }
      : name === "slots" ? { inject: (_n, callback) => { callback(); return () => {} }, register: () => () => {} } : undefined),
    effect: (callback) => { const dispose = callback(); return typeof dispose === "function" ? dispose : () => {}; },
  };
  assert.doesNotThrow(() => loaded.apply(ctx));
  const { __test } = loaded;
  assert.equal(__test.applyParams("a {n} b", { n: 3 }), "a 3 b");
  assert.equal(__test.applyParams("a {n} b"), "a {n} b");
});

test("exposes a page component factory that needs no DOM at import time", () => {
  const { __test } = exportsOf();
  const t = (key) => key;
  const body = __test.createVncPage(t, {});
  assert.equal(typeof body, "function");
  // The build loads the bundle with only `window` in scope: importing it must
  // not touch `document`, which the assertions above already proved by running
  // the factory inside a sandbox whose only global is `window`.
});
