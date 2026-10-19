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
const EXPECTED_RFB_PATH = "/_dsh/desktop-vnc/asset/core/rfb.js";

// ===== a tiny React-shaped hook runtime =====

/**
 * Build a React stub whose `createElement` returns a walkable tree and whose
 * hooks resolve by call order, so a function component can be rendered and
 * re-rendered outside a browser.
 * @returns the stub plus `render`, `setProps`, `unmount`, and `find`.
 */
function createHookRuntime(component, initialProps) {
  const slots = [];
  const Ref = Symbol("ref");
  const St = Symbol("state");
  const Ef = Symbol("effect");
  let cursor = 0;
  let props = initialProps;
  let rendering = false;
  let again = false;
  let tree = null;
  let unmounted = false;

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

  const React = {
    Fragment: "fragment",
    createElement: (type, elementProps, ...children) => {
      const node = {
        type,
        props: elementProps ?? {},
        children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
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
    do {
      again = false;
      cursor = 0;
      tree = component(props);
      runEffects();
    } while (again);
    rendering = false;
  };

  return {
    React,
    render,
    get tree() { return tree; },
    setProps(next) {
      props = { ...props, ...next };
      render();
    },
    unmount() {
      unmounted = true;
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
 * @param options - `visible` is the pane's initial visibility; `failImports`
 *                  makes the fake noVNC module reject that many times, which is
 *                  how the automatic retry bound is observed.
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
    fullscreenElement: null,
    head: { append: (node) => headChildren.push(node) },
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: () => ({ id: "", dataset: {}, textContent: "", remove: () => {} }),
  };
  const window = {
    location: { protocol: "http:", host: "127.0.0.1:3080" },
    fetch: async () => ({ ok: true, json: async () => ({ vncRunning: false }) }),
    isSecureContext: true,
  };
  const navigator = { clipboard: { readText: async () => "from-clipboard" } };

  let entry = null;
  window.__ModuleLoader__ = { load: (spec) => { entry = spec; } };
  const sandbox = { window, document, navigator, console, Promise, Object, Array, Error, JSON, setTimeout, clearTimeout, fetch: window.fetch };
  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SOURCE, sandbox, { filename: CLIENT_PATH, timeout: 2000 });
  assert.notEqual(entry, null, "the bundle must register with window.__ModuleLoader__");

  // The factory captures `require('react')` while evaluating, before the hook
  // runtime exists; the proxy resolves each hook against the live runtime so
  // the real component renders with the stub's hooks.
  const reactTarget = { current: null };
  const ReactProxy = new Proxy({}, { get: (_target, name) => reactTarget.current[name] });
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
    const runtime = createHookRuntime(exported.__test.createVncPage(t, connection), {
      useTabInfo: () => ({ tab: { id: tabId, visible: tabVisible } }),
    });
  reactTarget.current = runtime.React;
  runtime.render();

  return {
    runtime,
    created,
    importedPaths,
    exported,
    ZH: exported.__test.ZH_DICT,
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
  assert.equal(rfb.url, "ws://127.0.0.1:3080/_dsh/desktop-vnc/ws");
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
