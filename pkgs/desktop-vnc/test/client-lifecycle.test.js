/**
 * Lifecycle tests for the desktop-vnc page body.
 *
 * The bundle is executed in a `node:vm` sandbox exactly like the build does,
 * but with a hook-capable React stub so the *real* `VncPage` renders: mount,
 * automatic connection, button handlers, RFB events, and unmount are all driven
 * through the actual component, and a fake `RFB` records what the page asked of
 * it.
 *
 * This is where contract v2 §8 is proven rather than asserted in prose:
 * revealing the tab starts the connection by itself, the automatic retry is
 * bounded to exactly one extra attempt, and every exit path disconnects the
 * viewer so the socket (and x11vnc behind it) is never leaked.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const CLIENT_PATH = fileURLToPath(new URL("../client.js", import.meta.url));
const CLIENT_SOURCE = readFileSync(CLIENT_PATH, "utf8");
// Resolved against `document.baseURI`, so the environment prefix the GUI is served under
// is part of every route the page uses.
const BASE = "http://127.0.0.1:3080/main/";
const EXPECTED_RFB_PATH = `${BASE}_dsh/desktop-vnc/asset/core/rfb.js`;

// ===== a tiny React-shaped hook runtime =====

/**
 * Build a React stub whose `createElement` returns a walkable tree and whose
 * hooks resolve by call order, so a function component can be rendered and
 * re-rendered outside a browser.
 *
 * Function-component children are rendered too, the way React does: the child
 * keeps its own hooks across renders of the parent, and a changed `key` replaces
 * it — unmounting the old one (running its effect cleanups) before the new one
 * mounts. That is what lets the tests prove the shell's `key={focusedInstanceId}`
 * actually releases the previous viewer instead of only asserting the element's
 * props.
 *
 * @param component - the function component to render.
 * @param initialProps - its props.
 * @param shared - `{ current }`, the React object of the innermost runtime
 *                 currently rendering. The bundle's `require('react')` proxy
 *                 reads through it, so a nested component gets its own hooks.
 * @returns the stub plus `render`, `setProps`, `unmount`, `find`, and `text`.
 */
function createHookRuntime(component, initialProps, shared = { current: null }) {
  const slots = [];
  const Ref = Symbol("ref");
  const St = Symbol("state");
  const Ef = Symbol("effect");
  let cursor = 0;
  let props = initialProps ?? {};
  let rendering = false;
  let again = false;
  let tree = null;
  let unmounted = false;
  /** Mounted function-component children, keyed by position + key. */
  const children = new Map();

  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

  // Declared before the hooks that call it; assigned once the runtime below exists.
  let render = () => {};

  const schedule = () => {
    if (unmounted) return;
    // A state update from an event listener re-renders synchronously; one made
    // during a render is folded into the render loop instead.
    if (rendering) again = true;
    else render();
  };

  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (slots[index] === undefined) slots[index] = { kind: St, value: typeof initial === "function" ? initial() : initial };
      const slot = slots[index];
      return [slot.value, (next) => {
        const value = typeof next === "function" ? next(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        schedule();
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (slots[index] === undefined) slots[index] = { kind: Ref, value: { current: initial } };
      return slots[index].value;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      const previous = slots[index];
      const changed = previous === undefined || !sameDeps(previous.deps, deps);
      if (!changed) return;
      slots[index] = { kind: Ef, deps: Array.isArray(deps) ? [...deps] : null, effect, cleanup: previous?.cleanup, pending: true };
    },
  };

  const runEffects = () => {
    for (const slot of slots) {
      if (slot?.kind !== Ef || slot.pending !== true) continue;
      slot.pending = false;
      if (typeof slot.cleanup === "function") {
        const cleanup = slot.cleanup;
        slot.cleanup = undefined;
        cleanup();
      }
      const cleanup = slot.effect();
      slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    }
  };

  /**
   * Render the function components in the tree just produced.
   *
   * A child's identity is its position plus its `key` prop, which is exactly the
   * part of React's reconciliation the shell's focus switch relies on. Host
   * elements are walked through; their subtrees are searched by `find`/`text`.
   */
  const mountChildren = () => {
    const next = new Map();
    let anonymous = 0;
    const walk = (node, path) => {
      if (node === null || node === undefined || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach((child, index) => walk(child, `${path}[${index}]`));
        return;
      }
      if (typeof node.type === "function") {
        const explicitKey = node.props?.key;
        const key = explicitKey === undefined || explicitKey === null ? `#${anonymous++}` : String(explicitKey);
        const slotKey = `${path}:${key}`;
        const existing = children.get(slotKey);
        if (existing !== undefined && existing.component === node.type) {
          next.set(slotKey, existing);
          existing.runtime.setProps(node.props);
          // The subtree is read through `child`, never captured: a child that
          // re-renders after an async update must be visible to `find`.
          node.child = existing.runtime;
          return;
        }
        const runtime = createHookRuntime(node.type, node.props, shared);
        next.set(slotKey, { component: node.type, runtime });
        node.child = runtime;
        runtime.render();
        return;
      }
      (node.children ?? []).forEach((child, index) => walk(child, `${path}/${index}`));
    };
    walk(tree, "root");
    // A key that disappeared is unmounted, which runs the child's effect cleanups.
    for (const [slotKey, entry] of children) {
      if (!next.has(slotKey)) entry.runtime.unmount();
    }
    children.clear();
    for (const [slotKey, entry] of next) children.set(slotKey, entry);
  };

  const React = {
    Fragment: "fragment",
    createElement: (type, elementProps, ...childNodes) => {
      const node = {
        type,
        props: elementProps ?? {},
        children: childNodes.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
        // A mounted function-component child, if this node is one.
        child: null,
      };
      // React assigns a `ref` prop after the host node is created; the page
      // reads `hostRef.current` synchronously when it connects, so the stub
      // must do the same.
      const ref = node.props.ref;
      if (ref !== null && typeof ref === "object") ref.current = node;
      return node;
    },
    ...hooks,
  };

  render = () => {
    if (rendering) {
      again = true;
      return;
    }
    rendering = true;
    const outer = shared.current;
    do {
      again = false;
      cursor = 0;
      shared.current = React;
      tree = component(props);
      mountChildren();
      runEffects();
    } while (again);
    shared.current = outer;
    rendering = false;
  };

  return {
    React,
    render,
    get tree() { return tree; },
    setProps(next) {
      props = { ...props, ...(next ?? {}) };
      render();
    },
    unmount() {
      unmounted = true;
      for (const entry of children.values()) entry.runtime.unmount();
      children.clear();
      for (const slot of slots) {
        if (slot?.kind === Ef && typeof slot.cleanup === "function") {
          const cleanup = slot.cleanup;
          slot.cleanup = undefined;
          cleanup();
        }
      }
    },
    find(predicate) {
      const stack = [tree];
      while (stack.length > 0) {
        const node = stack.pop();
        if (node === null || node === undefined || typeof node !== "object") continue;
        if (typeof node.type === "function" || typeof node.type === "string") {
          if (predicate(node)) return node;
        }
        if (node.child !== null && node.child !== undefined) stack.push(node.child.tree);
        stack.push(...node.children);
      }
      return null;
    },
    text() {
      const parts = [];
      const stack = [tree];
      while (stack.length > 0) {
        const node = stack.pop();
        if (typeof node === "string") { parts.push(node); continue; }
        if (node === null || node === undefined || typeof node !== "object") continue;
        if (node.child !== null && node.child !== undefined) stack.push(node.child.tree);
        stack.push(...node.children);
      }
      return parts.join(" ");
    },
  };
}

// ===== sandboxed load =====

/**
 * Execute the shipped bundle in a VM and return a live page instance with its
 * first automatic connection already in flight.
 *
 * @param options - `visible` is the pane's initial visibility; `failImports`
 *                  makes the fake noVNC module reject that many times, which is
 *                  how the automatic retry bound is observed; `component`
 *                  replaces the mounted body (the shell tests mount `VncShell`);
 *                  `instances` is the list the sessions route answers with, or a
 *                  function called per request so a test can change it.
 * @returns the page runtime plus the fake RFB class it recorded.
 */
async function mountPage(options = {}) {
  const created = [];

  class FakeRFB {
    constructor(target, url, rfbOptions) {
      this.target = target;
      this.url = url;
      this.options = rfbOptions;
      this.listeners = new Map();
      this.disconnects = 0;
      this.credentials = null;
      this.pasted = null;
      this.scaleViewport = rfbOptions?.scaleViewport;
      this.viewOnly = rfbOptions?.viewOnly;
      created.push(this);
    }
    addEventListener(name, listener) {
      const set = this.listeners.get(name) ?? new Set();
      set.add(listener);
      this.listeners.set(name, set);
    }
    emit(name, detail) {
      for (const listener of [...(this.listeners.get(name) ?? [])]) listener({ detail });
    }
    disconnect() { this.disconnects += 1; }
    sendCredentials(creds) { this.credentials = creds; }
    clipboardPasteFrom(text) { this.pasted = text; }
  }

  const headChildren = [];
  const document = {
    // The bundle resolves its routes against the page base, so the fixture needs one.
    baseURI: "http://127.0.0.1:3080/main/",
    fullscreenElement: null,
    head: { append: (node) => headChildren.push(node) },
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: () => ({ id: "", dataset: {}, textContent: "", remove: () => {} }),
  };
  /** The sessions list the Host would answer with, one entry per instance. */
  let instances = options.instances ?? [];
  const sessionsCalls = [];
  const requests = [];
  const fetchImpl = async (url, init) => {
    sessionsCalls.push(String(url));
    requests.push({ url: String(url), method: init?.method ?? "GET" });
    // `/state` is what the viewer's failure diagnosis reads; the list route is
    // the shell's data source. One fetch stub serves both.
    if (String(url).includes("/sessions")) {
      // An Error stands for an unreachable Host: a failed refresh is a distinct
      // case from an empty table, and the shell must tell them apart.
      if (instances instanceof Error) throw instances;
      const rows = typeof instances === "function" ? instances() : instances;
      return { ok: true, status: 200, json: async () => rows };
    }
    return { ok: true, status: 200, json: async () => ({ vncRunning: false }) };
  };
  const window = {
    location: { protocol: "http:", host: "127.0.0.1:3080" },
    fetch: fetchImpl,
    isSecureContext: true,
  };
  const navigator = { clipboard: { readText: async () => "from-clipboard" } };

  // Platform timers the bundle may schedule — the list's poll — captured so a
  // test fires them on demand instead of waiting for wall-clock time.
  const timers = [];
  const clearedTimers = new Set();
  const setIntervalStub = (callback) => {
    timers.push(callback);
    return timers.length;
  };
  const clearIntervalStub = (id) => { clearedTimers.add(id); };

  let entry = null;
  window.__ModuleLoader__ = { load: (spec) => { entry = spec; } };
  const sandbox = {
    window, document, navigator, console, Promise, Object, Array, Error, JSON, URL, setTimeout, clearTimeout,
    fetch: fetchImpl, setInterval: setIntervalStub, clearInterval: clearIntervalStub,
  };
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SOURCE, sandbox, { filename: CLIENT_PATH, timeout: 2000 });
  assert.notEqual(entry, null, "the bundle must register with window.__ModuleLoader__");

  // The factory captures `require('react')` while evaluating, before the hook
  // runtime exists; the proxy resolves each hook against the live runtime so
  // the real component renders with the stub's hooks. `shared.current` tracks
  // the innermost runtime, so a nested component gets hooks of its own.
  const shared = { current: null };
  const ReactProxy = new Proxy({}, { get: (_target, name) => shared.current[name] });
  const exported = entry.factory((name) => {
    if (name === "react") return ReactProxy;
    throw new Error(`unexpected client require: ${name}`);
  });

  const importedPaths = [];
  let remainingFailures = Number.isFinite(options.failImports) ? options.failImports : 0;
  exported.__test.setRfbModuleImporter(async (path) => {
    importedPaths.push(path);
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      throw new Error("fake noVNC asset fetch failed");
    }
    return { default: FakeRFB };
  });

  /** Fake Host connection whose generation callbacks the test can fire. */
  const generationListeners = new Set();
  const connection = {
    generation: {
      subscribe: (listener) => {
        generationListeners.add(listener);
        return () => generationListeners.delete(listener);
      },
    },
  };

  // The page is always handed its translator by `apply`; use the real zh
  // dictionary so the assertions read what a Chinese user sees.
  const t = (key) => exported.__test.ZH_DICT[key] ?? key;
    let tabVisible = options.visible !== false
    // No `sessionId` prop: the seat does not pass one. The body's identity comes from
    // the tab the hook reports, exactly as it does in the real seat.
    let tabId = options.tabId ?? "tab-1"
    const pageProps = { useTabInfo: () => ({ tab: { id: tabId, visible: tabVisible } }) }
    const body = typeof options.component === "function"
      ? options.component(exported.__test, t, connection)
      : exported.__test.createVncPage(t, connection)
    const runtime = createHookRuntime(body, pageProps, shared)
  shared.current = runtime.React
  runtime.render();

  return {
    runtime,
    created,
    importedPaths,
    sessionsCalls,
    exported,
    ZH: exported.__test.ZH_DICT,
    /** Replace the list the sessions route answers with, then re-read it. */
    setInstances: (next) => { instances = next; },
    /**
     * Click the list's own refresh control, as a user or a poll would, and let
     * the request settle.
     */
    refresh: async () => {
      const button = runtime.find((node) => node.props["aria-label"] === t("list.refresh") && node.type === "button")
      assert.notEqual(button, null, "the list must offer a refresh control")
      button.props.onClick()
      for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve))
    },
    /** Run every interval the bundle scheduled (the list's poll), then settle. */
    tick: async () => {
      for (const callback of [...timers]) callback()
      for (let index = 0; index < 10; index += 1) await new Promise((resolve) => setImmediate(resolve))
    },
    /** Whether the bundle still holds a live poll. */
    intervals: () => timers.filter((_callback, index) => !clearedTimers.has(index + 1)).length,
    setTabVisible: (value) => { tabVisible = value; runtime.setProps({}); },
    /** Rebind the pane to another tab, as a session switch does. */
    setTabId: (value) => { tabId = value; runtime.setProps({}); },
    generation: () => { for (const listener of [...generationListeners]) listener(); },
    /** Let the component's async connect path settle. */
    settle: async (rounds = 8) => {
      for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
    },
    findByClass: (className) => runtime.find((node) => node.props.className === className),
    findByLabel: (label) => runtime.find((node) => node.props["aria-label"] === label),
    /** The viewer created by the most recent attempt. */
    viewer: () => created.at(-1),
    /** Click the overlay's「连接桌面」/「重新连接」button (idle/disconnected/error). */
    clickPrimary: () => {
      const button = runtime.find((node) => node.props.className === "dsh-vnc-primary" && node.type === "button");
      assert.notEqual(button, null, "the primary action button must exist in this state");
      button.props.onClick();
    },
    /** Click the toolbar's reconnect control. */
    clickReconnect: () => {
      const button = runtime.find((node) => node.props["aria-label"] === t("action.reconnect") && node.type === "button");
      assert.notEqual(button, null, "the reconnect control must exist");
      button.props.onClick();
    },
  };
}

// ===== automatic connection (contract v2 §8) =====

test("connects automatically as soon as the revealed tab mounts", async () => {
  const page = await mountPage();
  // The attempt starts during mount, so even before the import settles the page
  // already reports the automatic status rather than the "not connected" idle.
  assert.deepEqual(page.importedPaths, [EXPECTED_RFB_PATH], "mounting a visible tab loads noVNC on its own");
  assert.match(page.runtime.text(), /自动连接中/u);
  assert.doesNotMatch(page.runtime.text(), /未连接/u);

  await page.settle();
  assert.equal(page.created.length, 1);
  assert.match(page.runtime.text(), /正在连接桌面|自动连接中/u);
});

test("opens no connection while the pane keeps the tab hidden", async () => {
  const page = await mountPage({ visible: false });
  await page.settle();
  assert.deepEqual(page.importedPaths, [], "a hidden tab must not load or start VNC");
  assert.equal(page.created.length, 0);
  assert.match(page.runtime.text(), /未连接/u);
  assert.match(page.runtime.text(), /连接桌面/u);
});

test("connects on the reveal that follows a hide", async () => {
  const page = await mountPage({ visible: false });
  await page.settle();
  assert.equal(page.created.length, 0);
  page.setTabVisible(true);
  await page.settle();
  assert.deepEqual(page.importedPaths, [EXPECTED_RFB_PATH]);
  assert.equal(page.created.length, 1, "showing the tab is the request to connect");
});

test("retries one automatic attempt after an asset failure, then waits for the user", async () => {
  // Always-failing importer: the page must give up after one retry rather than
  // loop. (`Number.isFinite` gates the option, so pass a large finite count.)
  const page = await mountPage({ failImports: 99 });
  await page.settle(12);
  // One initial automatic attempt plus exactly one automatic retry. The bound
  // is what keeps a missing asset from becoming a request loop.
  assert.equal(page.importedPaths.length, 2, "the automatic retry must be bounded to one");
  assert.equal(page.created.length, 0);
  assert.match(page.runtime.text(), /连接失败/u);
  // Nothing re-fires while the page sits in the error state.
  await page.settle(12);
  assert.equal(page.importedPaths.length, 2, "the exhausted page must stay put");
  // The user's own retry is still available and is not labelled automatic.
  page.clickReconnect();
  assert.match(page.runtime.text(), /正在加载 VNC 客户端/u);
  await page.settle(12);
  assert.equal(page.importedPaths.length, 3);
});

test("retries once after a viewer that never connected, then stops", async () => {
  const page = await mountPage();
  await page.settle();
  const first = page.viewer();
  first.emit("disconnect", { clean: false });
  // The first failure earns one automatic retry, already in flight by now.
  await page.settle();
  assert.equal(page.created.length, 2, "a first failure earns exactly one automatic retry");
  assert.match(page.runtime.text(), /自动连接中|正在连接桌面/u);
  page.viewer().emit("disconnect", { clean: false });
  await page.settle();
  assert.equal(page.created.length, 2, "the retry budget is spent, so no third viewer");
  assert.match(page.runtime.text(), /连接失败/u);
});

test("registers the connection-generation listener and disconnects on a new host", async () => {
  const page = await mountPage();
  await page.settle();
  const rfb = page.viewer();
  rfb.emit("connect", {});
  assert.match(page.runtime.text(), /已连接/u);
  page.generation();
  assert.equal(rfb.disconnects, 1, "a replaced host generation must release the viewer");
  assert.match(page.runtime.text(), /连接已断开/u);
});

test("connects with the contract URL, options, and subprotocols", async () => {
  const page = await mountPage();
  await page.settle();
  assert.deepEqual(page.importedPaths, [EXPECTED_RFB_PATH]);
  assert.equal(page.created.length, 1);
  const rfb = page.viewer();
  assert.equal(rfb.url, "ws://127.0.0.1:3080/main/_dsh/desktop-vnc/ws");
  assert.equal(rfb.options.resizeSession, false, "the desktop resolution must not be changed");
  assert.equal(rfb.options.scaleViewport, true);
  assert.equal(rfb.options.viewOnly, false);
  // Values cross the VM realm boundary, so compare copies in this realm.
  assert.deepEqual([...rfb.options.wsProtocols], ["binary", "base64"]);
  assert.deepEqual(Object.keys(rfb.options.credentials), []);
  assert.equal(rfb.target, page.findByClass("dsh-vnc-canvas"), "the viewer must mount into the canvas host");
});

test("reports connected, then disconnects on unmount", async () => {
  const page = await mountPage();
  await page.settle();
  const rfb = page.viewer();
  rfb.emit("connect", {});
  assert.match(page.runtime.text(), /已连接/u);
  page.runtime.unmount();
  assert.equal(rfb.disconnects, 1, "unmount must disconnect the viewer exactly once");
});

test("disconnects when the pane hides the tab", async () => {
  const page = await mountPage();
  await page.settle();
  const rfb = page.viewer();
  rfb.emit("connect", {});
  page.setTabVisible(false);
  assert.equal(rfb.disconnects, 1);
  assert.match(page.runtime.text(), /连接已断开/u);
});

test("disconnects when the host connection generation is replaced", async () => {
  const page = await mountPage();
  await page.settle();
  const rfb = page.viewer();
  rfb.emit("connect", {});
  page.generation();
  assert.equal(rfb.disconnects, 1);
});

test("asks for a password inline and sends it without echoing", async () => {
  const page = await mountPage();
  await page.settle();
  const rfb = page.viewer();
  rfb.emit("credentialsrequired", { types: ["password"] });
  const input = page.findByClass("dsh-vnc-input");
  assert.equal(input.props.type, "password");
  assert.equal(input.props.value, "");
  assert.match(page.runtime.text(), /该桌面需要密码/u);

  input.props.onChange({ target: { value: "s3cret" } });
  page.findByClass("dsh-vnc-password").props.onSubmit({ preventDefault() {} });
  // The credentials object crosses the VM realm, so compare its fields.
  assert.equal(rfb.credentials.password, "s3cret");
  assert.deepEqual(Object.keys(rfb.credentials), ["password"]);
  assert.equal(page.findByClass("dsh-vnc-input"), null, "the prompt must close once credentials are sent");
});

test("cancelling the password prompt releases the viewer and returns to idle", async () => {
  const page = await mountPage();
  await page.settle();
  const rfb = page.viewer();
  rfb.emit("credentialsrequired", { types: ["password"] });
  const cancel = page.runtime.find((node) => node.props.className === "dsh-vnc-secondary");
  cancel.props.onClick();
  assert.equal(rfb.disconnects, 1);
  assert.match(page.runtime.text(), /未连接/u);
  // Declining the prompt must not be answered by an automatic reconnect.
  await page.settle();
  assert.equal(page.created.length, 1, "cancelling ends the automatic assistance");
});

test("surfaces a failure that never connected as an actionable error", async () => {
  const page = await mountPage();
  await page.settle();
  // The first failure is answered by the one automatic retry; that retry has to
  // fail too before the page settles into the actionable error state.
  page.viewer().emit("disconnect", { clean: false });
  await page.settle();
  assert.equal(page.created.length, 2, "the first failure is retried once");
  page.viewer().emit("disconnect", { clean: false });
  await page.settle();
  assert.match(page.runtime.text(), /连接失败/u);
  assert.match(page.runtime.text(), /请确认 x11vnc 已安装且端口未被占用/u);
});

test("reports a deliberate disconnect as a drop, not a failure", async () => {
  const page = await mountPage();
  await page.settle();
  const rfb = page.viewer();
  rfb.emit("connect", {});
  rfb.emit("disconnect", { clean: true });
  assert.match(page.runtime.text(), /连接已断开/u);
  assert.doesNotMatch(page.runtime.text(), /连接失败/u);
  // A settled drop is not resource jitter: the page must not silently re-open
  // the socket the server just closed.
  await page.settle();
  assert.equal(page.created.length, 1);
});

test("fetches the RFB module once and reuses it across reconnects", async () => {
  const page = await mountPage();
  await page.settle();
  const first = page.viewer();
  first.emit("connect", {});
  const disconnectButton = page.findByLabel("断开");
  assert.equal(disconnectButton.props.className, "dsh-vnc-tool");
  disconnectButton.props.onClick();
  assert.equal(first.disconnects, 1);
  page.clickPrimary();
  await page.settle();
  assert.deepEqual(page.importedPaths, [EXPECTED_RFB_PATH], "the viewer module is cached, not refetched");
  assert.equal(page.created.length, 2, "each attempt still gets a fresh viewer");
});

test("ignores a late socket callback from a superseded viewer", async () => {
  const page = await mountPage();
  await page.settle();
  const first = page.viewer();
  first.emit("connect", {});
  // Reconnecting is only offered once a session exists, so settle one first.
  page.findByLabel("重新连接").props.onClick();
  assert.equal(first.disconnects, 1, "reconnect replaces the live viewer");
  await page.settle();
  const second = page.viewer();
  assert.notEqual(first, second);
  // The replaced viewer's own close event must not overwrite the new state.
  first.emit("connect", {});
  assert.doesNotMatch(page.runtime.text(), /已连接/u);
  second.emit("connect", {});
  assert.match(page.runtime.text(), /已连接/u);
});

test("keeps a manual retry from triggering an automatic follow-up", async () => {
  const page = await mountPage();
  await page.settle();
  page.viewer().emit("disconnect", { clean: false });
  await page.settle();
  assert.equal(page.created.length, 2, "the automatic retry happened");
  // That retry fails too, which spends the budget: the page now waits in the
  // error state with its manual button offered.
  page.viewer().emit("disconnect", { clean: false });
  await page.settle();
  assert.equal(page.created.length, 2, "the budget is spent, so no third automatic viewer");
  assert.match(page.runtime.text(), /连接失败/u);
  // The user now takes over; their attempt exhausts the automatic budget, so a
  // failure right after it stays in the error state.
  page.clickPrimary();
  await page.settle();
  assert.equal(page.created.length, 3);
  page.viewer().emit("disconnect", { clean: false });
  await page.settle();
  assert.equal(page.created.length, 3, "a manual attempt must not be followed by an automatic retry");
});

test("leaves a hidden page's viewer torn down and its automation disarmed", async () => {
  const page = await mountPage();
  await page.settle();
  const rfb = page.viewer();
  rfb.emit("connect", {});
  page.setTabVisible(false);
  assert.equal(rfb.disconnects, 1);
  // A hidden page never connects, and revealing it again gets a fresh attempt.
  await page.settle();
  assert.equal(page.created.length, 1);
  page.setTabVisible(true);
  await page.settle();
  assert.equal(page.created.length, 2, "re-revealing the tab connects on its own again");
});

test("hiding the tab mid-attempt fences it and leaves a startable state", async () => {
  const page = await mountPage();
  // Hide before the module fetch settles, so the attempt has no viewer yet.
  page.setTabVisible(false);
  await page.settle();
  assert.equal(page.created.length, 0, "a hidden pane must not mount a viewer");
  assert.match(page.runtime.text(), /未连接/u);
  // Revealing again must be able to connect: the fenced attempt left the page in
  // a startable state rather than stuck in `loading`.
  page.setTabVisible(true);
  await page.settle();
  assert.equal(page.created.length, 1, "the re-reveal connects on its own");
});

test("does not open a second automatic viewer when the pane re-renders while visible", async () => {
  const page = await mountPage();
  await page.settle();
  const rfb = page.viewer();
  rfb.emit("connect", {});
  // A re-render of a visible, connected page must not re-arm automation.
  page.runtime.setProps({});
  await page.settle();
  assert.equal(page.created.length, 1, "a re-render is not a reveal");
  assert.match(page.runtime.text(), /已连接/u);
});

test("toggles scale and read-only onto the live viewer", async () => {
  const page = await mountPage();
  await page.settle();
  const rfb = page.viewer();
  rfb.emit("connect", {});
  const scale = page.findByLabel("自适应缩放");
  scale.props.onClick();
  assert.equal(rfb.scaleViewport, false);
  const readOnly = page.findByLabel("只读");
  readOnly.props.onClick();
  assert.equal(rfb.viewOnly, true);
  // Read-only forbids sending input, so clipboard paste is unavailable.
  assert.equal(page.findByLabel("粘贴剪贴板").props.disabled, true);
});

test("pastes the local clipboard through the viewer", async () => {
  const page = await mountPage();
  await page.settle();
  const rfb = page.viewer();
  rfb.emit("connect", {});
  page.findByLabel("粘贴剪贴板").props.onClick();
  await page.settle();
  assert.equal(rfb.pasted, "from-clipboard");
  assert.match(page.runtime.text(), /已粘贴剪贴板内容/u);
});

test("keeps every toolbar control labeled and correctly disabled", async () => {
  const page = await mountPage();
  await page.settle();
  // The automatic attempt is in flight, so the toolbar's connect seat is busy.
  assert.equal(page.findByLabel("连接桌面").props.disabled, true, "no second manual connect mid-flight");
  const rfb = page.viewer();
  rfb.emit("connect", {});
  for (const label of ["断开", "重新连接", "自适应缩放", "只读", "粘贴剪贴板", "全屏"]) {
    const control = page.findByLabel(label);
    assert.notEqual(control, null, `missing control: ${label}`);
    assert.equal(typeof control.props.onClick, "function", `${label} must be operable`);
    assert.equal(typeof control.props.title, "string", `${label} must carry a tooltip`);
  }
  assert.equal(page.findByLabel("粘贴剪贴板").props.disabled, false);
});

test("keeps the automatic status out of the settled states", async () => {
  const page = await mountPage();
  await page.settle();
  const rfb = page.viewer();
  rfb.emit("connect", {});
  // A live session must read as connected, never as "connecting automatically".
  assert.match(page.runtime.text(), /已连接/u);
  assert.doesNotMatch(page.runtime.text(), /自动连接中/u);
});

test("a new tab identity starts a fresh viewer lifetime", async () => {
  // The seat passes no `sessionId` prop, so the body's identity has to come from the tab
  // the hook reports. Without it the lifetime effect never restarted, and a viewer kept
  // its socket and its x11vnc client alive after the pane moved to another session —
  // which is the leak this pins shut.
  const page = await mountPage()
  await page.settle()
  assert.notEqual(page.viewer(), undefined, "the first tab connects")

  const before = page.viewer()
  assert.equal(before.disconnects, 0, "the first viewer is connected")

  page.setTabId("tab-2")
  await page.settle()

  // The old viewer must be released: a stale RFB keeps its socket, and through it
  // x11vnc's client slot, alive with nothing drawing it.
  assert.equal(before.disconnects, 1, "the previous viewer is disconnected")
})

// ===== instance list and switching =====

/** Two rows as `GET /sessions` reports them, in table order. */
const INSTANCES = [
  { id: "aaaa1111", state: "ready", width: 1280, height: 800, createdAt: 1792637133, ownerSessionId: "sess-one", lastActiveAt: 1792637200, viewers: 1 },
  { id: "bbbb2222", state: "starting", width: 1280, height: 800, createdAt: 1792637300, ownerSessionId: "sess-two", lastActiveAt: 1792637300, viewers: 0 },
];

/** Mount the real shell, which is what the seat registers as the tab body. */
async function mountShell(options = {}) {
  const page = await mountPage({
    ...options,
    component: (test, t, connection) => test.createVncShell(t, connection),
  });
  await page.settle();
  return page;
}

/** Every list row in document order, the way the seat draws them. */
function listRows(page) {
  const rows = [];
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== "object") return;
    if (node.props?.className === "dsh-vnc-instance") rows.push(node);
    if (node.child !== null && node.child !== undefined) walk(node.child.tree);
    for (const child of node.children) walk(child);
  };
  walk(page.runtime.tree);
  return rows;
}

test("renders one list row per browser instance, from the Host list", async () => {
  const page = await mountShell({ instances: INSTANCES });
  assert.deepEqual(page.sessionsCalls, ["http://127.0.0.1:3080/main/_dsh/desktop-vnc/sessions"],
    "the list comes from the Host's instance table, under the environment prefix");

  const rows = listRows(page);
  assert.equal(rows.length, 2, "one row per instance");
  assert.deepEqual(rows.map((row) => row.props["data-instance-id"]), ["aaaa1111", "bbbb2222"]);
  assert.deepEqual(rows.map((row) => row.props["data-state"]), ["ready", "starting"]);
  // The list is what the user reads, so both ids are on screen.
  assert.match(page.runtime.text(), /aaaa1111/u);
  assert.match(page.runtime.text(), /bbbb2222/u);
});

test("shows the empty list state rather than an empty list", async () => {
  const page = await mountShell({ instances: [] });
  assert.equal(listRows(page).length, 0);
  assert.match(page.runtime.text(), /没有浏览器实例/u);
});

test("shows the empty viewer state until an instance is selected", async () => {
  const page = await mountShell({ instances: INSTANCES });
  // The point of the empty state: no canvas is mounted, so no viewer is even
  // requested before the user picks an instance.
  assert.equal(page.findByClass("dsh-vnc-canvas"), null, "no canvas may exist before a selection");
  assert.equal(page.findByClass("dsh-vnc-stage"), null, "no stage may exist before a selection");
  assert.match(page.runtime.text(), /选择一个浏览器实例/u);
  assert.deepEqual(page.importedPaths, [], "nothing is loaded until an instance is focused");
  assert.equal(page.created.length, 0);
});

test("selecting a row connects the viewer to that instance", async () => {
  const page = await mountShell({ instances: INSTANCES });
  listRows(page)[0].props.onClick();
  await page.settle();

  assert.equal(page.findByClass("dsh-vnc-canvas") !== null, true, "the viewer mounts once selected");
  assert.equal(page.created.length, 1);
  assert.equal(page.viewer().url, "ws://127.0.0.1:3080/main/_dsh/desktop-vnc/sessions/aaaa1111/ws",
    "the viewer must dial the selected instance's own socket");
});

test("switching rows releases the previous viewer before opening the next", async () => {
  const page = await mountShell({ instances: INSTANCES });
  listRows(page)[0].props.onClick();
  await page.settle();
  const first = page.viewer();
  first.emit("connect", {});
  assert.equal(first.disconnects, 0, "the first viewer is live");

  listRows(page)[1].props.onClick();
  await page.settle();

  // The abandoned viewer keeps its socket, and through it x11vnc's client slot,
  // alive with nothing drawing it: it has to be gone before the switch counts.
  assert.equal(first.disconnects, 1, "switching must disconnect the previous viewer");
  assert.equal(page.created.length, 2, "the new instance gets a viewer of its own");
  assert.equal(page.viewer().url, "ws://127.0.0.1:3080/main/_dsh/desktop-vnc/sessions/bbbb2222/ws");
  // The new viewer is a fresh lifetime: the old connection's status must not leak
  // into it, and the toolbar must offer the new session's own connect.
  assert.match(page.runtime.text(), /自动连接中|正在连接桌面|正在加载 VNC 客户端/u);
  assert.doesNotMatch(page.runtime.text(), /已连接/u);
});

test("closing the focused instance returns to an unselected page, not to another instance", async () => {
  const page = await mountShell({ instances: INSTANCES });
  listRows(page)[0].props.onClick();
  await page.settle();
  const viewer = page.viewer();
  viewer.emit("connect", {});

  // The instance disappears from the Host's table (closed by the agent, or by its
  // owning session going away).
  page.setInstances(INSTANCES.slice(1));
  await page.refresh();

  assert.equal(viewer.disconnects, 1, "the closed instance's viewer must be released");
  assert.equal(page.findByClass("dsh-vnc-canvas"), null, "no canvas for an instance that no longer exists");
  assert.match(page.runtime.text(), /选择一个浏览器实例/u);
  // The rule from the glossary: focus is not silently moved to a survivor.
  assert.doesNotMatch(page.runtime.text(), /已连接/u);
  await page.settle();
  assert.equal(page.created.length, 1, "no viewer is opened for the surviving instance");
});

test("a refresh that keeps the instance does not disturb its viewer", async () => {
  const page = await mountShell({ instances: INSTANCES });
  listRows(page)[0].props.onClick();
  await page.settle();
  const viewer = page.viewer();
  viewer.emit("connect", {});

  // `lastActiveAt`/`viewers` move every time anything watches; a list refresh must
  // not be read as a new selection and restart the stream.
  page.setInstances([{ ...INSTANCES[0], viewers: 2, lastActiveAt: 1792637999 }, INSTANCES[1]]);
  await page.refresh();

  assert.equal(viewer.disconnects, 0, "a re-listed instance keeps its viewer");
  assert.equal(page.created.length, 1, "the refresh must not open a second viewer");
  assert.match(page.runtime.text(), /已连接/u);
});

test("keeps a registered focus when the list cannot be read", async () => {
  // A failed refresh is not evidence the instance closed: dropping the focus would
  // tear down a working stream because a poll happened to fail.
  const page = await mountShell({ instances: INSTANCES });
  listRows(page)[0].props.onClick();
  await page.settle();
  const viewer = page.viewer();
  viewer.emit("connect", {});

  page.setInstances(new Error("boom"));
  await page.refresh();

  assert.equal(viewer.disconnects, 0, "an unreadable list must not release the viewer");
  assert.equal(page.findByClass("dsh-vnc-canvas") !== null, true);
});

test("re-reads the instance table on its own, and stops when the tab is hidden", async () => {
  const page = await mountShell({ instances: INSTANCES });
  assert.equal(page.sessionsCalls.length, 1, "mounting reads the table once");
  assert.equal(page.intervals(), 1, "a shown tab keeps a poll alive");

  // The poll is what notices an instance an agent created, without a click.
  page.setInstances([...INSTANCES, { id: "cccc3333", state: "starting", viewers: 0 }]);
  await page.tick();
  assert.equal(listRows(page).length, 3, "a created instance shows up on the next poll");

  // A hidden tab holds no poll: nothing on screen could use the answer.
  page.setTabVisible(false);
  assert.equal(page.intervals(), 0, "hiding the tab releases the poll");
  page.setTabVisible(true);
  await page.settle();
  assert.equal(page.intervals(), 1, "revealing the tab re-arms it");
  assert.equal(page.sessionsCalls.length, 3, "the reveal reads immediately instead of waiting a period");
});

test("a failed list read is reported and retryable, not mistaken for an empty table", async () => {
  const page = await mountShell({ instances: [] });
  page.setInstances(new Error("host down"));
  await page.refresh();
  assert.match(page.runtime.text(), /无法读取浏览器实例列表/u);
  // An empty table and an unreachable Host are different problems; this state
  // must not tell the user to create an instance.
  assert.doesNotMatch(page.runtime.text(), /没有浏览器实例/u);

  page.setInstances(INSTANCES);
  page.runtime.find((node) => node.props.className === "dsh-vnc-secondary" && node.type === "button").props.onClick();
  await page.settle();
  assert.equal(listRows(page).length, 2, "the retry recovers the list");
});

test("labels each row's state, so the list is readable without a hover", async () => {
  const page = await mountShell({ instances: INSTANCES });
  const rows = listRows(page);
  assert.deepEqual(rows.map((row) => row.props["data-state"]), ["ready", "starting"]);
  // Both labels are visible text: the state is the first thing that decides
  // whether a row is worth clicking.
  assert.match(page.runtime.text(), /就绪/u);
  assert.match(page.runtime.text(), /启动中/u);
  // Each row still names its instance for a screen reader, state included.
  assert.match(rows[0].props["aria-label"], /aaaa1111/u);
  assert.match(rows[0].props["aria-label"], /就绪/u);
});
