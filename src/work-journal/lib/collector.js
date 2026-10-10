/**
 * Incremental collector over the durable Session store.
 *
 * The journal's source of truth is the harness's own session logs: every turn,
 * tool call, and prompt is already durably recorded there, so the journal adds
 * no instrumentation to the agent loop and can never disagree with what
 * actually happened. The cost is that a log must be read to be counted, and
 * the session store is too large to re-read per query.
 *
 * The collector therefore keeps a derived index keyed by the store's own
 * opaque revision token. `sessionPersistence.list()` hands back a revision per
 * session that is comparable within one process, so an unchanged revision means
 * an unchanged log and the session is skipped without being opened. A scan
 * reads only what changed, which after the first pass is the handful of
 * sessions the user is actually working in.
 *
 * Two properties matter more than throughput:
 *
 * - **A scan never blocks the plugin.** It runs in bounded slices
 *   (`maxSessionsPerScan`) and yields between sessions, so a tool call answers
 *   from whatever is indexed and asks for another pass rather than hanging for
 *   minutes on a cold store.
 * - **One unreadable session never fails a scan.** A log this build cannot
 *   interpret is recorded as an error entry and skipped; the rest of the store
 *   still indexes.
 */

import { projectSession } from './extract.js'

/** Index document layout; bump when the stored shape changes. */
export const INDEX_VERSION = 2

/** Sessions read concurrently. Matches the query service's own persisted-read default. */
const READ_CONCURRENCY = 4

/** Create an empty index document for one timezone. */
export function emptyIndex(tzOffsetMinutes) {
  return {
    version: INDEX_VERSION,
    tzOffsetMinutes,
    updatedAt: 0,
    scans: 0,
    activities: {},
    revisions: {},
    errors: {},
    stats: { sessions: 0, indexed: 0, skipped: 0, failed: 0, remaining: 0, lastScanAt: 0, lastScanMs: 0, complete: false },
  }
}

/**
 * Adopt a stored index document, discarding anything this build cannot use.
 *
 * A version mismatch or a corrupt document is not repaired in place: the index
 * is derived data that a scan can rebuild, so the safe move is to start over
 * rather than to guess at a shape that changed.
 * @param value - parsed index JSON, or undefined when no index exists yet.
 * @param tzOffsetMinutes - the timezone the index should be bucketed in.
 * @returns a usable index document.
 */
export function adoptIndex(value, tzOffsetMinutes) {
  if (value === null || typeof value !== 'object') return emptyIndex(tzOffsetMinutes)
  if (value.version !== INDEX_VERSION) return emptyIndex(tzOffsetMinutes)
  // Day buckets are stored as absolute dates, so an offset change would leave
  // stale buckets behind. Rebuild instead of mixing two bucketings.
  if (value.tzOffsetMinutes !== tzOffsetMinutes) return emptyIndex(tzOffsetMinutes)
  if (value.activities === null || typeof value.activities !== 'object') return emptyIndex(tzOffsetMinutes)
  if (value.revisions === null || typeof value.revisions !== 'object') return emptyIndex(tzOffsetMinutes)
  return {
    version: INDEX_VERSION,
    tzOffsetMinutes,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
    scans: Number.isFinite(value.scans) ? value.scans : 0,
    activities: value.activities,
    revisions: value.revisions,
    errors: value.errors !== null && typeof value.errors === 'object' ? value.errors : {},
    stats: value.stats !== null && typeof value.stats === 'object'
      ? { sessions: 0, indexed: 0, skipped: 0, failed: 0, remaining: 0, lastScanAt: 0, lastScanMs: 0, complete: false, ...value.stats }
      : { sessions: 0, indexed: 0, skipped: 0, failed: 0, remaining: 0, lastScanAt: 0, lastScanMs: 0, complete: false },
  }
}

/**
 * Run one bounded scan pass over the store.
 *
 * @param index - the index to update in place.
 * @param deps - `list()` returning persistence snapshots, `read(id)` returning
 *   `{ session, events }`, an optional `isVolatile(id)` predicate, and optional
 *   `now`/`tzOffsetMinutes`/`signal`.
 * @returns counters for this pass.
 */
export async function scanOnce(index, deps) {
  const started = deps.now?.() ?? Date.now()
  const maxSessions = Number.isSafeInteger(deps.maxSessions) && deps.maxSessions > 0 ? deps.maxSessions : Infinity
  const signal = deps.signal
  const isVolatile = typeof deps.isVolatile === 'function' ? deps.isVolatile : () => false
  const result = { scanned: 0, indexed: 0, skipped: 0, failed: 0, volatile: 0, remaining: 0, complete: true }

  let snapshots
  try {
    snapshots = await deps.list(signal)
  } catch (error) {
    // Deliberately does NOT advance `lastScanAt`: a store that could not be
    // listed must not look like a store that was listed and found empty, or the
    // next query would answer "no activity" from an index that was never read.
    index.errors.__list = messageOf(error)
    index.stats.complete = false
    throw error
  }

  const known = new Set()
  const pending = []
  for (const snapshot of snapshots) {
    const id = String(snapshot.header.id)
    known.add(id)
    result.scanned += 1
    // A live session is re-projected on every pass regardless of its revision.
    // Before its first durable flush the backend reports a constant in-memory
    // revision for it, so a revision-only guard would keep skipping the session
    // the user is working in right now — exactly the one "what did I do today"
    // is about.
    const volatile = isVolatile(id)
    if (volatile) result.volatile += 1
    if (!volatile && index.revisions[id] === snapshot.revision) {
      result.skipped += 1
      continue
    }
    pending.push(snapshot)
  }

  // A session the store no longer lists (deleted, or another profile's) must
  // not keep contributing to reports forever.
  for (const id of Object.keys(index.revisions)) {
    if (known.has(id)) continue
    delete index.revisions[id]
    delete index.activities[id]
    delete index.errors[id]
  }

  const budget = pending.slice(0, maxSessions === Infinity ? pending.length : maxSessions)
  result.remaining = pending.length - budget.length
  if (result.remaining > 0) result.complete = false

  let cursor = 0
  const worker = async () => {
    while (cursor < budget.length) {
      if (signal?.aborted === true) throw signal.reason ?? new Error('scan aborted')
      const snapshot = budget[cursor]
      cursor += 1
      const id = String(snapshot.header.id)
      try {
        const loaded = await deps.read(id, signal)
        const activity = projectSession(loaded.session ?? snapshot.header, loaded.events ?? [], {
          tzOffsetMinutes: index.tzOffsetMinutes,
          inheritedEventCount: loaded.inheritedEventCount,
        })
        // A volatile session's revision is recorded but not relied on, so the
        // next pass re-projects it anyway.
        index.revisions[id] = snapshot.revision
        delete index.errors[id]
        if (activity === undefined) delete index.activities[id]
        else {
          index.activities[id] = activity
          result.indexed += 1
        }
      } catch (error) {
        // Record the failure but keep the previous revision unset, so a later
        // scan retries this session rather than freezing the error forever.
        index.errors[id] = messageOf(error)
        result.failed += 1
      }
    }
  }

  const workers = []
  for (let i = 0; i < Math.min(READ_CONCURRENCY, budget.length); i += 1) workers.push(worker())
  await Promise.all(workers)

  index.scans += 1
  index.updatedAt = deps.now?.() ?? Date.now()
  index.stats.sessions = known.size
  index.stats.indexed = Object.keys(index.activities).length
  index.stats.skipped = result.skipped
  index.stats.failed = result.failed
  index.stats.remaining = result.remaining
  index.stats.lastScanAt = started
  index.stats.lastScanMs = index.updatedAt - started
  index.stats.complete = result.complete
  return result
}

/** Extract a printable message from an unknown thrown value. */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
