import { rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";

export const name = "delete-session";
export const inject = ["webServer", "sessions", "agents", "sessionPersistence"];

const API_PATH = "/_dsh/delete-session/delete";
const JSONL_FILE = /^session\.jsonl(?:\.zstd)?$/;

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req, limit = 65536) {
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

function requestError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isSessionId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !/[\0\r\n]/u.test(value);
}

function encodeSessionSegment(raw) {
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/u.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

function projectSegment(cwd) {
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/u.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/u, "") || "root").slice(0, 251)}--`;
}

function safeJsonlLocation(persistence, header) {
  if (typeof persistence.locate !== "function") {
    throw requestError(501, "the persistence backend does not expose session locations");
  }
  const location = persistence.locate(header);
  if (location === undefined) {
    throw requestError(501, "this persistence backend does not expose one artifact per session");
  }
  if (location.kind !== "jsonl"
    || typeof location.path !== "string"
    || !isAbsolute(location.path)
    || !JSONL_FILE.test(basename(location.path))) {
    throw requestError(501, "this plugin only supports the stock JSONL session backend");
  }

  const sessionDir = dirname(location.path);
  const projectDir = dirname(sessionDir);
  const expectedSession = encodeSessionSegment(header.id);
  const expectedProject = header.cwd === undefined ? "_no-cwd" : projectSegment(header.cwd);
  if (basename(sessionDir) !== expectedSession
    || basename(projectDir) !== expectedProject
    || sessionDir === projectDir
    || projectDir === dirname(projectDir)) {
    throw requestError(501, "the persistence location is not a guarded stock JSONL session directory");
  }
  return { path: location.path, sessionDir };
}

/**
 * Keep the public AgentHandles returned by the factory so an active session
 * can be disposed in the same ordered path as its owner.
 */
function captureAgentHandles(ctx, agents, handles) {
  const restorers = [];
  const remember = (handle) => {
    const id = handle?.agent?.id;
    if (isSessionId(id) && typeof handle.dispose === "function") handles.set(id, handle);
    return handle;
  };

  for (const method of ["create", "resume"]) {
    const original = agents[method];
    if (typeof original !== "function") continue;
    const wrapped = function (...args) {
      const result = original.apply(agents, args);
      return Promise.resolve(result).then(remember);
    };
    agents[method] = wrapped;
    restorers.push(() => {
      if (agents[method] === wrapped) agents[method] = original;
    });
  }

  const offDisposed = ctx.on("agent/disposed", (payload) => {
    const id = payload?.agent?.id;
    if (isSessionId(id)) handles.delete(id);
  });

  return () => {
    offDisposed?.();
    for (let i = restorers.length - 1; i >= 0; i -= 1) restorers[i]();
    handles.clear();
  };
}

function enqueue(tail, operation) {
  const next = tail.then(operation, operation);
  return {
    nextTail: next.then(() => {}, () => {}),
    result: next,
  };
}

export function apply(ctx) {
  const handles = new Map();
  const captureDisposer = captureAgentHandles(ctx, ctx.agents, handles);
  ctx.effect(() => captureDisposer, "delete-session: capture agent handles");

  let mutationTail = Promise.resolve();
  const deleteSession = (sessionId) => {
    const queued = enqueue(mutationTail, async () => {
      const liveSession = ctx.sessions.get(sessionId);
      const liveAgent = ctx.agents.get(sessionId);

      if (liveAgent !== undefined || liveSession !== undefined) {
        if (liveAgent === undefined) {
          throw requestError(409, "the session is live but has no disposable agent handle");
        }
        const handle = handles.get(sessionId);
        if (handle === undefined) {
          throw requestError(409, "this active session was opened before the delete plugin was mounted; restart dsh web before deleting it");
        }

        // Flush before disposal so the JSONL writer has no buffered tail when
        // the artifact is removed below.
        await ctx.sessions.flush(liveSession ?? liveAgent.session);
        await handle.dispose();
        if (ctx.agents.get(sessionId) !== undefined || ctx.sessions.get(sessionId) !== undefined) {
          throw requestError(409, "the session did not finish shutting down");
        }
      }

      const headers = await ctx.sessionPersistence.list();
      const header = liveSession?.header ?? headers.find((candidate) => candidate.id === sessionId);
      if (header === undefined) throw requestError(404, "session not found");

      const location = safeJsonlLocation(ctx.sessionPersistence, header);
      let materialized = false;
      try {
        const info = await stat(location.path);
        if (!info.isFile()) throw requestError(409, "the session artifact is not a regular file");
        materialized = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }

      let directoryPresent = false;
      try {
        const info = await stat(location.sessionDir);
        if (!info.isDirectory()) throw requestError(409, "the session artifact parent is not a directory");
        directoryPresent = true;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await rm(location.sessionDir, { recursive: true, force: true });

      return {
        sessionId,
        deleted: true,
        materialized,
        removedDirectory: directoryPresent,
      };
    });
    mutationTail = queued.nextTail;
    return queued.result;
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: API_PATH,
    handler: async (req, res) => {
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }

      let body;
      try {
        body = await readJson(req);
      } catch (error) {
        sendJson(res, 400, { ok: false, error: errorMessage(error) });
        return;
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        sendJson(res, 400, { ok: false, error: "request body must be an object" });
        return;
      }
      if (!isSessionId(body.sessionId)) {
        sendJson(res, 400, { ok: false, error: "sessionId is required" });
        return;
      }
      if (body.confirm !== true) {
        sendJson(res, 400, { ok: false, error: "explicit delete confirmation is required" });
        return;
      }

      try {
        const result = await deleteSession(body.sessionId);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 500;
        sendJson(res, status, { ok: false, error: errorMessage(error) });
      }
    },
  }), "delete-session: HTTP API");
}

apply.inject = inject;

export default apply;
