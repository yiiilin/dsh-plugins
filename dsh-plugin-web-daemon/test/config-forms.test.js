import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.DSH_WEB_DAEMON_MODULE
  ?? "/root/.dsh/profiles/web/node_modules/@yiln-dsh/dsh-plugin-web-daemon/index.js";
const { apply } = await import(pathToFileURL(modulePath).href);

function volatile(value) {
  let current = value;
  return {
    get() { return current; },
    set(next) { current = next; },
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Load the plugin against a temporary DSH home and a `systemctl` shim, then hand
 * the Settings card's JSON API and the generated unit to one test body.
 * @param run - receives `{ call, config, unitPath, readUnit }`.
 */
async function withHarness(run) {
  const home = mkdtempSync(join(tmpdir(), "dsh-web-daemon-config-"));
  const bin = join(home, "bin");
  const xdg = join(home, "config");
  mkdirSync(bin, { recursive: true });
  symlinkSync("/bin/true", join(bin, "systemctl"));

  const previousEnv = Object.fromEntries([
    "DSH_HOME",
    "DSH_WEB_DAEMON_WORKER",
    "PATH",
    "XDG_CONFIG_HOME",
  ].map((key) => [key, process.env[key]]));
  process.env.DSH_HOME = home;
  delete process.env.DSH_WEB_DAEMON_WORKER;
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.XDG_CONFIG_HOME = xdg;

  const config = {
    enabled: volatile(false),
    profile: volatile("web"),
    port: volatile(3080),
    startCommand: volatile(""),
    systemdUnit: volatile("dsh-web.service"),
    systemdScope: volatile("user"),
  };
  const value = () => Object.fromEntries(Object.entries(config).map(([key, cell]) => [key, cell.get()]));
  const listeners = new Map();
  const routes = new Map();
  const disposers = [];
  let revision = 0;
  const emit = (name) => {
    for (const listener of listeners.get(name) ?? []) listener();
  };
  const settings = {
    writable: true,
    configure() { return () => {}; },
    describe() { return [{ ns: "web-daemon", revision, value: value() }]; },
    async update(ns, patch, expectedRevision) {
      assert.equal(ns, "web-daemon");
      assert.equal(expectedRevision, revision);
      for (const [key, next] of Object.entries(patch)) config[key]?.set(next);
      revision += 1;
      emit("loader/volatile-update");
    },
  };
  const webServer = {
    register({ path, handler }) {
      routes.set(path, handler);
      return () => routes.delete(path);
    },
  };
  const ctx = {
    fiber: {},
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      if (name === "settings") return settings;
      if (name === "webServer") return webServer;
      return undefined;
    },
    on(name, listener) {
      const group = listeners.get(name) ?? new Set();
      group.add(listener);
      listeners.set(name, group);
      return () => group.delete(listener);
    },
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
  };

  const unitPath = join(xdg, "systemd", "user", "dsh-web.service");
  const readUnit = () => readFileSync(unitPath, "utf8");
  const call = async (action, body) => {
    const handler = routes.get(`/_dsh/web-daemon/${action}`);
    assert.equal(typeof handler, "function", `the ${action} route is registered`);
    const chunk = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = {
      method: chunk === undefined ? "GET" : "POST",
      async *[Symbol.asyncIterator]() {
        if (chunk !== undefined) yield chunk;
      },
    };
    const response = {
      writeHead(status) { this.status = status; },
      end(payload) { this.body = payload; },
    };
    await handler(req, response);
    return {
      status: response.status,
      payload: response.body === undefined ? undefined : JSON.parse(response.body),
    };
  };
  const save = (patch, expectedRevision = revision) => call("save", {
    config: { ...value(), ...patch },
    revision: expectedRevision,
  });

  try {
    await apply(ctx, config);
    await run({ call, save, config, unitPath, readUnit });
  } finally {
    for (const dispose of disposers.reverse()) await dispose();
    for (const [key, previous] of Object.entries(previousEnv)) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

test("alpha SettingsForms save refreshes the generated user unit", async () => {
  await withHarness(async ({ save, readUnit }) => {
    const response = await save({ port: 3082 });

    assert.equal(response.status, 200);
    assert.equal(response.payload.config.port, 3082);
    assert.equal(response.payload.revision, 1);
    assert.match(readUnit(), /--port 3082/u);
  });
});

test("an empty start command keeps the generated ExecStart", async () => {
  await withHarness(async ({ call, readUnit }) => {
    const state = await call("state");

    assert.equal(state.status, 200);
    assert.match(state.payload.command, /--profile web --no-open --port 3080$/u);
    assert.match(readUnit(), /^ExecStart=.*--profile web --no-open --port 3080$/mu);
  });
});

test("a written start command becomes ExecStart verbatim", async () => {
  await withHarness(async ({ call, readUnit }) => {
    const command = '/usr/local/bin/dsh-wrapper --foreground --flag "two words"';
    const response = await call("save", {
      config: { profile: "web", port: 3080, startCommand: command },
      revision: 0,
    });

    assert.equal(response.status, 200);
    assert.equal(response.payload.config.startCommand, command);
    // The written line is the whole command: the generated args are gone, and
    // the operator's own quoting reaches systemd untouched.
    assert.equal(response.payload.command, command);
    assert.match(readUnit(), new RegExp(`^ExecStart=${escapeRegExp(command)}$`, "mu"));
    assert.doesNotMatch(readUnit(), /--no-open/u);
  });
});

test("a multi-line start command is refused before it reaches the unit", async () => {
  await withHarness(async ({ save, readUnit }) => {
    const before = readUnit();
    const response = await save({ startCommand: "dsh web\nRuntimeMaxSec=1" });

    assert.equal(response.status, 400);
    assert.match(response.payload.error, /one line/u);
    assert.equal(readUnit(), before);
  });
});