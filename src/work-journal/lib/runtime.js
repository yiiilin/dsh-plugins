/**
 * The work-journal runtime: index ownership, scanning, and query answering.
 *
 * This is the seam every consumer goes through — the model tool, the `/journal`
 * command, and the Web panel all call the same three operations, so a report
 * cannot differ depending on how it was asked for.
 *
 * The runtime holds exactly one index and serializes scans against it. A scan
 * is started lazily rather than on a timer: a deployment that nobody uses
 * should not pay for a periodic store walk, and the first question after a
 * restart is the natural moment to catch up. Once an index exists, queries
 * answer from it immediately and a refresh runs behind them, so asking "what
 * did I do today" never waits on a full store pass.
 */

import { aggregate, renderMarkdown } from './report.js'
import { resolveRange } from './period.js'
import { createIndexStore, defaultIndexDir } from './store.js'
import { scanOnce } from './collector.js'

/** Default index reuse window before a query triggers a refresh pass. */
const DEFAULT_REFRESH_TTL_MS = 60000
/** Sessions one scan pass may read before yielding to the next pass. */
const DEFAULT_MAX_SESSIONS_PER_SCAN = 400
/** Wall-clock budget for a blocking (cold or explicit) build before it answers partial. */
const DEFAULT_WAIT_BUDGET_MS = 120000

/** Read one session's complete stored log through a read handle. */
async function readStoredSession(persistence, id, signal) {
  const handle = await persistence.open(id, 'read', signal === undefined ? undefined : { signal })
  try {
    const result = await handle.read(0, undefined, signal === undefined ? undefined : { signal })
    return { session: handle.header, events: result.events }
  } finally {
    await handle.close()
  }
}

/**
 * Read one session that is currently live in this process.
 *
 * The durable backend buffers a live session's newest events and reports a
 * constant revision for it until its first flush, so the store is the wrong
 * source for the session the user is working in right now. `sessionQuery` is
 * live-preferred and returns the same `inheritedEventCount` the projection
 * needs to honour a fork cut; a deployment without it falls back to the store.
 */
async function readLiveSession(sessionQuery, persistence, id, signal) {
  if (sessionQuery !== undefined) {
    try {
      const snapshot = await sessionQuery.readSession(id)
      return { session: snapshot.session, events: snapshot.events, inheritedEventCount: snapshot.inheritedEventCount }
    } catch (error) {
      // A live session whose surface cannot be validated still has a durable
      // log; fall through rather than dropping it from the report.
      if (persistence === undefined) throw error
    }
  }
  if (persistence === undefined) throw new Error('no session source available')
  return readStoredSession(persistence, id, signal)
}

/**
 * Install the runtime on one plugin context.
 * @param ctx - the plugin context, carrying `sessionPersistence`.
 * @param config - resolved plugin config.
 * @returns the runtime handle used by the tool, command, and route.
 */
export async function installWorkJournal(ctx, config) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) throw new Error('work-journal requires the sessionPersistence service')

  const tzOffsetMinutes = Number.isFinite(config.tzOffsetMinutes)
    ? config.tzOffsetMinutes
    : -new Date().getTimezoneOffset()
  const store = createIndexStore(config.indexDir || defaultIndexDir(ctx.get('profileContext'), tzOffsetMinutes), {
    onWarning: (message) => ctx.logger?.warn?.(message),
  })
  // Both are optional: the journal is useful with persistence alone, and richer
  // when the session store and query service are mounted beside it.
  const sessionQuery = ctx.get('sessionQuery')
  const sessions = ctx.get('sessions')
  const refreshTtlMs = Number.isFinite(config.refreshTtlMs) ? config.refreshTtlMs : DEFAULT_REFRESH_TTL_MS
  const maxSessionsPerScan = Number.isSafeInteger(config.maxSessionsPerScan) && config.maxSessionsPerScan > 0
    ? config.maxSessionsPerScan
    : DEFAULT_MAX_SESSIONS_PER_SCAN

  let index = await store.load(tzOffsetMinutes)
  let scanning
  let dirty = false

  /** Ids of sessions live in this process, which must be re-read every pass. */
  const liveIds = () => {
    if (sessions === undefined || typeof sessions.list !== 'function') return new Set()
    try {
      return new Set(sessions.list().map((session) => String(session.id)))
    } catch {
      return new Set()
    }
  }

  /**
   * Run one scan pass, joining an in-flight one instead of starting a second.
   * @param options - `signal` and an optional pass budget override.
   * @returns the pass counters.
   */
  const scan = (options = {}) => {
    if (scanning !== undefined) return scanning
    scanning = (async () => {
      try {
        const live = liveIds()
        const result = await scanOnce(index, {
          list: (signal) => persistence.list(signal === undefined ? undefined : { signal }),
          read: (id, signal) => (live.has(id)
            ? readLiveSession(sessionQuery, persistence, id, signal)
            : readStoredSession(persistence, id, signal)),
          isVolatile: (id) => live.has(id),
          tzOffsetMinutes,
          maxSessions: options.maxSessions ?? maxSessionsPerScan,
          signal: options.signal,
        })
        await store.save(index)
        dirty = false
        return result
      } finally {
        scanning = undefined
      }
    })()
    return scanning
  }

  /**
   * Make the index usable for a query without making the query wait for a
   * cold store.
   *
   * A never-scanned index is built to completion, because answering from a
   * partially indexed store would be wrong rather than merely stale: with a
   * `maxSessionsPerScan` pass budget, a single pass over a large store returns
   * a report silently missing every session the budget cut off. The loop is
   * still bounded by wall clock, so a store far larger than the budget yields a
   * partial — but *reported* — answer instead of hanging.
   *
   * An existing index is answered immediately and refreshed in the background,
   * unless the caller explicitly asked to wait.
   * @param options - `wait` forces the caller to await the refresh.
   */
  const ensureFresh = async (options = {}) => {
    const never = index.stats.lastScanAt === 0
    if (options.wait === true || never) {
      const budgetMs = Number.isFinite(options.budgetMs) ? options.budgetMs : DEFAULT_WAIT_BUDGET_MS
      const deadline = Date.now() + budgetMs
      let pass = await scan(options)
      while (pass.remaining > 0 && Date.now() < deadline) pass = await scan(options)
      return
    }
    const stale = Date.now() - index.stats.lastScanAt > refreshTtlMs
    if (!stale && !dirty) return
    // Detached on purpose: the caller reads the index it already has, and the
    // next query sees the result. A failure is logged, never surfaced as a
    // broken report.
    void scan().catch((error) => ctx.logger?.warn?.('work-journal: background scan failed: %s', error?.message ?? error))
  }

  /**
   * Answer one range query.
   * @param request - range kind, anchor, recent-days, and optional project filter.
   * @returns the aggregated report plus its rendered Markdown.
   */
  const query = async (request = {}) => {
    await ensureFresh({ wait: request.wait === true, budgetMs: request.budgetMs })
    const range = resolveRange(request.range ?? 'day', {
      anchor: request.date,
      days: request.days,
      tzOffsetMinutes,
      earliest: earliestDate(index),
    })
    const report = aggregate(index, range)
    const filtered = request.project === undefined ? report : filterByProject(report, request.project)
    const status = indexStatus(index, store.path)
    // A report built from a partially indexed store must say so; otherwise the
    // reader cannot tell "nothing happened" from "not counted yet".
    const provenance = status.complete
      ? `数据源：${store.path}（索引更新于 ${new Date(index.updatedAt).toISOString()}，共 ${status.indexed} 个会话）`
      : `数据源：${store.path}（索引更新于 ${new Date(index.updatedAt).toISOString()}，共 ${status.indexed} 个会话）`
        + `\n> ⚠️ 索引尚未建完：还有 ${status.remaining} 个会话未统计，本次报告可能不完整。可再问一次或稍后重试。`
    return {
      report: filtered,
      markdown: renderMarkdown(filtered, { heading: request.heading, source: provenance }),
      index: status,
    }
  }

  /** Answer the `/journal status` view. */
  const status = () => indexStatus(index, store.path)

  /** The index document itself, for the Web panel. */
  const snapshot = () => ({
    status: indexStatus(index, store.path),
    activities: Object.values(index.activities).map((activity) => ({
      id: activity.id,
      title: activity.title,
      cwd: activity.cwd,
      project: projectLabel(activity.cwd),
      origin: activity.origin,
      firstTime: activity.firstTime,
      lastTime: activity.lastTime,
      days: activity.days,
      prompts: activity.totals.prompts,
      toolCalls: activity.totals.toolCalls,
      outputTokens: activity.totals.outputTokens,
    })).sort((a, b) => b.lastTime - a.lastTime),
  })

  /** Force a full rebuild on the next scan, keeping the current index usable until then. */
  const invalidate = async () => {
    index.revisions = {}
    index.stats.complete = false
    dirty = true
    await store.save(index)
  }

  /**
   * Wait for every scan this runtime started, including the detached refresh
   * a warm query kicks off. Tests and shutdown paths need this: without it, a
   * background pass can still be writing the index while the caller moves on.
   */
  const settled = async () => {
    while (scanning !== undefined) await scanning
  }

  return { query, status, snapshot, scan, invalidate, settled, indexPath: store.path, tzOffsetMinutes, getIndex: () => index }
}

/** Earliest recorded day, used as the floor for an `all` range. */
function earliestDate(index) {
  let earliest
  for (const activity of Object.values(index.activities)) {
    for (const date of activity.days ?? []) {
      if (earliest === undefined || date < earliest) earliest = date
    }
  }
  return earliest
}

/** Short project label for a working directory. */
function projectLabel(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return '(未知目录)'
  const parts = cwd.split(/[\\/]/u).filter((part) => part.length > 0)
  return parts.length === 0 ? '(未知目录)' : parts[parts.length - 1]
}

/** Narrow an aggregated report to one project. */
function filterByProject(report, project) {
  const projects = report.projects.filter((entry) => entry.project === project || entry.cwd === project)
  if (projects.length === 0) return { ...report, projects: [], sessions: [], prompts: [], days: [], tools: [], files: [], commands: [] }
  const sessions = report.sessions.filter((session) => session.project === project || session.cwd === project)
  const ids = new Set(sessions.map((session) => session.id))
  const days = report.days
    .map((day) => ({ ...day, sessions: sessions.filter((session) => session.days.includes(day.date)).length }))
    .filter((day) => day.sessions > 0)
  const tools = {}
  const files = {}
  const commands = {}
  for (const entry of projects) {
    for (const [name, count] of Object.entries(entry.tools ?? {})) tools[name] = (tools[name] ?? 0) + count
    for (const [path, count] of Object.entries(entry.files ?? {})) files[path] = (files[path] ?? 0) + count
    for (const [command, count] of Object.entries(entry.commands ?? {})) commands[command] = (commands[command] ?? 0) + count
  }
  return {
    ...report,
    projects,
    sessions,
    days,
    prompts: report.prompts.filter((prompt) => ids.has(prompt.sessionId)),
    tools: Object.entries(tools).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 12),
    files: Object.entries(files).map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count).slice(0, 25),
    commands: Object.entries(commands).map(([command, count]) => ({ command, count })).sort((a, b) => b.count - a.count).slice(0, 20),
  }
}

/** Compact index health value shared by the tool, command, and panel. */
function indexStatus(index, path) {
  return {
    path,
    tzOffsetMinutes: index.tzOffsetMinutes,
    updatedAt: index.updatedAt,
    scans: index.scans,
    sessions: index.stats.sessions,
    indexed: index.stats.indexed,
    failed: index.stats.failed,
    remaining: index.stats.remaining ?? 0,
    lastScanMs: index.stats.lastScanMs,
    complete: index.stats.complete === true,
  }
}
