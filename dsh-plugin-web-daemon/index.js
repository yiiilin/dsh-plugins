/**
 * dsh-plugin-web-daemon
 *
 * Host half of the Web daemon plugin. It manages the `dsh web` worker as a
 * real systemd unit: generates the unit file, maps the GUI buttons onto
 * systemctl verbs, and exposes a small editable namespace (enabled, profile,
 * port, unit name, scope) through the Host settings service.
 *
 * The unit gets DSH_WEB_DAEMON_WORKER=1 so a daemonized process running the
 * same profile does not offer recursive daemon control in its own GUI.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

export const name = "web-daemon";
export const inject = ["webServer", "settings"];

const NS = settingsNamespace("web-daemon");
const WORKER_FLAG = "DSH_WEB_DAEMON_WORKER";
const API_PREFIX = "/_dsh/web-daemon";

export const Config = z.object({
  /** Boot-autostart and keep the unit enabled. */
  enabled: z.boolean().default(false),
  /** DSH profile the worker runs. */
  profile: z.string().default("web"),
  /** Port the worker listens on (always loopback; LAN access is auth-webserver's job). */
  port: z.natural().max(65535).default(3081),
  /** Name of the generated systemd unit. */
  systemdUnit: z.string().default("dsh-web.service"),
  /** system units live in /etc/systemd/system (needs root); user units use --user. */
  systemdScope: z
    .union([z.const("system"), z.const("user")])
    .default("system"),
});

function dshHome() {
  const env = process.env.DSH_HOME;
  if (env !== undefined && env.trim().length > 0) return resolve(env.trim());
  return join(homedir(), ".dsh");
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function plainClone(value) {
  if (Array.isArray(value)) return value.map(plainClone);
  if (value !== null && typeof value === "object") {
    const out = Object.create(null);
    for (const key of Object.keys(value)) out[key] = plainClone(value[key]);
    return out;
  }
  return value;
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function readJson(req, limit = 262144) {
  let body = "";
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body too large");
    body += chunk;
  }
  if (body.length === 0) return {};
  return JSON.parse(body);
}

function systemdQuote(value) {
  const text = String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "$$")
    .replace(/%/g, "%%");
  return /[\s"'$`]/.test(String(value)) ? `"${text}"` : text;
}

function systemdUnitName(cfg) {
  let name = String(cfg.systemdUnit || "dsh-web.service");
  if (!name.endsWith(".service")) name += ".service";
  if (!/^[A-Za-z0-9_.:\\-]+\.service$/.test(name)) {
    throw new Error(`invalid systemd unit name: ${name}`);
  }
  return name;
}

function systemUnitPathFor(cfg) {
  const name = systemdUnitName(cfg);
  if (cfg.systemdScope === "user") {
    const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
    return join(base, "systemd", "user", name);
  }
  return join("/etc/systemd/system", name);
}

function systemdCtlArgs(cfg, ...args) {
  if (cfg.systemdScope === "user") return ["--user", ...args];
  return args;
}

function runSystemctl(cfg, args) {
  const full = systemdCtlArgs(cfg, ...args);
  try {
    return execFileSync("systemctl", full, {
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail =
      error?.stderr !== undefined && String(error.stderr).trim() !== ""
        ? String(error.stderr).trim()
        : (error?.message ?? String(error));
    throw new Error(`systemctl ${full.join(" ")} failed: ${detail}`);
  }
}

function readSystemdStatus(cfg) {
  const full = systemdCtlArgs(
    cfg,
    "show",
    systemdUnitName(cfg),
    "-p",
    "ActiveState",
    "-p",
    "SubState",
    "-p",
    "MainPID",
    "-p",
    "NRestarts",
    "-p",
    "ExecMainStartTimestamp",
    "-p",
    "UnitFileState",
    "--no-pager",
  );
  try {
    const out = execFileSync("systemctl", full, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const record = {};
    for (const line of out.split("\n")) {
      const index = line.indexOf("=");
      if (index > 0) record[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
    const pid = Number.parseInt(record.MainPID ?? "0", 10);
    return {
      active: record.ActiveState ?? null,
      sub: record.SubState ?? null,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      restarts: Number.parseInt(record.NRestarts ?? "0", 10) || 0,
      startedAt: record.ExecMainStartTimestamp || null,
      unitFileState: record.UnitFileState || null,
    };
  } catch {
    // The unit may not exist yet (first enable) — treat as stopped.
    return null;
  }
}

/** UI-facing status derived from the systemd ActiveState. */
function statusOf(status) {
  if (status === null) return "stopped";
  switch (status.active) {
    case "active":
      return "running";
    case "activating":
      return "starting";
    case "deactivating":
      return "stopping";
    case "reloading":
      return "restarting";
    case "failed":
      return "failed";
    default:
      return "stopped";
  }
}

function workerCommandFor(cfg) {
  const entry = process.argv[1] || "dsh";
  const args = [
    "--profile",
    String(cfg.profile || "web"),
    "--no-open",
    "--port",
    String(cfg.port ?? 3081),
  ];
  return [entry, ...args].map(systemdQuote).join(" ");
}

/**
 * Render one simple on-failure unit. Logs go to the journal; restart pacing
 * and start limits are left to systemd's own defaults.
 */
function renderSystemdUnit(cfg) {
  const lines = [
    "# Generated by dsh-plugin-web-daemon — do not edit by hand.",
    "",
    "[Unit]",
    "Description=DSH web daemon (dsh-plugin-web-daemon)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${workerCommandFor(cfg)}`,
    "Restart=on-failure",
    "RestartSec=2",
    `Environment=${systemdQuote(`${WORKER_FLAG}=1`)}`,
    `Environment=${systemdQuote(`DSH_HOME=${dshHome()}`)}`,
    `Environment=${systemdQuote(`HOME=${homedir()}`)}`,
    `Environment=${
      systemdQuote(
        `PATH=${
          process.env.PATH ||
          "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        }`,
      )
    }`,
    "",
    "[Install]",
    cfg.systemdScope === "user"
      ? "WantedBy=default.target"
      : "WantedBy=multi-user.target",
  ];
  return lines.join("\n") + "\n";
}

function writeSystemdUnit(cfg) {
  const target = systemUnitPathFor(cfg);
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, renderSystemdUnit(cfg), "utf8");
  runSystemctl(cfg, ["daemon-reload"]);
  return target;
}

function createWebDaemonManager(ctx, settings, config) {
  const isWorker = process.env[WORKER_FLAG] === "1";
  const state = {
    config: clone(config),
    revision: 0,
  };

  const snapshotOf = () => {
    const cfg = state.config;
    // Nested workers read the unit status too, so the managed GUI shows the
    // real PID/restart counters of the unit it runs under.
    const status = readSystemdStatus(cfg);
    let revision = state.revision;
    let savedConfig = clone(cfg);
    let writable = false;
    if (settings !== undefined) {
      const descriptor = settings
        .describe({ redactSecrets: true })
        .find((entry) => entry.ns === NS);
      if (descriptor !== undefined) {
        revision = descriptor.revision;
        savedConfig = clone(descriptor.value);
        writable = settings.writable;
      }
    }
    return {
      config: savedConfig,
      revision,
      writable,
      nested: isWorker,
      supervisor: "systemd",
      status: statusOf(status),
      pid: status?.pid ?? null,
      restarts: status?.restarts ?? 0,
      startedAt: status?.startedAt ?? null,
      unit: {
        name: systemdUnitName(cfg),
        scope: cfg.systemdScope,
        path: systemUnitPathFor(cfg),
        activeState: status?.active ?? null,
        unitFileState: status?.unitFileState ?? null,
      },
      command: workerCommandFor(cfg),
    };
  };

  const rememberRevision = () => {
    if (settings === undefined) return;
    const descriptor = settings
      .describe({ redactSecrets: true })
      .find((entry) => entry.ns === NS);
    state.revision = descriptor?.revision ?? state.revision;
  };

  const ensureUnit = (cfg) => {
    const target = writeSystemdUnit(cfg);
    if (cfg.enabled) runSystemctl(cfg, ["enable", systemdUnitName(cfg)]);
    else {
      try {
        runSystemctl(cfg, ["disable", systemdUnitName(cfg)]);
      } catch {
        // A never-enabled unit reports an error on disable; harmless here.
      }
    }
    return target;
  };

  const startUnit = async () => {
    ensureUnit(state.config);
    runSystemctl(state.config, ["start", systemdUnitName(state.config)]);
  };

  const stopUnit = () => {
    runSystemctl(state.config, ["stop", systemdUnitName(state.config)]);
  };

  const restartUnit = () => {
    ensureUnit(state.config);
    runSystemctl(state.config, ["restart", systemdUnitName(state.config)]);
  };

  // Restart issued from inside the managed worker itself (e.g. after a plugin
  // update). systemd stops this very process as part of the job — which is why
  // this must be a systemctl restart, never a self-exit: under
  // `Restart=on-failure` a clean exit would leave the unit down. The HTTP
  // response is never delivered; the browser reconnects to the new process.
  const restartSelf = () => {
    runSystemctl(state.config, ["restart", systemdUnitName(state.config)]);
  };

  const resetFailed = () => {
    try {
      runSystemctl(state.config, ["reset-failed", systemdUnitName(state.config)]);
    } catch (error) {
      ctx.logger?.warn("web-daemon: systemd reset-failed error: %s", error);
    }
  };

  const applyConfig = (next, revision) => {
    const old = state.config;
    const changed = JSON.stringify(old) !== JSON.stringify(next);
    const enabledChanged = Boolean(old.enabled) !== Boolean(next.enabled);
    state.config = clone(next);
    state.revision = revision;
    if (isWorker || !changed) return;

    try {
      ensureUnit(next);
      if (enabledChanged) {
        if (next.enabled) runSystemctl(next, ["start", systemdUnitName(next)]);
        else runSystemctl(next, ["stop", systemdUnitName(next)]);
      } else {
        const status = readSystemdStatus(next);
        if (status !== null && (status.active === "active" || status.active === "activating")) {
          runSystemctl(next, ["restart", systemdUnitName(next)]);
        }
      }
    } catch (error) {
      ctx.logger?.warn("web-daemon: applying settings failed: %s", error);
    }
  };

  if (settings !== undefined) {
    const scope = settings.register(NS, Config, {
      base: clone(config),
      applies: "live",
    });
    state.config = clone(scope.get());
    rememberRevision();
    ctx.effect(() => scope.watch((next) => applyConfig(clone(next), state.revision)));
  }

  if (!isWorker && state.config.enabled) {
    // Boot-time convenience: bring an enabled unit up once the GUI mounts.
    setTimeout(() => {
      try {
        const status = readSystemdStatus(state.config);
        if (status === null || status.active === "inactive" || status.active === "failed") {
          startUnit();
        }
      } catch (error) {
        ctx.logger?.warn("web-daemon: autostart failed: %s", error);
      }
    }, 0);
  }

  return {
    getSnapshot: snapshotOf,
    startUnit,
    stopUnit,
    restartUnit,
    restartSelf,
    resetFailed,
    applyConfig,
    rememberRevision,
  };
}

function apply(ctx, config = {}) {
  const webServer = ctx.get("webServer");
  if (webServer === undefined) return;

  const settings = ctx.get("settings");
  const manager = createWebDaemonManager(ctx, settings, config);

  const handle = async (req, res, action) => {
    try {
      let body = {};
      if (action !== "state" && req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      if (req.method === "POST") {
        try {
          body = await readJson(req);
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }

      if (action === "state") {
        sendJson(res, 200, { ok: true, ...manager.getSnapshot() });
        return;
      }

      const snapshot = manager.getSnapshot();
      if (snapshot.nested && action !== "restart") {
        // A managed worker may only ask systemd to restart its own unit;
        // Start/Stop/config changes stay with the unit owner.
        sendJson(res, 403, {
          ok: false,
          error: "inside a managed worker only Restart is available",
        });
        return;
      }
      if (action === "restart" && snapshot.nested) {
        manager.restartSelf();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (action === "save") {
        if (settings === undefined || !settings.writable) {
          sendJson(res, 400, {
            ok: false,
            error: "settings are not writable in this deployment",
          });
          return;
        }
        if (body.config === undefined || typeof body.config !== "object") {
          sendJson(res, 400, { ok: false, error: "config object is required" });
          return;
        }
        const merged = { ...manager.getSnapshot().config, ...plainClone(body.config) };
        try {
          await settings.update(NS, plainClone(merged), body.revision ?? snapshot.revision);
          manager.applyConfig(merged, body.revision ?? snapshot.revision);
          manager.rememberRevision();
          sendJson(res, 200, { ok: true, ...manager.getSnapshot() });
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      try {
        if (action === "start") {
          if (settings !== undefined && settings.writable && !snapshot.config.enabled) {
            await settings.update(NS, { enabled: true }, snapshot.revision);
            manager.applyConfig({ ...snapshot.config, enabled: true }, snapshot.revision);
            manager.rememberRevision();
          } else {
            await manager.startUnit();
          }
        } else if (action === "stop") {
          if (settings !== undefined && settings.writable && snapshot.config.enabled) {
            await settings.update(NS, { enabled: false }, snapshot.revision);
            manager.applyConfig({ ...snapshot.config, enabled: false }, snapshot.revision);
            manager.rememberRevision();
          } else {
            manager.stopUnit();
          }
        } else if (action === "restart") {
          manager.restartUnit();
        } else if (action === "reset") {
          manager.resetFailed();
        } else {
          sendJson(res, 404, { ok: false, error: `unknown action: ${action}` });
          return;
        }
        sendJson(res, 200, { ok: true, ...manager.getSnapshot() });
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  ctx.effect(() => webServer.register({ kind: "exact", path: `${API_PREFIX}/state`, handler: (req, res) => handle(req, res, "state") }));
  ctx.effect(() => webServer.register({ kind: "exact", path: `${API_PREFIX}/save`, handler: (req, res) => handle(req, res, "save") }));
  ctx.effect(() => webServer.register({ kind: "exact", path: `${API_PREFIX}/start`, handler: (req, res) => handle(req, res, "start") }));
  ctx.effect(() => webServer.register({ kind: "exact", path: `${API_PREFIX}/stop`, handler: (req, res) => handle(req, res, "stop") }));
  ctx.effect(() => webServer.register({ kind: "exact", path: `${API_PREFIX}/restart`, handler: (req, res) => handle(req, res, "restart") }));
  ctx.effect(() => webServer.register({ kind: "exact", path: `${API_PREFIX}/reset`, handler: (req, res) => handle(req, res, "reset") }));
}

export { apply };
