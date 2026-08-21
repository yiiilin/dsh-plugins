/**
 * dsh-plugin-web-daemon
 *
 * Host half of the Web daemon plugin. It supervises a child `dsh web` process
 * with systemd-style restart policy, PID/log/state files, and a settings
 * namespace that the browser settings section reads and writes.
 *
 * The child gets DSH_WEB_DAEMON_WORKER=1 so a daemon running the same profile
 * does not recursively spawn another worker.
 */

import { spawn, execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

export const name = "web-daemon";
export const inject = ["webServer", "settings"];

const NS = settingsNamespace("web-daemon");
const WORKER_FLAG = "DSH_WEB_DAEMON_WORKER";
const API_PREFIX = "/_dsh/web-daemon";
const PID_WAIT_MS = 10000;

export const Config = z.object({
  enabled: z.boolean().default(false),
  profile: z.string().default("web"),
  host: z.string().default("127.0.0.1"),
  port: z.natural().max(65535).default(3081),
  noOpen: z.boolean().default(true),
  trustedHosts: z.array(z.string()).default([]),
  restart: z
    .union([z.const("no"), z.const("on-failure"), z.const("always")])
    .default("always"),
  restartSec: z.natural().default(2),
  startLimitIntervalSec: z.natural().default(60),
  startLimitBurst: z.natural().default(5),
  extraArgs: z.array(z.string()).default([]),
  environment: z.array(z.string()).default([]),
  workingDirectory: z.string().default(""),
  logDir: z.string().default("logs/web-daemon"),
  pidFile: z.string().default("run/web-daemon.pid"),
  systemd: z.boolean().default(false),
  systemdUnit: z.string().default("dsh-web.service"),
  systemdScope: z
    .union([z.const("system"), z.const("user")])
    .default("system"),
});

function dshHome() {
  const env = process.env.DSH_HOME;
  if (env !== undefined && env.trim().length > 0) {
    const value = env.trim();
    if (value === "~") return homedir();
    if (value.startsWith("~/") || value.startsWith("~\\")) {
      return join(homedir(), value.slice(2));
    }
    return resolve(value);
  }
  return join(homedir(), ".dsh");
}

function expandForHome(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(home, value.slice(2));
  }
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return value;
  return join(home, value);
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

function parseEnvironment(entries) {
  const out = Object.create(null);
  for (const raw of entries) {
    const line = String(raw);
    if (line.trim() === "") continue;
    const index = line.indexOf("=");
    if (index <= 0) {
      throw new Error(`environment entry must look like KEY=VALUE: ${line}`);
    }
    const key = line.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`invalid environment key: ${key}`);
    }
    out[key] = line.slice(index + 1);
  }
  return out;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
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

function systemdQuote(value) {
  const text = String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "$$")
    .replace(/%/g, "%%");
  return /[\s"'$`]/.test(String(value)) ? `"${text}"` : text;
}

function renderSystemdUnit(cfg, entry, args) {
  const home = dshHome();
  const exec = [entry, ...args].map(systemdQuote).join(" ");
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
    `ExecStart=${exec}`,
    `Restart=${cfg.restart}`,
    `RestartSec=${cfg.restartSec}`,
    `StartLimitIntervalSec=${cfg.startLimitIntervalSec}`,
    `StartLimitBurst=${cfg.startLimitBurst}`,
  ];
  const cwd = cfg.workingDirectory
    ? expandForHome(cfg.workingDirectory, home)
    : process.cwd();
  lines.push(`WorkingDirectory=${systemdQuote(cwd || "/")}`);
  const env = parseEnvironment(cfg.environment);
  env[WORKER_FLAG] = "1";
  env.DSH_HOME = home;
  env.HOME = homedir();
  env.PATH =
    process.env.PATH ||
    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  for (const [key, value] of Object.entries(env)) {
    lines.push(`Environment=${systemdQuote(`${key}=${value}`)}`);
  }
  const logPath = expandForHome(cfg.logDir, home);
  lines.push(`StandardOutput=append:${logPath}`);
  lines.push(`StandardError=append:${logPath}`);
  lines.push("");
  lines.push("[Install]");
  lines.push(
    cfg.systemdScope === "user" ? "WantedBy=default.target" : "WantedBy=multi-user.target",
  );
  return lines.join("\n") + "\n";
}

function writeSystemdUnit(cfg, entry, args) {
  const target = systemUnitPathFor(cfg);
  mkdirSync(resolve(target, ".."), { recursive: true });
  writeFileSync(target, renderSystemdUnit(cfg, entry, args), "utf8");
  return target;
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
      enabled: record.UnitFileState || null,
    };
  } catch {
    // The unit may not exist yet (first enable) — treat as stopped.
    return null;
  }
}

function createWebDaemonManager(ctx, webServer, settings, config) {
  const isWorker = process.env[WORKER_FLAG] === "1";
  const state = {
    config: clone(config),
    revision: 0,
    child: null,
    pid: null,
    status: "stopped",
    exitCode: null,
    signal: null,
    startedAt: null,
    stoppedAt: null,
    restarts: 0,
    lastRestartAt: null,
    command: [],
    logPath: null,
    pidFile: null,
    managed: config.enabled,
    stopping: false,
    adopted: false,
    failed: false,
    startTimes: [],
    schedule: null,
    stateFile: null,
  };

  const pathsFor = (cfg) => {
    const home = dshHome();
    const logPath = expandForHome(cfg.logDir, home);
    const pidFile = expandForHome(cfg.pidFile, home);
    const stateFile = join(
      home,
      "plugins",
      "dsh-plugin-web-daemon",
      "state.json",
    );
    return { home, logPath, pidFile, stateFile };
  };

  const commandFor = (cfg) => {
    const entry = process.argv[1] || "dsh";
    const args = ["--profile", cfg.profile];
    if (cfg.noOpen) args.push("--no-open");
    if (cfg.host && cfg.host !== "0.0.0.0") {
      args.push("--host", cfg.host);
    }
    args.push("--port", String(cfg.port));
    for (const authority of cfg.trustedHosts) {
      args.push("--trusted-host", authority);
    }
    for (const extra of cfg.extraArgs) args.push(extra);
    return { entry, args, display: [entry, ...args].join(" ") };
  };

  const childEnv = (cfg) => {
    const env = { ...process.env };
    Object.assign(env, parseEnvironment(cfg.environment));
    env[WORKER_FLAG] = "1";
    return env;
  };

  const ensureDirs = (paths) => {
    mkdirSync(resolve(paths.logPath, ".."), { recursive: true });
    mkdirSync(resolve(paths.pidFile, ".."), { recursive: true });
    mkdirSync(resolve(paths.stateFile, ".."), { recursive: true });
  };

  const logEvent = (paths, message, details = "") => {
    const line = `[${new Date().toISOString()}] ${message}${details ? ` ${details}` : ""}\n`;
    ctx.logger?.info("web-daemon: %s", line.trim());
    if (paths?.logPath) {
      try {
        appendFileSync(paths.logPath, line);
      } catch {
        // The child owns its log file when spawned; parent logging is best-effort.
      }
    }
  };

  const writeRuntime = () => {
    const paths = pathsFor(state.config);
    state.stateFile = paths.stateFile;
    try {
      ensureDirs(paths);
      if (state.pid) {
        writeFileSync(paths.pidFile, String(state.pid), "utf8");
      } else if (existsSync(paths.pidFile)) {
        rmSync(paths.pidFile, { force: true });
      }
      const runtime = {
        config: clone(state.config),
        pid: state.pid,
        status: state.status,
        startedAt: state.startedAt,
        stoppedAt: state.stoppedAt,
        restarts: state.restarts,
        lastRestartAt: state.lastRestartAt,
        command: state.command,
        logPath: state.logPath,
        pidFile: state.pidFile,
      };
      writeFileSync(paths.stateFile, JSON.stringify(runtime, null, 2), "utf8");
    } catch (error) {
      ctx.logger?.warn("web-daemon: could not persist state: %s", error);
    }
  };

  const removePidFile = () => {
    try {
      const paths = pathsFor(state.config);
      if (existsSync(paths.pidFile)) rmSync(paths.pidFile, { force: true });
    } catch {
      // Best effort; stale PID files are not fatal.
    }
  };

  const clearSchedule = () => {
    if (state.schedule !== null) {
      clearTimeout(state.schedule);
      state.schedule = null;
    }
  };

  const isSystemd = () => state.config.systemd === true;

  const applySystemdState = (status) => {
    if (status === null) {
      state.status = "stopped";
      state.pid = null;
      state.restarts = 0;
      state.startedAt = null;
      return;
    }
    state.status =
      status.active === "active"
        ? "running"
        : status.active === "activating"
          ? "starting"
          : status.active === "deactivating"
            ? "stopping"
            : status.active === "reloading"
              ? "restarting"
              : status.active === "failed"
                ? "failed"
                : "stopped";
    state.pid = status.pid;
    state.restarts = status.restarts;
    state.startedAt = status.startedAt ?? state.startedAt;
    state.adopted = false;
  };

  const ensureSystemdUnit = (cfg) => {
    const { entry, args, display } = commandFor(cfg);
    writeSystemdUnit(cfg, entry, args);
    runSystemctl(cfg, ["daemon-reload"]);
    return { display };
  };

  const startSystemdWorker = (manual) => {
    const cfg = state.config;
    const name = systemdUnitName(cfg);
    const current = readSystemdStatus(cfg);
    if (current?.active === "active") {
      applySystemdState(current);
      return;
    }
    ensureDirs(pathsFor(cfg));
    const { display } = ensureSystemdUnit(cfg);
    if (cfg.enabled && !manual) {
      runSystemctl(cfg, ["enable", name]);
    }
    runSystemctl(cfg, ["start", name]);
    applySystemdState(readSystemdStatus(cfg));
    const paths = pathsFor(cfg);
    state.command = display;
    state.logPath = paths.logPath;
    state.pidFile = paths.pidFile;
    state.exitCode = null;
    state.signal = null;
    state.adopted = false;
    state.failed = false;
    state.startTimes = [];
    state.stoppedAt = null;
    writeRuntime();
    logEvent(paths, "systemd unit started", `${name} (pid=${state.pid ?? "-"})`);
  };

  const stopSystemdWorker = () => {
    const cfg = state.config;
    const name = systemdUnitName(cfg);
    const status = readSystemdStatus(cfg);
    if (status !== null && status.active !== "inactive" && status.active !== "failed") {
      runSystemctl(cfg, ["stop", name]);
    }
    if (cfg.enabled && status !== null) {
      runSystemctl(cfg, ["disable", name]);
    }
    applySystemdState(readSystemdStatus(cfg));
    state.stoppedAt = new Date().toISOString();
    removePidFile();
    writeRuntime();
    logEvent(pathsFor(cfg), "systemd unit stopped", name);
  };

  const restartSystemdWorker = () => {
    const cfg = state.config;
    const name = systemdUnitName(cfg);
    ensureSystemdUnit(cfg);
    runSystemctl(cfg, ["restart", name]);
    applySystemdState(readSystemdStatus(cfg));
    writeRuntime();
    logEvent(pathsFor(cfg), "systemd unit restarted", `${name} (pid=${state.pid ?? "-"})`);
  };

  const removeSystemdUnit = (cfg) => {
    const name = systemdUnitName(cfg);
    if (readSystemdStatus(cfg) !== null) {
      try {
        runSystemctl(cfg, ["disable", name]);
      } catch (error) {
        ctx.logger?.warn("web-daemon: systemd disable failed: %s", error);
      }
      try {
        runSystemctl(cfg, ["stop", name]);
      } catch (error) {
        ctx.logger?.warn("web-daemon: systemd stop failed: %s", error);
      }
    }
    try {
      rmSync(systemUnitPathFor(cfg), { force: true });
      runSystemctl(cfg, ["daemon-reload"]);
    } catch (error) {
      ctx.logger?.warn("web-daemon: systemd unit removal failed: %s", error);
    }
  };

  let stoppingPromise = null;

  const stopInternalWorker = async () => {
    if (state.status === "stopped" && state.pid === null) return;
    if (stoppingPromise !== null) return stoppingPromise;

    state.stopping = true;
    clearSchedule();
    stoppingPromise = (async () => {
      const current = state.child;
      const pid = state.pid;
      state.child = null;
      state.pid = null;

      if (current !== null) {
        const stopSettled = new Promise((resolveStop) => {
          current.prependOnceListener("exit", resolveStop);
        });
        try {
          current.kill("SIGTERM");
        } catch {
          // Process may already be gone.
        }
        await Promise.race([
          stopSettled,
          new Promise((resolveTimeout) => {
            setTimeout(resolveTimeout, PID_WAIT_MS);
          }),
        ]);
        if (processAlive(current.pid)) {
          try {
            process.kill(current.pid, "SIGKILL");
          } catch {
            // Process exited during the race.
          }
          await Promise.race([
            stopSettled,
            new Promise((resolveTimeout) => {
              setTimeout(resolveTimeout, PID_WAIT_MS);
            }),
          ]);
        }
      } else if (pid !== null && processAlive(pid)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Process exited concurrently.
        }
      }

      state.stopping = false;
      state.status = "stopped";
      state.exitCode = null;
      state.signal = null;
      state.stoppedAt = new Date().toISOString();
      removePidFile();
      writeRuntime();
      logEvent(pathsFor(state.config), "worker stopped");
    })();

    try {
      await stoppingPromise;
    } finally {
      stoppingPromise = null;
    }
  };

  const stopWorker = async () => {
    if (isSystemd()) {
      stopSystemdWorker();
      return;
    }
    await stopInternalWorker();
  };

  const scheduleRestart = (exitCode, signal) => {
    clearSchedule();
    state.status = "restarting";
    state.exitCode = exitCode;
    state.signal = signal;
    state.stoppedAt = new Date().toISOString();
    writeRuntime();

    const shouldRestart =
      state.config.restart === "always" ||
      (state.config.restart === "on-failure" &&
        (exitCode !== 0 || signal !== null));
    if (!shouldRestart) {
      state.status = "stopped";
      writeRuntime();
      return;
    }

    const now = Date.now();
    const windowMs = state.config.startLimitIntervalSec * 1000;
    state.startTimes = state.startTimes.filter(
      (time) => now - time <= windowMs,
    );
    if (state.startTimes.length >= state.config.startLimitBurst) {
      state.status = "failed";
      state.failed = true;
      writeRuntime();
      logEvent(
        pathsFor(state.config),
        "start limit reached; manual reset/start required",
      );
      return;
    }
    state.startTimes.push(now);
    state.restarts += 1;
    state.lastRestartAt = new Date().toISOString();
    writeRuntime();
    logEvent(
      pathsFor(state.config),
      `worker exited (code=${exitCode}, signal=${String(signal)}), restarting in ${state.config.restartSec}s`,
    );
    state.schedule = setTimeout(
      () => startWorker(),
      Math.max(0, Number(state.config.restartSec)) * 1000,
    );
  };

  const startWorker = async (manual = false) => {
    if (isWorker) return;
    if (isSystemd()) {
      startSystemdWorker(manual);
      return;
    }
    if (state.stopping || state.status === "starting") return;
    if (
      state.child !== null ||
      (state.pid !== null && processAlive(state.pid))
    ) {
      state.status = state.pid ? "running" : state.status;
      return;
    }

    if (manual) state.failed = false;
    if (state.failed) {
      const now = Date.now();
      const windowMs = state.config.startLimitIntervalSec * 1000;
      state.startTimes = state.startTimes.filter(
        (time) => now - time <= windowMs,
      );
      if (state.startTimes.length >= state.config.startLimitBurst) {
        throw new Error("daemon start limit reached; reset the failed state first");
      }
    }

    state.managed = state.config.enabled || manual;
    state.status = "starting";
    state.failed = false;
    state.stoppedAt = null;

    const now = Date.now();
    const windowMs = state.config.startLimitIntervalSec * 1000;
    state.startTimes = state.startTimes.filter((time) => now - time <= windowMs);
    if (state.startTimes.length >= state.config.startLimitBurst) {
      state.status = "failed";
      state.failed = true;
      writeRuntime();
      throw new Error("daemon start limit reached; reset the failed state first");
    }
    state.startTimes.push(now);

    const paths = pathsFor(state.config);
    try {
      ensureDirs(paths);
      const { entry, args, display } = commandFor(state.config);
      const outFd = openSync(paths.logPath, "a");
      const options = {
        cwd: state.config.workingDirectory
          ? expandForHome(state.config.workingDirectory, paths.home)
          : process.cwd(),
        env: childEnv(state.config),
        detached: true,
        stdio: ["ignore", outFd, outFd],
      };
      let child;
      try {
        child = spawn(entry, args, options);
      } catch (error) {
        closeSync(outFd);
        throw error;
      }
      closeSync(outFd);
      state.child = child;
      state.pid = child.pid;
      state.command = display;
      state.logPath = paths.logPath;
      state.pidFile = paths.pidFile;
      state.startedAt = new Date().toISOString();
      state.status = "running";
      state.exitCode = null;
      state.signal = null;
      state.adopted = false;
      child.once("error", (error) => {
        state.child = null;
        state.pid = null;
        state.status = "failed";
        state.failed = true;
        state.stoppedAt = new Date().toISOString();
        removePidFile();
        writeRuntime();
        logEvent(paths, "worker failed to start", `${error.code ?? error.message}`);
      });
      child.once("exit", (code, signal) => {
        state.child = null;
        state.pid = null;
        removePidFile();
        if (state.stopping) {
          state.stopping = false;
          state.status = "stopped";
          state.exitCode = code;
          state.signal = signal;
          state.stoppedAt = new Date().toISOString();
          writeRuntime();
          return;
        }
        scheduleRestart(code, signal);
      });
      child.unref();
      writeRuntime();
      logEvent(paths, "worker started", `pid=${child.pid} :: ${display}`);
    } catch (error) {
      state.status = "failed";
      state.failed = true;
      state.stoppedAt = new Date().toISOString();
      writeRuntime();
      throw error;
    }
  };

  const restartWorker = async () => {
    if (isSystemd()) {
      restartSystemdWorker();
      return;
    }
    if (state.child !== null || (state.pid !== null && processAlive(state.pid))) {
      await stopWorker();
    }
    await startWorker();
  };

  const adoptExisting = () => {
    if (isSystemd()) return;
    const paths = pathsFor(state.config);
    try {
      if (!existsSync(paths.pidFile)) return;
      const pid = Number(readFileSync(paths.pidFile, "utf8").trim());
      if (!Number.isInteger(pid) || !processAlive(pid)) {
        rmSync(paths.pidFile, { force: true });
        return;
      }
      state.pid = pid;
      state.status = "running";
      state.adopted = true;
      state.startedAt = state.startedAt ?? new Date().toISOString();
      state.command = state.command ?? [];
      state.logPath = paths.logPath;
      state.pidFile = paths.pidFile;
      writeRuntime();
    } catch {
      // Missing/readable PID files are acceptable.
    }
  };

  const applyConfig = (next, revision) => {
    const oldConfig = state.config;
    const changed = JSON.stringify(oldConfig) !== JSON.stringify(next);
    const enabledChanged = oldConfig.enabled !== next.enabled;
    const systemdChanged = oldConfig.systemd !== next.systemd;

    if (systemdChanged && next.systemd && next.enabled) {
      // Entering systemd mode with autostart: stop any internal child first,
      // then let systemd take over the worker.
      const internalRunning =
        state.child !== null ||
        (state.pid !== null && processAlive(state.pid));
      state.config = clone(next);
      state.revision = revision;
      if (internalRunning) {
        void stopInternalWorker().then(() => startWorker());
      } else {
        void startWorker();
      }
      writeRuntime();
      return;
    }

    state.config = clone(next);
    state.revision = revision;

    if (next.systemd) {
      if (enabledChanged) {
        if (next.enabled) {
          void startWorker();
        } else {
          void stopWorker();
        }
      } else if (changed && readSystemdStatus(next)?.active === "active") {
        void restartWorker();
      }
      writeRuntime();
      return;
    }

    if (systemdChanged) {
      // Leaving systemd mode: stop, disable, and remove the generated unit.
      removeSystemdUnit(oldConfig);
      state.status = "stopped";
      state.pid = null;
      state.restarts = 0;
      state.failed = false;
      state.startTimes = [];
      removePidFile();
    }

    const wasRunning =
      state.child !== null ||
      (state.pid !== null && processAlive(state.pid));
    if (enabledChanged && !next.enabled) {
      void stopWorker();
    } else if ((enabledChanged || systemdChanged) && next.enabled && !wasRunning) {
      void startWorker();
    } else if (changed && wasRunning) {
      void restartWorker();
    }
    writeRuntime();
  };

  const getSnapshot = () => {
    const paths = pathsFor(state.config);
    let revision = state.revision;
    let config = clone(state.config);
    let writable = false;
    let systemdStatus = null;
    if (!isWorker && isSystemd()) {
      systemdStatus = readSystemdStatus(state.config);
      applySystemdState(systemdStatus);
    }
    if (settings !== undefined) {
      const descriptor = settings
        .describe({ redactSecrets: true })
        .find((entry) => entry.ns === NS);
      if (descriptor !== undefined) {
        revision = descriptor.revision;
        config = clone(descriptor.value);
        writable = settings.writable;
      }
    }
    return {
      config,
      revision,
      writable,
      nested: isWorker,
      supervisor: isSystemd() ? "systemd" : "child",
      systemd: isSystemd()
        ? {
            unit: systemdUnitName(state.config),
            scope: state.config.systemdScope,
            active: systemdStatus?.active ?? null,
            enabled: systemdStatus?.enabled ?? null,
          }
        : null,
      worker: {
        status: state.pid !== null && processAlive(state.pid) && state.child === null && state.adopted ? "running" : state.status,
        pid: state.pid,
        adopted: state.adopted,
        exitCode: state.exitCode,
        signal: state.signal,
        startedAt: state.startedAt,
        stoppedAt: state.stoppedAt,
        restarts: state.restarts,
        lastRestartAt: state.lastRestartAt,
        command: state.command,
        logPath: state.logPath || paths.logPath,
        pidFile: state.pidFile || paths.pidFile,
      },
      dsh: {
        node: process.version,
        entry: process.argv[1] ?? null,
      },
    };
  };

  const rememberRevision = () => {
    if (settings === undefined) return;
    const descriptor = settings
      .describe({ redactSecrets: true })
      .find((entry) => entry.ns === NS);
    state.revision = descriptor?.revision ?? state.revision;
  };

  if (settings !== undefined) {
    const scope = settings.register(NS, Config, {
      base: clone(config),
      applies: "live",
    });
    state.config = clone(scope.get());
    rememberRevision();
    ctx.effect(() => scope.watch((next) => applyConfig(clone(next), state.revision)));
    ctx.effect(() => () => clearSchedule());
  } else {
    state.config = clone(config);
  }

  const resetFailure = () => {
    state.startTimes = [];
    state.failed = false;
    if (isSystemd()) {
      try {
        if (readSystemdStatus(state.config) !== null) {
          runSystemctl(state.config, ["reset-failed", systemdUnitName(state.config)]);
        }
      } catch (error) {
        ctx.logger?.warn("web-daemon: systemd reset-failed error: %s", error);
      }
    }
    if (state.status === "failed") state.status = "stopped";
    writeRuntime();
  };

  if (!isWorker) adoptExisting();
  if (!isWorker && state.config.enabled && !state.adopted) {
    state.schedule = setTimeout(() => void startWorker(), 0);
  }

  ctx.effect(
    () => () => {
      clearSchedule();
      // In systemd mode the unit keeps running independent of the GUI.
      if (!state.config.systemd) void stopWorker();
    },
    "web-daemon: worker lifecycle",
  );

  return {
    getSnapshot,
    startWorker,
    stopWorker,
    restartWorker,
    applyConfig,
    rememberRevision,
    resetFailure,
  };
}

function apply(ctx, config = {}) {
  const webServer = ctx.get("webServer");
  if (webServer === undefined) return;

  const settings = ctx.get("settings");
  const manager = createWebDaemonManager(
    ctx,
    webServer,
    settings,
    config,
  );

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
      if (snapshot.nested) {
        sendJson(res, 403, {
          ok: false,
          error: "daemon control is disabled inside a managed worker process",
        });
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

      if (action === "start") {
        if (settings !== undefined && settings.writable && !snapshot.config.enabled) {
          await settings.update(NS, { enabled: true }, snapshot.revision);
          manager.rememberRevision();
        }
        try {
          await manager.startWorker(true);
          sendJson(res, 200, { ok: true, ...manager.getSnapshot() });
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }

      if (action === "stop") {
        if (settings !== undefined && settings.writable && snapshot.config.enabled) {
          await settings.update(NS, { enabled: false }, snapshot.revision);
          manager.rememberRevision();
        }
        await manager.stopWorker();
        sendJson(res, 200, { ok: true, ...manager.getSnapshot() });
        return;
      }

      if (action === "restart") {
        await manager.restartWorker();
        sendJson(res, 200, { ok: true, ...manager.getSnapshot() });
        return;
      }

      if (action === "reset") {
        manager.resetFailure();
        sendJson(res, 200, { ok: true, ...manager.getSnapshot() });
        return;
      }

      sendJson(res, 404, { ok: false, error: `unknown action: ${action}` });
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

