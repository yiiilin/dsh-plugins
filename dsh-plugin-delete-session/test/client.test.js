import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("../client.js", import.meta.url), "utf8");

const reactStub = {
  Fragment: Symbol("Fragment"),
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: () => ({ current: null }),
  useState: () => [undefined, () => {}],
};

/** Load the browser half with the stubs it needs, and hand back its test seam. */
function loadClient() {
  let factory;
  const window = { __ModuleLoader__: { load(spec) { factory = spec.factory; } } };
  const requireStub = (id) => {
    if (id === "react") return reactStub;
    if (id === "react-dom") return { createPortal: () => null };
    if (id === "@deepseek-ai/dsh-client-ui-primitives") {
      return { IconChecklistOutline14: null, IconEllipsisOutline16: null, IconTrashOutline16: null };
    }
    throw new Error(`unexpected require(${id})`);
  };
  new Function("window", SOURCE)(window);
  return { exports: factory(requireStub), window };
}

/** A minimal box. */
function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function element(box) {
  return {
    getBoundingClientRect: () => box,
    getClientRects: () => [box],
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

const ROW_BOX = rect(20, 300, 220, 28);
/** The row's own popup, anchored just outside the row's action button. */
const ROW_MENU_BOX = rect(250, 308, 180, 120);
/** The composer's permission dropdown, open far away from the sidebar. */
const PERMISSION_MENU_BOX = rect(700, 820, 160, 132);

function sessionRow() {
  const button = element(rect(214, 306, 20, 20));
  return {
    querySelectorAll: (selector) => (selector === "button" ? [button] : []),
  };
}

function installDom(menus) {
  const previous = { document: globalThis.document, getComputedStyle: globalThis.getComputedStyle };
  globalThis.document = { querySelectorAll: () => menus };
  globalThis.getComputedStyle = () => ({ visibility: "visible" });
  return () => {
    globalThis.document = previous.document;
    globalThis.getComputedStyle = previous.getComputedStyle;
  };
}

test("adopts the menu anchored to the row, not another open popup", () => {
  const { exports } = loadClient();
  const rowMenu = element(ROW_MENU_BOX);
  const permissionMenu = element(PERMISSION_MENU_BOX);
  const restore = installDom([permissionMenu, rowMenu]);
  try {
    assert.equal(exports.__test.openMenuForRow(sessionRow()), rowMenu);
  } finally {
    restore();
  }
});

test("adopts nothing when the only open menu belongs elsewhere", () => {
  const { exports } = loadClient();
  const restore = installDom([element(PERMISSION_MENU_BOX)]);
  try {
    assert.equal(
      exports.__test.openMenuForRow(sessionRow()),
      null,
      "the permission dropdown is not this row's menu",
    );
  } finally {
    restore();
  }
});

test("adopts nothing without a row", () => {
  const { exports } = loadClient();
  assert.equal(exports.__test.openMenuForRow(null), null);
});

test("measures the gap between two boxes as zero when they touch", () => {
  const { exports } = loadClient();
  const gap = exports.__test.boxDistance(rect(0, 0, 10, 10), rect(10, 0, 10, 10));
  assert.equal(gap, 0);
  const diagonal = exports.__test.boxDistance(rect(0, 0, 10, 10), rect(13, 14, 10, 10));
  assert.equal(diagonal, 5, "3-4-5 triangle between the nearest corners");
});

test("refreshes the session list instead of reloading the page", async () => {
  const { exports, window } = loadClient();
  let refreshed = 0;
  let reloaded = 0;
  window.location = { reload: () => { reloaded += 1; } };

  await exports.__test.refreshSessionList({ refresh: async () => { refreshed += 1; } });

  assert.equal(refreshed, 1);
  assert.equal(reloaded, 0, "a shell that can refresh never needs the whole page again");
});

test("falls back to a reload when the shell cannot refresh", async () => {
  const { exports, window } = loadClient();
  let reloaded = 0;
  window.location = { reload: () => { reloaded += 1; } };

  await exports.__test.refreshSessionList(undefined);
  assert.equal(reloaded, 1, "an older shell without sessions.refresh still refreshes something");

  await exports.__test.refreshSessionList({ refresh: async () => { throw new Error("no host"); } });
  assert.equal(reloaded, 2, "a failed refresh still leaves the list consistent");
});
