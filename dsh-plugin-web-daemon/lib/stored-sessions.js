/**
 * RC1 adapter for `sessionPersistence`.
 *
 * The durable service addresses stored sessions through snapshots and
 * per-session read handles: `list()` resolves one snapshot per visible stored
 * session, `stat(id)` resolves a single snapshot, and `open(id, 'read')` yields
 * the stored events through `handle.read()`. Recovery was originally written
 * against the older vocabulary, where `list()` returned bare headers and
 * `inspect(id)` returned `{ meta, events }`.
 *
 * Reading a snapshot as if it were a header fails silently rather than loudly:
 * `String(snapshot.id)` is `"undefined"` for every session, so the lookup misses
 * every record and the session is pruned as "removed-not-persisted". That is
 * exactly what stopped every restart from resuming its sessions, so the shapes
 * are normalized here, in one place, instead of at each call site.
 *
 * A snapshot is `{ header, revision, sizeBytes }`; a bare header is the header
 * record itself (its `type` is "session"). Both are accepted.
 */

/** Normalize a snapshot or a bare header into its header record. */
function headerOf(entry) {
  if (entry === null || typeof entry !== "object") return undefined;
  const header = entry.header ?? entry;
  if (header === null || typeof header !== "object" || Array.isArray(header)) return undefined;
  return header.id === undefined ? undefined : header;
}

/**
 * Index `sessionPersistence.list()` by session id.
 * @param listed - the service's snapshot list, or an object carrying `sessions`.
 * @returns a Map from session id to that session's header record.
 */
function persistedHeadersFromList(listed) {
  const headers = new Map();
  const entries = Array.isArray(listed) ? listed : listed?.sessions;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const header = headerOf(entry);
    if (header !== undefined) headers.set(String(header.id), header);
  }
  return headers;
}

/**
 * Read one stored session the way recovery wants it: `{ meta, events }`.
 *
 * `meta` is the stored header (carrying `origin`, `cwd`, `agentPreset`) and
 * `events` is the stored event log, whose records carry `type`, `seq` and
 * `data` — the shape every caller here already reads.
 *
 * @param persistence - the `sessionPersistence` service.
 * @param sessionId - session to resolve.
 * @returns the resolved session, or `undefined` when it is not persisted.
 */
async function readStoredSession(persistence, sessionId) {
  if (persistence === null || persistence === undefined) return undefined;
  const snapshot = typeof persistence.stat === "function"
    ? await persistence.stat(sessionId)
    : undefined;
  const header = headerOf(snapshot);
  if (header === undefined) return undefined;
  if (typeof persistence.open !== "function") return { meta: header, events: [] };
  const handle = await persistence.open(sessionId, "read");
  try {
    const read = typeof handle?.read === "function" ? await handle.read() : undefined;
    return { meta: header, events: Array.isArray(read?.events) ? read.events : [] };
  } finally {
    // Idempotent and uncancellable: it only frees this reader's resources.
    await handle?.close?.();
  }
}

export { headerOf, persistedHeadersFromList, readStoredSession };
