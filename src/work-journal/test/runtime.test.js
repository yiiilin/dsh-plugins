import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installWorkJournal } from '../lib/runtime.js'

const TZ = 480
const BASE = Date.UTC(2026, 8, 13, 12, 0, 0)

/** A session log with one human prompt and one edited file. */
const eventsFor = (file, time = BASE) => [
  { type: 'session/title', seq: 0, time, data: { title: `work ${file}`, messageSeqs: [], source: { kind: 'fallback' } } },
  { type: 'user/message', seq: 1, time, data: { turn: 1, step: 1, role: 'user', content: [{ type: 'text', text: `please edit ${file}` }], source: { kind: 'user' } } },
  { type: 'tool/call', seq: 2, time: time + 100, data: { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: file }) } },
]

/**
 * A persistence double shaped like the real service: `list` returns snapshots
 * with opaque revisions, `open(id, 'read')` returns a handle whose `read()`
 * yields the whole log.
 */
function fakePersistence(sessions, counters = { opens: 0, lists: 0 }) {
  return {
    counters,
    async list() {
      counters.lists += 1
      return sessions.map((entry) => ({ header: entry.header, revision: entry.revision, sizeBytes: 100 }))
    },
    async open(id) {
      counters.opens += 1
      const entry = sessions.find((candidate) => String(candidate.header.id) === String(id))
      if (entry === undefined) throw new Error(`no such session: ${id}`)
      let closed = false
      return {
        id: entry.header.id,
        header: entry.header,
        async read() {
          if (closed) throw new Error('handle closed')
          return { eventState: 'detached', events: entry.events }
        },
        async close() {
          closed = true
        },
      }
    },
  }
}

/** Minimal Cordis-shaped context carrying the services the runtime reads. */
function fakeContext(persistence, logger = { warnings: [] }, extra = {}) {
  const services = { sessionPersistence: persistence, profileContext: undefined, ...extra }
  return {
    logger: {
      warn: (...args) => logger.warnings.push(args.join(' ')),
      error: (...args) => logger.warnings.push(args.join(' ')),
    },
    loggerState: logger,
    get: (name) => services[name],
  }
}

/** Install a runtime against a temporary index directory. */
async function withRuntime(sessions, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'wj-runtime-'))
  const persistence = fakePersistence(sessions, options.counters)
  const ctx = fakeContext(persistence, options.logger, options.services)
  const runtime = await installWorkJournal(ctx, {
    indexDir: directory,
    tzOffsetMinutes: TZ,
    refreshTtlMs: options.refreshTtlMs ?? 60000,
    maxSessionsPerScan: options.maxSessionsPerScan ?? 400,
  })
  return { runtime, directory, persistence, ctx }
}

const session = (id, cwd, revision, file, time = BASE) => ({
  header: { id, createdAt: time, cwd, isSeeded: false },
  revision,
  events: eventsFor(file, time),
})

test('answers a daily report from the session store', async () => {
  const { runtime, directory } = await withRuntime([session('s1', '/w/alpha', 'r1', '/w/alpha/a.js')])
  try {
    const outcome = await runtime.query({ range: 'day', date: '2026-09-13' })
    assert.equal(outcome.report.range.kind, 'day')
    assert.equal(outcome.report.totals.sessions, 1)
    assert.equal(outcome.report.totals.prompts, 1)
    assert.equal(outcome.report.totals.toolCalls, 1)
    assert.deepEqual(outcome.report.files.map((entry) => entry.path), ['/w/alpha/a.js'])
    assert.match(outcome.markdown, /please edit \/w\/alpha\/a\.js/u)
    assert.match(outcome.markdown, /work \/w\/alpha\/a\.js/u)
    assert.equal(outcome.index.indexed, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reuses the index within the refresh window and re-reads after a revision change', async () => {
  const counters = { opens: 0, lists: 0 }
  const sessions = [session('s1', '/w/alpha', 'r1', '/w/alpha/a.js')]
  const { runtime, directory } = await withRuntime(sessions, { counters })
  try {
    await runtime.query({ range: 'day', date: '2026-09-13' })
    const afterFirst = counters.opens
    assert.equal(afterFirst, 1)

    // A second question inside the window is answered without touching the store.
    await runtime.query({ range: 'day', date: '2026-09-13' })
    assert.equal(counters.opens, afterFirst)

    // New work arrives: the revision moves, so the next refresh re-reads it.
    sessions[0].revision = 'r2'
    sessions[0].events = [...sessions[0].events, {
      type: 'tool/call', seq: 3, time: BASE + 200, data: { turn: 1, step: 1, callId: 'c2', name: 'write', arguments: JSON.stringify({ file_path: '/w/alpha/b.js' }) },
    }]
    const outcome = await runtime.query({ range: 'day', date: '2026-09-13', wait: true })
    assert.equal(counters.opens, afterFirst + 1)
    assert.deepEqual(outcome.report.files.map((entry) => entry.path).sort(), ['/w/alpha/a.js', '/w/alpha/b.js'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a first-ever query waits for the scan, so it never reports an empty journal', async () => {
  const { runtime, directory } = await withRuntime([session('s1', '/w/alpha', 'r1', '/w/alpha/a.js')])
  try {
    // `wait` is not set: an unscanned index is still awaited, because answering
    // from nothing would be wrong rather than merely stale.
    const outcome = await runtime.query({ range: 'day', date: '2026-09-13' })
    assert.equal(outcome.report.totals.sessions, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a warm query answers immediately and refreshes behind the caller', async () => {
  const counters = { opens: 0, lists: 0 }
  const { runtime, directory } = await withRuntime([session('s1', '/w/alpha', 'r1', '/w/alpha/a.js')], { counters, refreshTtlMs: 0 })
  try {
    await runtime.query({ range: 'day', date: '2026-09-13' })
    const opens = counters.opens
    const outcome = await runtime.query({ range: 'day', date: '2026-09-13' })
    // The answer comes from the existing index; the refresh runs detached.
    assert.equal(outcome.report.totals.sessions, 1)
    // Wait for the detached pass before tearing the directory down.
    await runtime.settled()
    assert.ok(counters.opens >= opens)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('filters a report by project name or absolute cwd', async () => {
  const sessions = [session('s1', '/w/alpha', 'r1', '/w/alpha/a.js'), session('s2', '/w/beta', 'r1', '/w/beta/b.js')]
  const { runtime, directory } = await withRuntime(sessions)
  try {
    const byName = await runtime.query({ range: 'day', date: '2026-09-13', project: 'beta' })
    assert.deepEqual(byName.report.sessions.map((entry) => entry.id), ['s2'])
    assert.deepEqual(byName.report.files.map((entry) => entry.path), ['/w/beta/b.js'])
    assert.match(byName.markdown, /\/w\/beta\/b\.js/u)
    assert.doesNotMatch(byName.markdown, /\/w\/alpha\/a\.js/u)

    const byPath = await runtime.query({ range: 'day', date: '2026-09-13', project: '/w/alpha' })
    assert.deepEqual(byPath.report.sessions.map((entry) => entry.id), ['s1'])

    const missing = await runtime.query({ range: 'day', date: '2026-09-13', project: 'nope' })
    assert.equal(missing.report.totals.sessions, 2)
    assert.deepEqual(missing.report.sessions, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reports index health and a panel snapshot', async () => {
  const { runtime, directory } = await withRuntime([session('s1', '/w/alpha', 'r1', '/w/alpha/a.js')])
  try {
    await runtime.query({ range: 'day', date: '2026-09-13' })
    const status = runtime.status()
    assert.equal(status.indexed, 1)
    assert.equal(status.sessions, 1)
    assert.equal(status.failed, 0)
    assert.equal(status.complete, true)
    assert.equal(status.tzOffsetMinutes, TZ)
    assert.ok(status.path.endsWith('index.json'))

    const snapshot = runtime.snapshot()
    assert.equal(snapshot.activities.length, 1)
    assert.equal(snapshot.activities[0].project, 'alpha')
    assert.equal(snapshot.activities[0].prompts, 1)
    assert.equal(snapshot.activities[0].toolCalls, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a forced rebuild re-reads every session', async () => {
  const counters = { opens: 0, lists: 0 }
  const { runtime, directory } = await withRuntime([session('s1', '/w/alpha', 'r1', '/w/alpha/a.js')], { counters })
  try {
    await runtime.query({ range: 'day', date: '2026-09-13' })
    assert.equal(counters.opens, 1)
    await runtime.invalidate()
    const result = await runtime.scan()
    assert.equal(result.indexed, 1)
    assert.equal(counters.opens, 2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('joins concurrent scans instead of walking the store twice', async () => {
  const counters = { opens: 0, lists: 0 }
  const { runtime, directory } = await withRuntime([session('s1', '/w/alpha', 'r1', '/w/alpha/a.js')], { counters })
  try {
    const [first, second] = await Promise.all([runtime.scan(), runtime.scan()])
    assert.equal(counters.lists, 1)
    assert.equal(first.indexed, 1)
    assert.deepEqual(first, second)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('re-reads the live session every pass and prefers the live-preferred query service', async () => {
  const counters = { opens: 0, lists: 0 }
  const sessions = [session('live', '/w/alpha', 'constant-revision', '/w/alpha/a.js'), session('idle', '/w/beta', 'r1', '/w/beta/b.js')]
  // A live session's backend revision does not advance until it flushes, so the
  // runtime must treat it as volatile and read it from `sessionQuery` instead.
  let liveEvents = eventsFor('/w/alpha/a.js')
  const sessionQuery = {
    async readSession(id) {
      assert.equal(String(id), 'live')
      return { session: sessions[0].header, events: liveEvents, inheritedEventCount: 0 }
    },
  }
  const liveSessions = { list: () => [{ id: 'live' }] }
  const { runtime, directory } = await withRuntime(sessions, {
    counters,
    services: { sessionQuery, sessions: liveSessions },
  })
  try {
    await runtime.query({ range: 'day', date: '2026-09-13' })
    assert.equal(counters.opens, 1, 'only the idle session goes through persistence')

    // New work lands in the live session without any durable revision change.
    liveEvents = [...liveEvents, {
      type: 'tool/call', seq: 3, time: BASE + 300, data: { turn: 1, step: 1, callId: 'c2', name: 'write', arguments: JSON.stringify({ file_path: '/w/alpha/new.js' }) },
    }]
    const outcome = await runtime.query({ range: 'day', date: '2026-09-13', wait: true })
    // The idle session's file is still there; the point is that the live
    // session picked up work no durable revision had recorded.
    assert.deepEqual(outcome.report.files.map((entry) => entry.path).sort(), ['/w/alpha/a.js', '/w/alpha/new.js', '/w/beta/b.js'])
    assert.equal(counters.opens, 1, 'the live session never re-opened a persistence handle')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a project filter never leaks another project shell history', async () => {
  const alpha = session('s1', '/w/alpha', 'r1', '/w/alpha/a.js')
  const beta = session('s2', '/w/beta', 'r1', '/w/beta/b.js')
  // Give each session a distinguishable command.
  alpha.events = [...alpha.events, { type: 'tool/call', seq: 3, time: BASE + 20, data: { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: JSON.stringify({ command: 'alpha-only-cmd' }) } }]
  beta.events = [...beta.events, { type: 'tool/call', seq: 3, time: BASE + 20, data: { turn: 1, step: 1, callId: 'c3', name: 'bash', arguments: JSON.stringify({ command: 'beta-only-cmd' }) } }]
  const { runtime, directory } = await withRuntime([alpha, beta])
  try {
    const all = await runtime.query({ range: 'day', date: '2026-09-13' })
    assert.deepEqual(all.report.commands.map((entry) => entry.command).sort(), ['alpha-only-cmd', 'beta-only-cmd'])
    const filtered = await runtime.query({ range: 'day', date: '2026-09-13', project: 'beta' })
    assert.deepEqual(filtered.report.commands.map((entry) => entry.command), ['beta-only-cmd'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a first query finishes the whole store instead of answering from a partial pass', async () => {
  // The regression: with a per-pass budget, one pass over a store larger than
  // the budget returns a report silently missing every session the budget cut
  // off. A cold build must loop to completion.
  const counters = { opens: 0, lists: 0 }
  const sessions = Array.from({ length: 5 }, (_, index) => session(`s${index}`, `/w/p${index}`, 'r1', `/w/p${index}/a.js`))
  const { runtime, directory } = await withRuntime(sessions, { counters, maxSessionsPerScan: 2 })
  try {
    const outcome = await runtime.query({ range: 'day', date: '2026-09-13' })
    assert.equal(outcome.report.totals.sessions, 5, 'every session must be counted')
    assert.equal(outcome.index.complete, true)
    assert.equal(outcome.index.remaining, 0)
    assert.doesNotMatch(outcome.markdown, /索引尚未建完/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a budget that cannot finish in time answers partial but says so', async () => {
  const sessions = Array.from({ length: 4 }, (_, index) => session(`s${index}`, `/w/p${index}`, 'r1', `/w/p${index}/a.js`))
  const { runtime, directory } = await withRuntime(sessions, { maxSessionsPerScan: 1 })
  try {
    // A zero wall-clock budget stops after the first pass and must report it.
    const outcome = await runtime.query({ range: 'day', date: '2026-09-13', wait: true, budgetMs: 0 })
    assert.equal(outcome.index.complete, false)
    assert.ok(outcome.index.remaining > 0)
    assert.match(outcome.markdown, /索引尚未建完/u)
    assert.equal(runtime.status().complete, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('requires the persistence service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-runtime-'))
  try {
    await assert.rejects(
      () => installWorkJournal(fakeContext(undefined), { indexDir: directory, tzOffsetMinutes: TZ }),
      /sessionPersistence/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('keeps one unreadable session out of the report without losing the rest', async () => {
  const logger = { warnings: [] }
  const sessions = [session('good', '/w/good', 'r1', '/w/good/a.js')]
  const persistence = fakePersistence(sessions)
  const broken = { header: { id: 'bad', createdAt: BASE, cwd: '/w/bad', isSeeded: false }, revision: 'r1' }
  const originalOpen = persistence.open
  persistence.open = async (id) => {
    if (String(id) === 'bad') throw new Error('corrupt log')
    return originalOpen(id)
  }
  const list = persistence.list
  persistence.list = async () => [...(await list()), { header: broken.header, revision: broken.revision }]

  const directory = await mkdtemp(join(tmpdir(), 'wj-runtime-'))
  try {
    const runtime = await installWorkJournal(fakeContext(persistence, logger), { indexDir: directory, tzOffsetMinutes: TZ })
    const outcome = await runtime.query({ range: 'day', date: '2026-09-13' })
    assert.equal(outcome.report.totals.sessions, 1)
    assert.equal(outcome.index.failed, 1)
    assert.deepEqual(outcome.report.sessions.map((entry) => entry.id), ['good'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
