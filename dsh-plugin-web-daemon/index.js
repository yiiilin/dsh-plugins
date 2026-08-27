/**
 * dsh-plugin-web-daemon
 *
 * Host half of the Web daemon plugin. It manages the `dsh web` worker as a
 * real systemd unit: generates the unit file, maps the GUI buttons onto
 * systemctl verbs, and exposes a small editable namespace (enabled, profile,
 * port, unit name, scope) through the Host settings service.
 *
 * The unit gets DSH_WEB_DAEMON_WORKER=1 so a daemonized process running the
 * same profile does not offer recursive daemon control in its own GUI. Only
 * that managed worker owns session recovery; the foreground owner never
 * resumes the same persisted identities.
 */

import {
  mkdir as mkdirAsync,
  open as openAsync,
  readFile,
  rename as renameAsync,
  stat as statAsync,
  unlink as unlinkAsync,
  link as linkAsync,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, freemem, homedir, loadavg, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { resolveSessionPreset } from "@deepseek-ai/dsh-agent-presets";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";

export const name = "web-daemon";
export const inject = ["webServer", "settings", "clientModules", "apiProxy"];

const NS = settingsNamespace("web-daemon");
const WORKER_FLAG = "DSH_WEB_DAEMON_WORKER";
const API_PREFIX = "/_dsh/web-daemon";
const SESSION_REGISTRY_DIR = ["plugins", "dsh-plugin-web-daemon"];
const SESSION_REGISTRY_FILE = "active-sessions.json";
const SESSION_REGISTRY_LOCK_FILE = "active-sessions.lock";
const SESSION_REGISTRY_DIAG_FILE = "recovery-diagnostics.json";
const SESSION_REGISTRY_VERSION = 1;
const SESSION_REGISTRY_STALE_MS = 30000;
const RESUME_PLUGIN_SOURCE = "dsh-plugin-web-daemon";
const INTERRUPTED_RESUME_TEXT = "The daemon restarted while this session was running. Continue the task from the recovered conversation. Before repeating any operation, verify the outcome of tool calls marked as unknown.";
const RECOVERY_GATED_API_METHODS = {
  sessions: ["list", "search", "create", "history", "models", "selectModel", "rename", "prompt", "fork", "attachment", "updateQueue", "cancel"],
  goals: ["create", "edit", "pause", "resume", "complete", "clear"],
  agentPresets: ["list", "select"],
  subagents: ["list", "history", "prompt", "interrupt"],
};

function isHeadlessHost() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return false;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return false;
  try {
    if (release().toLowerCase().includes("microsoft")) return false;
  } catch {
    // Defensive only: release() is available on supported Node versions.
  }
  return true;
}

function isTrustedApiRequest(req) {
  const host = req.headers?.host;
  if (typeof host !== "string" || host === "") return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  const hostname = hostUrl.hostname;
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  if (!loopback) return false;
  if (req.headers?.["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers?.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function readRpcEnvelope(req, res) {
  const body = [];
  let size = 0;
  const limit = 262144;
  return new Promise((resolvePromise) => {
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "request body too large" }));
        resolvePromise(null);
        req.destroy();
        return;
      }
      body.push(chunk);
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(body).toString("utf8"));
      } catch {
        resolvePromise(null);
        return;
      }
      if (parsed === null || typeof parsed !== "object" || parsed.type !== "client-request" || typeof parsed.rpcId !== "string") {
        resolvePromise(null);
        return;
      }
      resolvePromise(parsed);
    });
    req.on("error", () => resolvePromise(null));
  });
}

function answerHeadlessOpen(res, envelope) {
  const message = "this server has no graphical environment, so it cannot open files natively — use the file explorer panel to preview or download the file instead";
  const body = JSON.stringify({
    type: "server-response",
    rpcId: envelope.rpcId,
    result: { ok: false, error: { code: "internal", message, details: {} } },
  });
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

const DELIVERABLES_CLIENT_PATH = "/plugins/@deepseek-ai/dsh-client-ui-deliverables/client.js";
const TOOL_CLIENT_PATH = "/plugins/@deepseek-ai/dsh-client-ui-tool/client.js";
const SIDEBAR_CLIENT_PATH = "/plugins/@deepseek-ai/dsh-client-ui-sidebar/client.js";

function patchDeliverablesClient(source) {
  let patched = source;
  patched = patched.replace(
    /function producedFileMentions\(paths, openFile, label\) \{/,
    "function producedFileMentions(paths, openFile, label, canOpenPath) {",
  );
  patched = patched.replace(
    /open: \(\) => \{\s*openFile\(path\);\s*\},/,
    "open: () => { if (canOpenPath) openFile(path); },",
  );
  patched = patched.replace(
    /onClick: \(\) => \{\s*openFile\(path\);\s*\},/,
    "onClick: () => { if (canOpenPath) openFile(path); },",
  );
  patched = patched.replace(
    /return producedFileMentions\(paths, owner\.openFile, \(path\) => t\("produced\.open", \{ name: path \}\)\);/,
    "const description = connection.hostDescription.getSnapshot();\n\t\t\t\t\tconst canOpenPath = connection.isLoopback && description?.canOpenPath === true;\n\t\t\t\t\treturn producedFileMentions(paths, owner.openFile, (path) => t(\"produced.open\", { name: path }), canOpenPath);",
  );
  return patched;
}

function patchToolClient(source) {
  let patched = source;
  patched = patched.replace(
    /function ToolRow\(\{ t, variant, toolName, icon, title, summary, summarySuffix, body, output, errorSummary, terminal, diff, read, search, web, state, filePath, onOpenFile, inspect \}\) \{/,
    "function ToolRow({ t, variant, toolName, icon, title, summary, summarySuffix, body, output, errorSummary, terminal, diff, read, search, web, state, filePath, onOpenFile, inspect }) {",
  );
  patched = patched.replace(
    /const fileLink = filePath !== void 0 && onOpenFile !== void 0 && failureLine === null;/,
    "const fileLink = filePath !== void 0 && onOpenFile !== void 0 && failureLine === null && false;",
  );
  patched = patched.replace(
    /const openFile = \(event\) => \{\s*event\.stopPropagation\(\);\s*if \(filePath !== void 0\) onOpenFile\?\.\(filePath\);\s*\};/,
    "const openFile = (event) => { event.stopPropagation(); };",
  );
  return patched;
}

function registerHeadlessToolPatch(ctx, webServer, clientModules) {
  if (!isHeadlessHost()) return;
  const clientPath = clientModules?.clientPath("@deepseek-ai/dsh-client-ui-tool");
  if (typeof clientPath !== "string") {
    ctx.logger?.warn?.("web-daemon: tool client bundle was not found; native-open tool link patch was not applied");
    return;
  }
  let body;
  try {
    body = patchToolClient(readFileSync(clientPath, "utf8"));
  } catch (error) {
    ctx.logger?.warn?.("web-daemon: could not read tool client bundle: %s", error);
    return;
  }
  ctx.effect(() => webServer.register({
    kind: "exact",
    path: TOOL_CLIENT_PATH,
    handler: (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body),
      });
      if (req.method === "HEAD") res.end();
      else res.end(body);
    },
  }), "web-daemon: headless tool client patch");
}

function registerHeadlessDeliverablesPatch(ctx, webServer, clientModules) {
  if (!isHeadlessHost()) return;
  const clientPath = clientModules?.clientPath("@deepseek-ai/dsh-client-ui-deliverables");
  if (typeof clientPath !== "string") {
    ctx.logger?.warn?.("web-daemon: deliverables client bundle was not found; native-open chip patch was not applied");
    return;
  }
  let body;
  try {
    body = patchDeliverablesClient(readFileSync(clientPath, "utf8"));
  } catch (error) {
    ctx.logger?.warn?.("web-daemon: could not read deliverables client bundle: %s", error);
    return;
  }
  ctx.effect(() => webServer.register({
    kind: "exact",
    path: DELIVERABLES_CLIENT_PATH,
    handler: (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body),
      });
      if (req.method === "HEAD") res.end();
      else res.end(body);
    },
  }), "web-daemon: headless deliverables client patch");
}

/**
 * The shipped sidebar currently has no additive seat immediately before New
 * Session. Add one to the served shell bundle so the status panel can use the
 * slot system without replacing the navigation column.
 */
function patchSidebarClient(source) {
  const declaration = /("sidebar\.footer\.action"\s*:\s*\{\s*kind:\s*"list"\s*,\s*scope:\s*"root"\s*\})/;
  if (!declaration.test(source)) return null;
  let patched = source.replace(
    declaration,
    '"sidebar.server.status": { kind: "single", scope: "root" },\n\t\t\t\t\t$1',
  );

  const newSession = /(\(0,\s*react_jsx_runtime\.jsx\)\(_deepseek_ai_dsh_client_ui_primitives\.Tooltip,\s*\{\s*label:\s*t\("session\.new\.label"\),)/;
  if (!newSession.test(patched)) return null;
  patched = patched.replace(newSession, 'renderSlot("sidebar.server.status", { wide }),\n\t\t\t\t\t$1');
  return patched;
}

function registerSidebarStatusPatch(ctx, webServer, clientModules) {
  const clientPath = clientModules?.clientPath("@deepseek-ai/dsh-client-ui-sidebar");
  if (typeof clientPath !== "string") {
    ctx.logger?.warn?.("web-daemon: sidebar client bundle was not found; server status panel was not mounted");
    return;
  }

  let body;
  try {
    body = patchSidebarClient(readFileSync(clientPath, "utf8"));
  } catch (error) {
    ctx.logger?.warn?.("web-daemon: could not read sidebar client bundle: %s", error);
    return;
  }
  if (body === null) {
    ctx.logger?.warn?.("web-daemon: sidebar client bundle shape changed; server status panel was not mounted");
    return;
  }

  ctx.effect(() => webServer.register({
    kind: "exact",
    path: SIDEBAR_CLIENT_PATH,
    handler: (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405);
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "no-store",
        "content-length": Buffer.byteLength(body),
      });
      if (req.method === "HEAD") res.end();
      else res.end(body);
    },
  }), "web-daemon: sidebar server status patch");
}

function registerHeadlessOpenGuard(ctx, webServer) {
  if (!isHeadlessHost()) return;
  for (const endpoint of ["/api/host.openPath", "/api/host.openTextFile"]) {
    ctx.effect(() => webServer.register({
      kind: "exact",
      path: endpoint,
      handler: async (req, res) => {
        if (req.method !== "POST") {
          res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ type: "server-response", rpcId: "invalid-request", result: { ok: false, error: { code: "internal", message: "method not allowed", details: {} } } }));
          return;
        }
        if (!isTrustedApiRequest(req)) {
          res.writeHead(403);
          res.end("forbidden");
          return;
        }
        const envelope = await readRpcEnvelope(req, res);
        if (envelope !== null) answerHeadlessOpen(res, envelope);
      },
    }), `web-daemon: headless open guard ${endpoint}`);
  }
  ctx.logger?.info?.("web-daemon: headless host detected — native file-open RPCs are refused with a readable message (file explorer handles preview/download)");
}

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

function sessionRegistryPath() {
  return join(dshHome(), ...SESSION_REGISTRY_DIR, SESSION_REGISTRY_FILE);
}

function isRegistryString(value, maxLength = 4096) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !/[\0\r\n]/u.test(value);
}

function isRegistrySessionId(value) {
  return isRegistryString(value, 512);
}

function registryAgentOptions(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = {};
  for (const key of ["provider", "model"]) {
    if (isRegistryString(value[key])) result[key] = value[key];
  }
  if (Number.isSafeInteger(value.maxTokens) && value.maxTokens > 0) {
    result.maxTokens = value.maxTokens;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function sessionPreset(session) {
  const preset = resolveSessionPreset({
    header: session.header,
    events: session.events ?? [],
  });
  return isRegistryString(preset) ? preset : undefined;
}

function isTopLevelAgent(agent, agents) {
  return typeof agents?.roots !== "function"
    || agents.roots().some((candidate) => candidate === agent);
}

function activeSessionRecordOf(agent, agents, includePreset = false) {
  const session = agent?.session;
  const sessionId = agent?.id;
  if (!isTopLevelAgent(agent, agents)) return undefined;
  if (!isRegistrySessionId(sessionId) || session === undefined || session === null) return undefined;
  if (session.header?.origin === "subagent" || agent.status !== "running") return undefined;

  const record = { sessionId: String(sessionId), running: true };
  if (isRegistryString(session.header?.cwd)) record.cwd = session.header.cwd;
  if (includePreset) {
    const preset = sessionPreset(session);
    if (preset !== undefined) record.agentPreset = preset;
  }
  const options = registryAgentOptions(agent.options);
  if (options !== undefined) record.agentOptions = options;
  return record;
}

function storedSessionRecordOf(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!isRegistrySessionId(value.sessionId) || value.origin === "subagent") return undefined;
  if (value.running !== undefined && typeof value.running !== "boolean") return undefined;

  const record = { sessionId: String(value.sessionId) };
  if (value.running !== undefined) record.running = value.running;
  if (isRegistryString(value.cwd)) record.cwd = value.cwd;
  if (isRegistryString(value.agentPreset)) record.agentPreset = value.agentPreset;
  const options = registryAgentOptions(value.agentOptions ?? value.options);
  if (options !== undefined) record.agentOptions = options;
  return record;
}

function loggedAgentOptions(events) {
  let options;
  for (const event of events ?? []) {
    if (event?.type !== "request/header") continue;
    const next = registryAgentOptions(event.data?.header?.config);
    if (next !== undefined) options = next;
  }
  return options;
}

async function readSessionRegistry(path) {
  try {
    const raw = await readFile(path, "utf8");
    const value = JSON.parse(raw);
    if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || value.version !== SESSION_REGISTRY_VERSION
      || !Array.isArray(value.sessions)) {
      throw new Error(`unsupported session registry format in ${path}`);
    }

    const records = new Map();
    for (const item of value.sessions) {
      const record = storedSessionRecordOf(item);
      if (record !== undefined) records.set(record.sessionId, record);
    }
    return { present: true, records };
  } catch (error) {
    if (error?.code === "ENOENT") return { present: false, records: new Map() };
    throw error;
  }
}

function turnNeedsContinuation(events) {
  for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "turn/end") continue;
    const reason = event.data?.reason;
    return reason?.kind === "interrupted"
      || (reason?.kind === "aborted" && reason.reason?.kind === "disposed");
  }
  return false;
}

function createInterruptedResumeMessage() {
  return createUserMessage({
    content: [{ type: "text", text: INTERRUPTED_RESUME_TEXT }],
    source: {
      kind: "plugin",
      plugin: RESUME_PLUGIN_SOURCE,
      form: "notice",
      summary: "Continuing an interrupted turn after daemon restart",
    },
  });
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function processIdentity(pid) {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const [stat, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/u);
    const startTicks = fields[19];
    const boot = bootId.trim();
    if (!/^\d+$/u.test(startTicks ?? "") || boot === "") return undefined;
    return { boot, startTicks };
  } catch {
    return undefined;
  }
}

async function acquireSessionRegistryLease(path) {
  const directory = dirname(path);
  const lockPath = join(directory, SESSION_REGISTRY_LOCK_FILE);
  await mkdirAsync(directory, { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
    const identity = await processIdentity(process.pid);
    const lease = {
      pid: process.pid,
      token: randomUUID(),
      startedAt: new Date().toISOString(),
      ...identity === undefined ? {} : identity,
    };
    try {
      await writeExclusiveFile(temporary, `${JSON.stringify(lease)}\n`);
      try {
        // link() is the no-replace publication primitive on POSIX: a
        // contender sees either no lock or the complete fsynced lease.
        await linkAsync(temporary, lockPath);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;

        let owner;
        try {
          owner = JSON.parse(await readFile(lockPath, "utf8"));
        } catch (readError) {
          if (readError?.code === "ENOENT") continue;
          let info;
          try {
            info = await statAsync(lockPath);
          } catch (statError) {
            if (statError?.code === "ENOENT") continue;
            return undefined;
          }
          if (Date.now() - info.mtimeMs < SESSION_REGISTRY_STALE_MS) return undefined;
          try {
            await unlinkAsync(lockPath);
          } catch (unlinkError) {
            if (unlinkError?.code !== "ENOENT") return undefined;
          }
          await syncDirectory(lockPath);
          continue;
        }

        const ownerIdentity = await processIdentity(owner?.pid);
        const identityMismatch = owner?.boot !== undefined
          && owner?.startTicks !== undefined
          && ownerIdentity !== undefined
          && (ownerIdentity.boot !== owner.boot || ownerIdentity.startTicks !== owner.startTicks);
        if (processIsAlive(owner?.pid) && !identityMismatch) return undefined;
        try {
          await unlinkAsync(lockPath);
        } catch (unlinkError) {
          if (unlinkError?.code !== "ENOENT") return undefined;
        }
        await syncDirectory(lockPath);
        continue;
      }
      await unlinkAsync(temporary);
      await syncDirectory(lockPath);
      return { path: lockPath, token: lease.token };
    } finally {
      await unlinkAsync(temporary).catch(() => {});
    }
  }
  return undefined;
}

async function releaseSessionRegistryLease(lease) {
  try {
    const owner = JSON.parse(await readFile(lease.path, "utf8"));
    if (owner?.token !== lease.token) return;
  } catch {
    return;
  }
  try {
    await unlinkAsync(lease.path);
  } catch (error) {
    if (error?.code !== "ENOENT") return;
    return;
  }
  await syncDirectory(lease.path);
}

async function syncDirectory(path) {
  let directory;
  try {
    directory = await openAsync(dirname(path), "r");
    await directory.sync();
  } catch {
    // Directory fsync is unavailable on some supported filesystems/platforms.
  } finally {
    await directory?.close().catch(() => {});
  }
}

async function writeExclusiveFile(path, content) {
  const file = await openAsync(path, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

async function writeRecoveryDiagnostics(diag) {
  const target = join(dirname(sessionRegistryPath()), SESSION_REGISTRY_DIAG_FILE);
  const temporary = `${target}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await mkdirAsync(dirname(target), { recursive: true, mode: 0o700 });
    await writeExclusiveFile(temporary, `${JSON.stringify({ ...diag, at: new Date().toISOString() }, null, 2)}\n`);
    await renameAsync(temporary, target);
  } catch {
    await unlinkAsync(temporary).catch(() => {});
  }
}

async function createSessionRecovery(ctx, agents, persistence, agentPresets, diag) {
  diag.pid = process.pid;
  diag.lock = null;
  diag.lockError = null;
  diag.entries = [];
  const path = sessionRegistryPath();
  let preserveOnShutdown = false;
  let snapshotOnShutdown = () => {};
  const markShutdown = () => {
    preserveOnShutdown = true;
    snapshotOnShutdown();
  };
  process.once("SIGTERM", markShutdown);
  process.once("SIGINT", markShutdown);
  const removeShutdownListeners = () => {
    process.off("SIGTERM", markShutdown);
    process.off("SIGINT", markShutdown);
  };

  let lease;
  try {
    lease = await acquireSessionRegistryLease(path);
  } catch (error) {
    removeShutdownListeners();
    diag.lock = false;
    diag.lockError = error instanceof Error ? error.message : String(error);
    await writeRecoveryDiagnostics(diag);
    ctx.logger?.warn?.("web-daemon: could not acquire session registry lease: %s", error);
    return;
  }
  if (lease === undefined) {
    removeShutdownListeners();
    diag.lock = false;
    diag.lockError = "another process owns the session registry";
    await writeRecoveryDiagnostics(diag);
    ctx.logger?.info?.("web-daemon: another process owns the session registry; session recovery is disabled here");
    return;
  }
  diag.lock = true;

  const records = new Map();
  const presetCache = new Map();
  let writeTail = Promise.resolve();
  let active = true;
  let recoveryPromise = Promise.resolve();

  const persist = () => {
    const sessions = [...records.values()].sort((left, right) => (
      left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0
    ));
    const content = `${JSON.stringify({
      version: SESSION_REGISTRY_VERSION,
      updatedAt: new Date().toISOString(),
      sessions,
    }, null, 2)}\n`;
    const operation = writeTail.then(async () => {
      const directory = dirname(path);
      const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
      await mkdirAsync(directory, { recursive: true, mode: 0o700 });
      try {
        const file = await openAsync(temporary, "wx", 0o600);
        try {
          await file.writeFile(content, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        await renameAsync(temporary, path);
        await syncDirectory(path);
      } finally {
        await unlinkAsync(temporary).catch(() => {});
      }
    });
    writeTail = operation.catch(() => {});
    return operation;
  };

  const persistQuietly = () => {
    void persist().catch((error) => {
      ctx.logger?.warn?.("web-daemon: session registry write failed: %s", error);
    });
  };

  const rememberPreset = (agent) => {
    const session = agent?.session;
    const sessionId = agent?.id;
    if (!isTopLevelAgent(agent, agents)
      || !isRegistrySessionId(sessionId)
      || session === undefined
      || session === null
      || session.header?.origin === "subagent") return;
    const preset = sessionPreset(session);
    if (preset === undefined) presetCache.delete(String(sessionId));
    else presetCache.set(String(sessionId), preset);
  };

  const rememberAgent = (agent, includePreset = false) => {
    if (includePreset) rememberPreset(agent);
    const record = activeSessionRecordOf(agent, agents);
    if (record === undefined) return false;
    const previous = records.get(record.sessionId);
    const cachedPreset = presetCache.get(record.sessionId);
    if (cachedPreset !== undefined) record.agentPreset = cachedPreset;
    else if (previous?.agentPreset !== undefined) record.agentPreset = previous.agentPreset;
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(record)) return false;
    records.set(record.sessionId, record);
    return true;
  };

  const snapshotRunningAgents = () => {
    const roots = typeof agents.roots === "function" ? agents.roots() : agents.list();
    const runningIds = new Set();
    for (const agent of roots) {
      if (agent?.status !== "running") continue;
      rememberPreset(agent);
      const record = activeSessionRecordOf(agent, agents);
      if (record === undefined) continue;
      runningIds.add(record.sessionId);
      rememberAgent(agent);
    }
    for (const sessionId of [...records.keys()]) {
      if (!runningIds.has(sessionId)) records.delete(sessionId);
    }
    persistQuietly();
  };
  snapshotOnShutdown = snapshotRunningAgents;

  ctx.on("agent/created", (payload) => {
    if (!active || preserveOnShutdown) return;
    rememberPreset(payload?.agent);
  }, { global: true });
  ctx.on("agent/status", (payload) => {
    if (!active || preserveOnShutdown) return;
    const agent = payload?.agent;
    const sessionId = agent?.id;
    if (payload?.status !== "running") {
      if (!isRegistrySessionId(sessionId) || !records.delete(String(sessionId))) return;
      persistQuietly();
      return;
    }
    if (!rememberAgent(agent)) return;
    persistQuietly();
  }, { global: true });
  ctx.on("agent/disposed", (payload) => {
    if (!active || preserveOnShutdown) return;
    const sessionId = payload?.agent?.id;
    if (isRegistrySessionId(sessionId)) presetCache.delete(String(sessionId));
    if (!isRegistrySessionId(sessionId) || !records.delete(String(sessionId))) return;
    persistQuietly();
  }, { global: true });
  ctx.on("session/event", (session, event) => {
    if (!active || event?.type !== "agent-preset/selected") return;
    const sessionId = session?.id;
    const agent = agents.get(sessionId);
    if (!isTopLevelAgent(agent, agents) || !isRegistryString(event.data?.agentPreset)) return;
    presetCache.set(String(sessionId), event.data.agentPreset);
    const record = records.get(String(sessionId));
    if (record === undefined) return;
    record.agentPreset = event.data.agentPreset;
    persistQuietly();
  }, { global: true });

  ctx.effect(() => async () => {
    active = false;
    removeShutdownListeners();
    await recoveryPromise;
    await writeTail;
    await releaseSessionRegistryLease(lease);
  }, "web-daemon: session registry flush");

  const recover = async () => {
    try {
      const loaded = await readSessionRegistry(path);
      for (const record of loaded.records.values()) {
        if (!records.has(record.sessionId)) records.set(record.sessionId, record);
      }

      let dirty = false;
      const roots = typeof agents.roots === "function" ? agents.roots() : agents.list();
      for (const agent of roots) {
        rememberPreset(agent);
        if (rememberAgent(agent)) dirty = true;
      }

      const headers = await persistence.list();
      const persisted = new Map(headers.map((header) => [String(header.id), header]));
      const restore = async ([sessionId, record]) => {
        try {
          const header = persisted.get(sessionId);
          if (header === undefined || header.origin === "subagent") {
            diag.entries.push({ sessionId, decision: "removed-not-persisted" });
            records.delete(sessionId);
            dirty = true;
            return;
          }
          const legacy = record.running === undefined;
          if (!legacy && record.running !== true) {
            diag.entries.push({ sessionId, decision: "skipped-not-running" });
            records.delete(sessionId);
            dirty = true;
            return;
          }
          if (!active || agents.get(sessionId) !== undefined) {
            diag.entries.push({ sessionId, decision: "skipped-already-live" });
            return;
          }

          let inspected;
          if (legacy || record.agentPreset === undefined || record.agentOptions === undefined) {
            inspected = await persistence.inspect(sessionId);
            if (inspected.meta.origin === "subagent") {
              diag.entries.push({ sessionId, decision: "removed-subagent" });
              records.delete(sessionId);
              dirty = true;
              return;
            }
            if (inspected.meta.cwd !== undefined && record.cwd !== inspected.meta.cwd) {
              record.cwd = inspected.meta.cwd;
              dirty = true;
            }
            const preset = resolveSessionPreset({
              header: inspected.meta,
              events: inspected.events,
            });
            if (preset === undefined) {
              if (record.agentPreset !== undefined) {
                delete record.agentPreset;
                dirty = true;
              }
              presetCache.delete(sessionId);
            } else {
              if (record.agentPreset !== preset) {
                record.agentPreset = preset;
                dirty = true;
              }
              presetCache.set(sessionId, preset);
            }
            const loggedOptions = loggedAgentOptions(inspected.events);
            if (loggedOptions !== undefined && JSON.stringify(record.agentOptions) !== JSON.stringify(loggedOptions)) {
              record.agentOptions = loggedOptions;
              dirty = true;
            }
          } else {
            if (record.cwd === undefined && isRegistryString(header.cwd)) {
              record.cwd = header.cwd;
              dirty = true;
            }
            if (record.agentPreset === undefined && isRegistryString(header.agentPreset)) {
              record.agentPreset = header.agentPreset;
              presetCache.set(sessionId, header.agentPreset);
              dirty = true;
            }
          }

          const shouldResume = record.running === true
            || (legacy && turnNeedsContinuation(inspected?.events));
          if (!shouldResume) {
            diag.entries.push({ sessionId, decision: "removed-no-continuation" });
            records.delete(sessionId);
            dirty = true;
            return;
          }
          if (legacy) {
            record.running = true;
            dirty = true;
          }
          if (!active || agents.get(sessionId) !== undefined) {
            diag.entries.push({ sessionId, decision: "skipped-already-live" });
            return;
          }
          if (record.agentPreset !== undefined
            && (agentPresets === undefined || typeof agentPresets.mount !== "function")) {
            throw new Error("agent preset service is unavailable");
          }
          const setup = record.agentPreset === undefined || agentPresets === undefined
            ? undefined
            : async (agentCtx) => {
              await agentPresets.mount(agentCtx, record.agentPreset);
            };
          const options = record.agentOptions === undefined ? {} : { ...record.agentOptions };
          const handle = await agents.resume({
            resumeSessionId: sessionId,
            agentOptions: options,
            setup,
          });
          let continued = false;
          if (shouldResume && active) {
            if (typeof handle?.agent?.followup !== "function") {
              ctx.logger?.warn?.("web-daemon: resumed session %s has no followup method; recorded running session remains idle", sessionId);
            } else {
              handle.agent.followup(createInterruptedResumeMessage());
              continued = true;
              ctx.logger?.info?.("web-daemon: continuing recorded session %s after daemon restart", sessionId);
            }
          }
          diag.entries.push({ sessionId, decision: "resumed", continued });
          ctx.logger?.info?.("web-daemon: resumed session %s", sessionId);
        } catch (error) {
          diag.entries.push({
            sessionId,
            decision: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
          ctx.logger?.warn?.("web-daemon: could not resume session %s: %s", sessionId, error);
        }
      };

      await Promise.all([...records.entries()].map(restore));
      if (active && (dirty || !loaded.present)) await persist();
      ctx.logger?.info?.("web-daemon: session registry ready (%d session(s)): %s", records.size, path);
    } finally {
      await writeRecoveryDiagnostics(diag);
    }
  };

  recoveryPromise = recover().catch((error) => {
    ctx.logger?.warn?.("web-daemon: session recovery failed: %s", error);
  });
  return recoveryPromise;
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

function roundedMetric(value, digits = 1) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function cpuTotals() {
  const records = cpus();
  let idle = 0;
  let total = 0;
  for (const record of records) {
    idle += Number(record.times?.idle) || 0;
    total += Object.values(record.times ?? {}).reduce((sum, value) => sum + (Number(value) || 0), 0);
  }
  return { idle, total, cores: records.length };
}

function networkTotals(body) {
  let rxBytes = 0;
  let txBytes = 0;
  let interfaces = 0;
  for (const line of body.split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim();
    if (name === "" || name === "lo") continue;
    const fields = line.slice(separator + 1).trim().split(/\s+/);
    if (fields.length < 9) continue;
    const rx = Number(fields[0]);
    const tx = Number(fields[8]);
    if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue;
    rxBytes += rx;
    txBytes += tx;
    interfaces += 1;
  }
  return { rxBytes, txBytes, interfaces };
}

/**
 * Server-wide metrics sampled on demand by the sidebar. CPU and network are
 * deltas between requests, while memory is an instantaneous OS snapshot.
 */
function createServerMetrics() {
  let previousCpu = null;
  let previousNetwork = null;
  let inFlight = null;

  const sample = async () => {
    const observedAt = Date.now();
    const currentCpu = cpuTotals();
    let cpuPercent = null;
    if (previousCpu !== null) {
      const totalDelta = currentCpu.total - previousCpu.total;
      const idleDelta = currentCpu.idle - previousCpu.idle;
      if (totalDelta > 0) cpuPercent = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
    }
    previousCpu = currentCpu;

    const totalMemory = totalmem();
    const freeMemory = freemem();
    const usedMemory = Math.max(0, totalMemory - freeMemory);

    let currentNetwork = null;
    try {
      currentNetwork = networkTotals(await readFile("/proc/net/dev", "utf8"));
    } catch {
      // /proc/net/dev is Linux-specific; report network rates as unavailable elsewhere.
    }

    let rxBytesPerSecond = null;
    let txBytesPerSecond = null;
    if (currentNetwork !== null && previousNetwork !== null) {
      const elapsed = (observedAt - previousNetwork.observedAt) / 1000;
      if (elapsed > 0) {
        rxBytesPerSecond = Math.max(0, currentNetwork.rxBytes - previousNetwork.rxBytes) / elapsed;
        txBytesPerSecond = Math.max(0, currentNetwork.txBytes - previousNetwork.txBytes) / elapsed;
      }
    }
    previousNetwork = currentNetwork === null ? null : { ...currentNetwork, observedAt };

    return {
      ok: true,
      observedAt: new Date(observedAt).toISOString(),
      cpu: {
        percent: roundedMetric(cpuPercent),
        cores: currentCpu.cores,
        load1: roundedMetric(loadavg()[0], 2),
      },
      memory: {
        percent: roundedMetric(totalMemory > 0 ? (usedMemory / totalMemory) * 100 : null),
        usedBytes: usedMemory,
        freeBytes: freeMemory,
        totalBytes: totalMemory,
      },
      network: {
        available: currentNetwork !== null,
        interfaces: currentNetwork?.interfaces ?? 0,
        rxBytesPerSecond: roundedMetric(rxBytesPerSecond),
        txBytesPerSecond: roundedMetric(txBytesPerSecond),
        rxBytes: currentNetwork?.rxBytes ?? null,
        txBytes: currentNetwork?.txBytes ?? null,
      },
    };
  };

  return () => {
    if (inFlight !== null) return inFlight;
    const pending = sample();
    inFlight = pending;
    pending.then(
      () => {
        if (inFlight === pending) inFlight = null;
      },
      () => {
        if (inFlight === pending) inFlight = null;
      },
    );
    return pending;
  };
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
 * Render one always-restart unit. Logs go to the journal; restart pacing
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
    "Restart=always",
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
  // update). systemd stops this very process as part of the job — so this
  // must be an explicit `systemctl restart` job rather than a self-exit,
  // which would race with the unit's own restart handling and gives no
  // control over the stop sequence. The HTTP response is never delivered;
  // the browser reconnects to the new process.
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

function installRecoveryApiGate(ctx, apiProxy, recoveryReady, diag) {
  const restorers = [];
  for (const [domainName, methodNames] of Object.entries(RECOVERY_GATED_API_METHODS)) {
    const domain = apiProxy?.[domainName];
    if (domain === undefined || domain === null) continue;
    for (const methodName of methodNames) {
      const original = domain[methodName];
      if (typeof original !== "function") continue;
      const gated = function (...args) {
        diag.gatedCalls.push(`${domainName}.${methodName}`);
        return Promise.resolve(recoveryReady).then(() => original.apply(domain, args));
      };
      try {
        domain[methodName] = gated;
      } catch {
        ctx.logger?.warn?.("web-daemon: could not gate apiProxy.%s.%s during recovery", domainName, methodName);
        continue;
      }
      restorers.push(() => {
        if (domain[methodName] === gated) domain[methodName] = original;
      });
    }
  }
  if (restorers.length === 0) return;
  ctx.effect(() => () => {
    for (let index = restorers.length - 1; index >= 0; index -= 1) restorers[index]();
  }, "web-daemon: api recovery gate");
}

async function apply(ctx, config = {}) {
  const webServer = ctx.get("webServer");
  if (webServer === undefined) return;

  const clientModules = ctx.get("clientModules");
  registerHeadlessOpenGuard(ctx, webServer);
  registerHeadlessDeliverablesPatch(ctx, webServer, clientModules);
  registerHeadlessToolPatch(ctx, webServer, clientModules);
  registerSidebarStatusPatch(ctx, webServer, clientModules);

  const settings = ctx.get("settings");
  const manager = createWebDaemonManager(ctx, settings, config);
  const agents = ctx.get("agents");
  const isWorker = process.env[WORKER_FLAG] === "1";
  const diag = { pid: process.pid, lock: null, lockError: null, entries: [], gatedCalls: [] };
  let recoveryReady;
  if (agents !== undefined && isWorker) {
    // The systemd worker is the sole owner of the shared session registry.
    // A foreground owner may share DSH_HOME, but must never resume the same
    // persisted identity in a second process.
    // Wait for the agent factory and persistence backend before recovering.
    recoveryReady = ctx.inject(["agentLoop", "sessionPersistence"], (recoveryCtx) => {
      const persistence = recoveryCtx.get("sessionPersistence");
      if (persistence === undefined) return;
      const agentPresets = recoveryCtx.get("agentPresets");
      return createSessionRecovery(recoveryCtx, agents, persistence, agentPresets, diag);
    });
    const apiProxy = ctx.get("apiProxy");
    if (apiProxy !== undefined) installRecoveryApiGate(ctx, apiProxy, recoveryReady, diag);
  }
  const getServerMetrics = createServerMetrics();

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

  ctx.effect(() => webServer.register({
    kind: "exact",
    path: `${API_PREFIX}/metrics`,
    handler: async (req, res) => {
      if (req.method !== "GET") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      try {
        sendJson(res, 200, await getServerMetrics());
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  }), "web-daemon: server metrics API");
  ctx.effect(() => webServer.register({ kind: "exact", path: `${API_PREFIX}/state`, handler: (req, res) => handle(req, res, "state") }));
  ctx.effect(() => webServer.register({ kind: "exact", path: `${API_PREFIX}/save`, handler: (req, res) => handle(req, res, "save") }));
  ctx.effect(() => webServer.register({ kind: "exact", path: `${API_PREFIX}/start`, handler: (req, res) => handle(req, res, "start") }));
  ctx.effect(() => webServer.register({ kind: "exact", path: `${API_PREFIX}/stop`, handler: (req, res) => handle(req, res, "stop") }));
  ctx.effect(() => webServer.register({ kind: "exact", path: `${API_PREFIX}/restart`, handler: (req, res) => handle(req, res, "restart") }));
  ctx.effect(() => webServer.register({ kind: "exact", path: `${API_PREFIX}/reset`, handler: (req, res) => handle(req, res, "reset") }));
  if (recoveryReady !== undefined) {
    await recoveryReady;
    await writeRecoveryDiagnostics(diag);
  }
}

export { apply };
