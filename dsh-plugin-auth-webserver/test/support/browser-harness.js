/**
 * Minimal browser/cordis harness for executing the shipped static client
 * bundles outside a browser.
 *
 * The bundles are `window.__ModuleLoader__.load({ factory })` payloads: run
 * their source inside a `node:vm` context with a fake `window`/`document`, a
 * controlled clock, and a require stub, then drive real DOM events at them.
 * Tests exercise the exact code the browser runs — never a copy of it.
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";

/** Deterministic wall clock the bundle sees through its `Date` binding. */
export function createTime(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
      return current;
    },
  };
}

export class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.visibilityState = "visible";
    this.hidden = false;
    this.cookie = "";
    this.lang = "zh-CN";
    const attributes = new Set();
    this.documentElement = {
      lang: "zh-CN",
      setAttribute(name) { attributes.add(name); },
      removeAttribute(name) { attributes.delete(name); },
      hasAttribute(name) { return attributes.has(name); },
    };
    this.head = {
      appended: [],
      append: (node) => {
        this.head.appended.push(node);
      },
    };
    this.body = { appendChild() {}, removeChild() {} };
    this.readyState = "complete";
  }

  getElementById() {
    return null;
  }

  createElement(tagName) {
    return {
      tagName: String(tagName).toUpperCase(),
      id: "",
      type: "",
      textContent: "",
      style: {},
      setAttribute() {},
      removeAttribute() {},
      getAttribute() {
        return null;
      },
      addEventListener() {},
      removeEventListener() {},
      appendChild() {},
    };
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  addEventListener(...args) {
    return super.addEventListener(...args);
  }
}

export class FakeWindow extends EventTarget {
  constructor(time) {
    super();
    this.time = time;
    this.document = new FakeDocument();
    this.navigator = { onLine: true, language: "zh-CN" };
    this.location = {
      origin: "https://dsh.test",
      href: "https://dsh.test/",
      pathname: "/",
      search: "",
      reload: () => {
        this.reloads += 1;
      },
    };
    this.reloads = 0;
    this.requests = [];
    /** Tests swap this out to script the gateway's answers. */
    this.fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
    this.fetch = (url, init) => {
      this.requests.push([String(url), init]);
      return Promise.resolve().then(() => this.fetchImpl(String(url), init));
    };
    this.setTimeout = setTimeout;
    this.clearTimeout = clearTimeout;
    this.setInterval = setInterval;
    this.clearInterval = clearInterval;
  }

  /** Lock the phone: the page goes to the background. */
  hide() {
    this.document.visibilityState = "hidden";
    this.document.hidden = true;
    this.document.dispatchEvent(new Event("visibilitychange"));
  }

  /** Unlock the phone: the page comes back to the foreground. */
  show() {
    this.document.visibilityState = "visible";
    this.document.hidden = false;
    this.document.dispatchEvent(new Event("visibilitychange"));
  }
}

const REQUIRES = {
  react: new Proxy({}, {
    get: (_target, name) => (name === "Fragment" ? "fragment" : () => null),
  }),
};

/**
 * Run one shipped bundle and return its exports.
 * @param moduleUrl - URL of the bundle file to execute.
 * @param win - fake window whose `document` and clock back the bundle.
 * @returns the exports object the factory returned.
 */
export function loadBundle(moduleUrl, win) {
  const source = readFileSync(fileURLToPath(moduleUrl), "utf8");
  let captured = null;
  const HarnessDate = class extends Date {
    static now() {
      return win.time.now();
    }
  };
  const sandbox = {
    console,
    Date: HarnessDate,
    window: win,
    document: win.document,
    navigator: win.navigator,
    fetch: win.fetch,
    location: undefined,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    setImmediate,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    Event,
    EventTarget,
    crypto: webcrypto,
  };
  sandbox.globalThis = sandbox;
  win.__ModuleLoader__ = {
    load(spec) {
      captured = spec;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: fileURLToPath(moduleUrl) });
  if (captured === null) throw new Error(`bundle did not register with __ModuleLoader__: ${String(moduleUrl)}`);
  return captured.factory((name) => {
    if (name in REQUIRES) return REQUIRES[name];
    throw new Error(`unexpected client require: ${name}`);
  });
}

/** Fake client cordis context: `get`/`provide`/`effect`/`on` as the bundles use them. */
export function createContext(services = {}) {
  const store = { ...services };
  const disposers = [];
  const listeners = new Map();
  const ctx = {
    get: (name) => store[name],
    provide: (name, value) => {
      store[name] = value;
    },
    effect: (callback) => {
      const dispose = callback();
      if (typeof dispose === "function") disposers.push(dispose);
      return typeof dispose === "function" ? dispose : () => {};
    },
    on: (name, listener) => {
      const set = listeners.get(name) ?? new Set();
      set.add(listener);
      listeners.set(name, set);
      return () => set.delete(listener);
    },
    emit: (name) => {
      for (const listener of [...(listeners.get(name) ?? [])]) listener();
    },
  };
  return {
    ctx,
    services: store,
    disposeAll: () => {
      while (disposers.length > 0) {
        const dispose = disposers.pop();
        try {
          dispose();
        } catch {
          /* disposal must not mask the assertion under test */
        }
      }
    },
  };
}

/** Minimal slots service so `apply()` reaches its registration calls. */
export function createSlots() {
  const registered = [];
  return {
    registered,
    inject: (name, callback) => {
      callback();
      return () => {};
    },
    register: (descriptor, component) => {
      registered.push([descriptor, component]);
      return () => {};
    },
  };
}

/** Poll until `predicate` holds or the deadline passes. */
export async function waitFor(predicate, { timeoutMs = 1000, stepMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("waitFor: predicate never became true");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** Let queued promise jobs and immediates settle. */
export async function settle(rounds = 4) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
