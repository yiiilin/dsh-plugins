import { rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";

export const name = "delete-session";
export const inject = ["webServer", "sessions", "agents", "sessionPersistence"];

const API_PATH = "/_dsh/delete-session/delete";
/** Every committed Session format generation, optionally zstd-compressed. */
const JSONL_FILE = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/;
const SUBAGENT_ORIGIN = "subagent";
const MAX_BATCH_SIZE = 100;

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

function isSessionIdList(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_BATCH_SIZE
    && new Set(value).size === value.length
    && value.every(isSessionId);
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
 * `sessionPersistence.list()` returns persistence snapshots
 * (`{ header, revision, sizeBytes? }`); tolerate a bare header as well so the
 * lookup does not depend on which shape the mounted backend hands back.
 */
function entryHeader(entry) {
  const header = entry?.header;
  return header !== null && header !== undefined && typeof header === "object" ? header : entry;
}

/**
 * Index one listing pass by session id and by the parent recorded on each
 * subagent child, so a whole descendant subtree is walked from memory instead
 * of re-reading persistence once per level.
 */
function buildCatalog(entries) {
  const byId = new Map();
  const childIdsByParent = new Map();
  for (const entry of entries) {
    const header = entryHeader(entry);
    const id = header?.id;
    if (!isSessionId(id) || byId.has(id)) continue;
    byId.set(id, header);
    if (header.origin !== SUBAGENT_ORIGIN) continue;
    const parentSession = header.parentSession;
    if (!isSessionId(parentSession)) continue;
    const siblings = childIdsByParent.get(parentSession);
    if (siblings === undefined) childIdsByParent.set(parentSession, [id]);
    else siblings.push(id);
  }
  return { byId, childIdsByParent };
}

/**
 * Ids of every subagent session below `sessionId`, deepest level first, so a
 * parent is torn down only after the children that name it in their headers.
 *
 * Only sessions whose header records `origin: "subagent"` are followed: a
 * `parentSession` that merely marks fork lineage belongs to a session the user
 * can still open, and must not be swept up by deleting its source.
 */
function descendantSubagentIds(catalog, sessionId) {
  const seen = new Set([sessionId]);
  const levels = [];
  let frontier = [sessionId];
  while (frontier.length > 0) {
    const next = [];
    for (const id of frontier) {
      for (const child of catalog.childIdsByParent.get(id) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        next.push(child);
      }
    }
    if (next.length === 0) break;
    levels.push(next);
    frontier = next;
  }
  return levels.reverse().flat();
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

  /**
   * Flush and dispose one live agent/session so no writer survives the removal
   * of its artifact. A live session whose teardown handle was never observed is
   * refused rather than having only its file removed.
   */
  const disposeLiveSession = async (sessionId) => {
    const liveSession = ctx.sessions.get(sessionId);
    const liveAgent = ctx.agents.get(sessionId);
    if (liveAgent === undefined && liveSession === undefined) return;

    if (liveAgent === undefined) {
      throw requestError(409, `the session ${sessionId} is live but has no disposable agent handle`);
    }
    const handle = handles.get(sessionId);
    if (handle === undefined) {
      throw requestError(409, `this active session ${sessionId} was opened before the delete plugin was mounted; restart dsh web before deleting it`);
    }

    // Flush before disposal so the JSONL writer has no buffered tail when
    // the artifact is removed below.
    await ctx.sessions.flush(liveSession ?? liveAgent.session);
    await handle.dispose();
    if (ctx.agents.get(sessionId) !== undefined || ctx.sessions.get(sessionId) !== undefined) {
      throw requestError(409, `the session ${sessionId} did not finish shutting down`);
    }
  };

  /** Remove the guarded per-session directory holding one session artifact. */
  const removeSessionArtifact = async (header) => {
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

    return { materialized, removedDirectory: directoryPresent };
  };

  /**
   * Delete one session together with the subagent sessions delegated from it,
   * at any depth. Every live target is flushed and disposed before the first
   * artifact is removed, and the requested session's own record is reported in
   * the same shape as before, with the subagent ids listed alongside it.
   */
  const deleteSessionNow = async (sessionId, catalog, removed) => {
    if (removed.has(sessionId)) return { sessionId, deleted: true, alreadyRemoved: true };

    const header = ctx.sessions.get(sessionId)?.header ?? catalog.byId.get(sessionId);
    if (header === undefined) throw requestError(404, "session not found");

    const targets = [];
    for (const id of [...descendantSubagentIds(catalog, sessionId), sessionId]) {
      if (removed.has(id)) continue;
      const targetHeader = id === sessionId ? header : catalog.byId.get(id);
      if (targetHeader === undefined) continue;
      targets.push({ id, header: targetHeader });
    }

    for (const target of targets) await disposeLiveSession(target.id);

    const results = [];
    for (const target of targets) {
      const removal = await removeSessionArtifact(target.header);
      removed.add(target.id);
      results.push({ sessionId: target.id, ...removal });
    }

    const requested = results.at(-1);
    return {
      sessionId,
      deleted: true,
      materialized: requested.materialized,
      removedDirectory: requested.removedDirectory,
      subagentSessionIds: results.slice(0, -1).map((result) => result.sessionId),
    };
  };

  const withCatalog = (operation) => {
    const queued = enqueue(mutationTail, async () => {
      const catalog = buildCatalog(await ctx.sessionPersistence.list());
      return operation(catalog);
    });
    mutationTail = queued.nextTail;
    return queued.result;
  };
  const deleteSession = (sessionId) => withCatalog(
    (catalog) => deleteSessionNow(sessionId, catalog, new Set()),
  );
  const deleteSessions = (sessionIds) => withCatalog(async (catalog) => {
    const removed = new Set();
    const results = [];
    for (const sessionId of sessionIds) results.push(await deleteSessionNow(sessionId, catalog, removed));
    return results;
  });

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
      const hasBatch = Object.hasOwn(body, "sessionIds");
      const hasSingle = Object.hasOwn(body, "sessionId");
      if (hasBatch && hasSingle) {
        sendJson(res, 400, { ok: false, error: "provide either sessionId or sessionIds, not both" });
        return;
      }
      if (hasBatch && !isSessionIdList(body.sessionIds)) {
        sendJson(res, 400, { ok: false, error: `sessionIds must be a non-empty array of up to ${MAX_BATCH_SIZE} unique session ids` });
        return;
      }
      if (!hasBatch && !isSessionId(body.sessionId)) {
        sendJson(res, 400, { ok: false, error: "sessionId is required" });
        return;
      }
      if (body.confirm !== true) {
        sendJson(res, 400, { ok: false, error: "explicit delete confirmation is required" });
        return;
      }

      try {
        if (hasBatch) {
          const results = await deleteSessions(body.sessionIds);
          sendJson(res, 200, { ok: true, results });
          return;
        }
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
