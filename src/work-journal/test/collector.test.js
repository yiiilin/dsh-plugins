import assert from 'node:assert/strict'
import test from 'node:test'
import { adoptIndex, emptyIndex, INDEX_VERSION, scanOnce } from '../lib/collector.js'

const TZ = 480
const BASE = Date.UTC(2026, 8, 13, 12, 0, 0)

/** One minimal session log with a human prompt and a tool call. */
const logFor = (id, cwd, time = BASE) => [
  { type: 'session', seq: 0, time, data: {} },
  { type: 'user/message', seq: 1, time, data: { turn: 1, step: 1, role: 'user', content: [{ type: 'text', text: `work on ${id}` }], source: { kind: 'user' } } },
  { type: 'tool/call', seq: 2, time: time + 100, data: { turn: 1, step: 1, callId: 'c', name: 'edit', arguments: JSON.stringify({ file_path: `${cwd}/a.js` }) } },
]

/** A fake persistence backend with per-session revisions and read counters. */
function backend(sessions) {
  const reads = []
  return {
    reads,
    list: async () => sessions.map((entry) => ({ header: entry.header, revision: entry.revision })),
    read: async (id) => {
      reads.push(String(id))
      const entry = sessions.find((candidate) => String(candidate.header.id) === String(id))
      if (entry === undefined) throw new Error('not found')
      if (entry.fail === true) throw new Error('corrupt log')
      return { session: entry.header, events: entry.events }
    },
  }
}

const session = (id, cwd, revision, time = BASE) => ({
  header: { id, createdAt: time, cwd },
  revision,
  events: logFor(id, cwd, time),
})

test('starts from an empty index and adopts only a matching layout', () => {
  const empty = emptyIndex(TZ)
  assert.equal(empty.version, INDEX_VERSION)
  assert.equal(empty.stats.indexed, 0)
  assert.equal(adoptIndex(undefined, TZ).version, INDEX_VERSION)
  assert.equal(adoptIndex({ version: INDEX_VERSION - 1 }, TZ).activities && Object.keys(adoptIndex({ version: 0 }, TZ).activities).length, 0)
  // A different offset would leave stale day buckets behind, so the index is
  // rebuilt rather than mixed.
  assert.equal(Object.keys(adoptIndex({ ...empty, tzOffsetMinutes: 0 }, TZ).activities).length, 0)
  const kept = adoptIndex({ ...empty, activities: { a: { id: 'a' } } }, TZ)
  assert.deepEqual(Object.keys(kept.activities), ['a'])
})

test('indexes every session on a first scan and skips them on the second', async () => {
  const index = emptyIndex(TZ)
  const store = backend([session('a', '/w/alpha', 'r1'), session('b', '/w/beta', 'r1')])
  const first = await scanOnce(index, { ...store, tzOffsetMinutes: TZ, now: () => BASE })
  assert.equal(first.indexed, 2)
  assert.equal(first.skipped, 0)
  assert.equal(index.stats.indexed, 2)
  assert.equal(index.stats.sessions, 2)
  assert.equal(index.stats.complete, true)
  assert.deepEqual(store.reads.sort(), ['a', 'b'])

  const second = await scanOnce(index, { ...store, tzOffsetMinutes: TZ, now: () => BASE })
  assert.equal(second.indexed, 0)
  assert.equal(second.skipped, 2)
  // The whole point of the revision guard: an unchanged log is never opened.
  assert.deepEqual(store.reads.sort(), ['a', 'b'])
})

test('re-projects only the session whose revision moved', async () => {
  const index = emptyIndex(TZ)
  const sessions = [session('a', '/w/alpha', 'r1'), session('b', '/w/beta', 'r1')]
  await scanOnce(index, { ...backend(sessions), tzOffsetMinutes: TZ })
  sessions[1].revision = 'r2'
  const store = backend(sessions)
  const result = await scanOnce(index, { ...store, tzOffsetMinutes: TZ })
  assert.equal(result.indexed, 1)
  assert.equal(result.skipped, 1)
  assert.deepEqual(store.reads, ['b'])
})

test('drops a session the store no longer lists', async () => {
  const index = emptyIndex(TZ)
  const sessions = [session('a', '/w/alpha', 'r1'), session('b', '/w/beta', 'r1')]
  await scanOnce(index, { ...backend(sessions), tzOffsetMinutes: TZ })
  assert.equal(index.stats.indexed, 2)
  const after = await scanOnce(index, { ...backend([sessions[0]]), tzOffsetMinutes: TZ })
  assert.equal(after.scanned, 1)
  assert.deepEqual(Object.keys(index.activities), ['a'])
  assert.deepEqual(Object.keys(index.revisions), ['a'])
})

test('isolates one unreadable session and retries it on the next scan', async () => {
  const index = emptyIndex(TZ)
  const broken = session('bad', '/w/bad', 'r1')
  broken.fail = true
  const sessions = [session('good', '/w/good', 'r1'), broken]
  const first = await scanOnce(index, { ...backend(sessions), tzOffsetMinutes: TZ })
  assert.equal(first.failed, 1)
  assert.equal(first.indexed, 1)
  assert.deepEqual(Object.keys(index.activities), ['good'])
  assert.match(index.errors.bad, /corrupt log/u)

  // The failure is not recorded as a revision, so the next pass retries it.
  broken.fail = false
  const second = await scanOnce(index, { ...backend(sessions), tzOffsetMinutes: TZ })
  assert.equal(second.indexed, 1)
  assert.equal(index.errors.bad, undefined)
  assert.deepEqual(Object.keys(index.activities).sort(), ['bad', 'good'])
})

test('honours a per-pass budget and reports what is left', async () => {
  const index = emptyIndex(TZ)
  const sessions = [session('a', '/w/a', 'r1'), session('b', '/w/b', 'r1'), session('c', '/w/c', 'r1')]
  const first = await scanOnce(index, { ...backend(sessions), tzOffsetMinutes: TZ, maxSessions: 2 })
  assert.equal(first.indexed, 2)
  assert.equal(first.remaining, 1)
  assert.equal(first.complete, false)
  assert.equal(index.stats.complete, false)

  const second = await scanOnce(index, { ...backend(sessions), tzOffsetMinutes: TZ, maxSessions: 2 })
  assert.equal(second.indexed, 1)
  assert.equal(second.skipped, 2)
  assert.equal(second.remaining, 0)
  assert.equal(index.stats.complete, true)
})

test('skips a session with no own work instead of indexing an empty record', async () => {
  const index = emptyIndex(TZ)
  const idle = {
    header: { id: 'idle', createdAt: BASE, cwd: '/w/idle' },
    revision: 'r1',
    events: [{ type: 'session', seq: 0, time: BASE, data: {} }, { type: 'turn/start', seq: 1, time: BASE, data: { turn: 1 } }],
  }
  const result = await scanOnce(index, { ...backend([idle]), tzOffsetMinutes: TZ })
  assert.equal(result.indexed, 0)
  assert.deepEqual(index.activities, {})
  // Its revision is still recorded, so it is not re-read every pass.
  assert.equal(index.revisions.idle, 'r1')
})

test('re-projects a volatile session even when its revision is unchanged', async () => {
  const index = emptyIndex(TZ)
  const sessions = [session('live', '/w/live', 'constant-revision'), session('idle', '/w/idle', 'r1')]
  const store = backend(sessions)
  await scanOnce(index, { ...store, tzOffsetMinutes: TZ })
  assert.deepEqual(store.reads.sort(), ['idle', 'live'])

  // A live session's backend revision stays constant until its first flush, so
  // a revision-only guard would skip the session the user is working in.
  const second = await scanOnce(index, { ...store, tzOffsetMinutes: TZ, isVolatile: (id) => id === 'live' })
  assert.equal(second.volatile, 1)
  assert.equal(second.indexed, 1)
  assert.equal(second.skipped, 1)
  // Only the volatile session was opened again; the idle one was skipped.
  assert.deepEqual(store.reads.sort(), ['idle', 'live', 'live'])

  // With nothing volatile, the same pass skips both.
  const third = await scanOnce(index, { ...store, tzOffsetMinutes: TZ })
  assert.equal(third.indexed, 0)
  assert.equal(third.skipped, 2)
})

test('records a listing failure without pretending the store is empty', async () => {
  const index = emptyIndex(TZ)
  await assert.rejects(
    () => scanOnce(index, { list: async () => { throw new Error('backend down') }, read: async () => ({}), tzOffsetMinutes: TZ }),
    /backend down/u,
  )
  assert.match(index.errors.__list, /backend down/u)
  assert.equal(index.stats.complete, false)
})
