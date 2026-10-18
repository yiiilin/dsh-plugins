import assert from "node:assert/strict";
import test from "node:test";
import {
  FakeWindow,
  createContext,
  createSlots,
  createTime,
  loadBundle,
  settle,
  waitFor,
} from "./support/browser-harness.js";

const AUTH_MODULE = new URL("../client.js", import.meta.url);
const CONNECTION_MODULE = import.meta.resolve("@deepseek-ai/dsh-client-connection/client");

/**
 * The generation source as the api gateway sees it behind a phone's radio:
 * `ready` reports the established generation, then the stream stays pending
 * forever — the browser's half-open socket after a screen lock never delivers
 * a close event, so nothing below ever learns the carrier died.
 */
function deadCarrierSource(counter) {
  return (signal, ready) => {
    counter.runs += 1;
    ready({ home: "/home/dsh" });
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
}

function bootCore() {
  const time = createTime();
  const win = new FakeWindow(time);
  win.document.documentElement.setAttribute("data-dsh-auth-mobile", "");
  const connectionModule = loadBundle(CONNECTION_MODULE, win);
  const harness = createContext();
  connectionModule.apply(harness.ctx);
  return { time, win, handle: harness.services.connection, harness };
}

function bootWatchdog(win, handle) {
  const client = loadBundle(AUTH_MODULE, win);
  const harness = createContext({ connection: handle, slots: createSlots() });
  client.apply(harness.ctx);
  return harness;
}

test("BUG-RESUME-1: unlocking the phone rebuilds the generation a dead carrier froze", async () => {
  const { time, win, handle, harness } = bootCore();
  const counter = { runs: 0 };
  handle.registerGenerationSource(deadCarrierSource(counter));
  const loop = handle.start({});
  await waitFor(() => handle.generation.getSnapshot() !== undefined);
  assert.equal(counter.runs, 1);
  const authHarness = bootWatchdog(win, handle);

  // The phone locks: the carrier dies silently and the freeze sets in.
  win.hide();
  time.advance(10 * 60 * 1000);
  await settle();
  assert.equal(counter.runs, 1, "the frozen symptom: a half-open carrier is invisible, nothing rebuilds it");

  // The user unlocks the screen: the page must come back alive.
  win.show();
  await waitFor(() => counter.runs === 2);
  const generation = handle.generation.getSnapshot();
  assert.ok(generation !== undefined && generation.id >= 2, "the resume must open a fresh generation and resync");
  authHarness.disposeAll();
  loop.stop();
  harness.disposeAll();
});

test("BUG-RESUME-3: a short app switch recovers a journal after its carrier dies", async () => {
  const { time, win, handle, harness } = bootCore();
  const counter = { runs: 0 };
  handle.registerGenerationSource(deadCarrierSource(counter));
  const loop = handle.start({});
  await waitFor(() => handle.generation.getSnapshot() !== undefined);
  const authHarness = bootWatchdog(win, handle);

  try {
    win.hide();
    time.advance(5 * 1000);
    win.show();
    await waitFor(() => counter.runs === 2, { timeoutMs: 100 });
  } finally {
    authHarness.disposeAll();
    loop.stop();
    harness.disposeAll();
  }
});

test("BUG-RESUME-4: focus recovers when visibilitychange was not delivered", async () => {
  const { time, win, handle, harness } = bootCore();
  const counter = { runs: 0 };
  handle.registerGenerationSource(deadCarrierSource(counter));
  const loop = handle.start({});
  await waitFor(() => handle.generation.getSnapshot() !== undefined);
  const authHarness = bootWatchdog(win, handle);

  try {
    win.dispatchEvent(new Event("blur"));
    time.advance(5 * 1000);
    win.dispatchEvent(new Event("focus"));
    await waitFor(() => counter.runs === 2, { timeoutMs: 100 });
  } finally {
    authHarness.disposeAll();
    loop.stop();
    harness.disposeAll();
  }
});

test("BUG-RESUME-1b: a retry loop suspended while offline is unparked by the resume", async () => {
  const { time, win, handle, harness } = bootCore();
  const counter = { runs: 0 };
  handle.registerGenerationSource(deadCarrierSource(counter));
  const loop = handle.start({});
  await waitFor(() => handle.generation.getSnapshot() !== undefined);
  const authHarness = bootWatchdog(win, handle);

  // The sleep drops the network: the browser reports offline and the loop
  // parks — mobile browsers often never deliver the matching "online" event.
  win.dispatchEvent(new Event("offline"));
  win.hide();
  time.advance(10 * 60 * 1000);
  await settle();
  assert.equal(counter.runs, 1);

  win.show();
  await waitFor(() => counter.runs === 2, { timeoutMs: 2000 });
  authHarness.disposeAll();
  loop.stop();
  harness.disposeAll();
});
