/**
 * Tests for the journal-agent reporter (T3).
 *
 * Everything here is a fake: a fake persistence service, a fake report store,
 * a fake agent registry, and a fake embedder. The suite must never open a real
 * session store, never reach `/root/.dsh`, and never call a model — CI has no
 * network and the session directory is the user's own data.
 *
 * The one test that matters most is the self-contamination guard: the agent
 * this module creates is itself a session in the store it scans, so a scan that
 * does not skip its own preset would summarize its own summaries forever.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createReporter } from '../lib/reporter.js'

const TZ = 480
/** 2026-09-13 12:00 UTC+8. */
const BASE = Date.UTC(2026, 8, 13, 12, 0, 0)
const DAY_START = Date.UTC(2026, 8, 13, 0, 0, 0) - TZ * 60000
const DAY_END = DAY_START + 86399999
const PRESET = 'yiln-work-journal'

/** A session log with one human prompt, one edited file, and one command. */
function eventsFor(file, time = BASE, command = 'npm test') {
  return [
    { type: 'session/title', seq: 0, time, data: { title: `work ${file}`, messageSeqs: [], source: { kind: 'fallback' } } },
    { type: 'user/message', seq: 1, time, data: { turn: 1, step: 1, role: 'user', content: [{ type: 'text', text: `please edit ${file}` }], source: { kind: 'user' } } },
    { type: 'tool/call', seq: 2, time: time + 100, data: { turn: 1, step: 1, callId: 'c1', name: 'edit', arguments: JSON.stringify({ file_path: file }) } },
    { type: 'tool/call', seq: 3, time: time + 200, data: { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: JSON.stringify({ command }) } },
    { type: 'turn/end', seq: 4, time: time + 300, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** One stored session fixture. */
function session(id, overrides = {}) {
  const time = overrides.time ?? BASE
  return {
    header: { id, createdAt: overrides.createdAt ?? time, cwd: overrides.cwd ?? '/w/alpha', isSeeded: false, ...overrides.header },
    revision: overrides.revision ?? `r-${id}`,
    events: overrides.events ?? eventsFor(overrides.file ?? '/w/alpha/a.js', time, overrides.command),
  }
}

/**
 * A persistence double shaped like the real service.
 *
 * `list` returns header+revision snapshots only; `open` hands back a read
 * handle. The counters prove that excluded sessions are never even opened.
 */
function fakePersistence(sessions, options = {}) {
  const counters = { lists: 0, opens: [], closes: 0 }
  return {
    counters,
    async list() {
      counters.lists += 1
      if (options.listError !== undefined) throw options.listError
      return sessions.map((entry) => ({ header: entry.header, revision: entry.revision, sizeBytes: 100 }))
    },
    async open(id) {
      counters.opens.push(String(id))
      if (options.openErrors?.has(String(id)) === true) throw new Error(`unreadable: ${id}`)
      const entry = sessions.find((candidate) => String(candidate.header.id) === String(id))
      if (entry === undefined) throw new Error(`no such session: ${id}`)
      let closed = false
      return {
        id: entry.header.id,
        header: entry.header,
        inheritedEventCount: entry.inheritedEventCount,
        async read() {
          if (closed) throw new Error('handle closed')
          return { eventState: 'detached', events: entry.events }
        },
        async close() {
          counterBump(counters, 'closes')
          closed = true
        },
      }
    },
  }
}

function counterBump(counters, key) {
  counters[key] = (counters[key] ?? 0) + 1
}

/** A store double recording every `upsert`, with the store's own file ownership. */
function fakeStore(overrides = {}) {
  const writes = []
  return {
    writes,
    reportsDir: '/fake/reports',
    vectorSupport: true,
    async upsert(meta, body) {
      writes.push({ meta, body })
    },
    ...overrides,
  }
}

/**
 * An agent registry double.
 *
 * `agentFactory` decides whether creation succeeds, so a test can exercise the
 * failure path without a model. The created handle records the options it was
 * given (which is how the preset stamp is asserted) and the prompt it received.
 */
function fakeAgents(agentFactory) {
  const created = []
  const disposed = []
  const registry = {
    created,
    disposed,
    async create(creation) {
      created.push(creation)
      const agent = await agentFactory(creation)
      return {
        agent,
        async dispose() {
          disposed.push(creation.sessionId)
        },
      }
    },
  }
  return registry
}

/** A fake agent whose reply is one assistant message. */
function fakeAgent(reply, options = {}) {
  const calls = []
  const listeners = new Map()
  const events = options.events ?? (reply === undefined ? [] : [
    { type: 'turn/start', seq: 0, time: BASE, data: { turn: 1 } },
    { type: 'assistant/message', seq: 1, time: BASE, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } } },
    { type: 'turn/end', seq: 2, time: BASE, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  const agent = {
    id: options.id ?? 'agent-1',
    session: { ownEvents: () => events },
    ctx: {
      on(name, callback) {
        listeners.set(name, callback)
        return () => listeners.delete(name)
      },
    },
    followup(message) {
      calls.push(message)
      if (options.onFollowup !== undefined) return options.onFollowup(message, agent)
      return undefined
    },
    async whenIdle() {
      if (options.whenIdleError !== undefined) throw options.whenIdleError
      if (options.whenIdle !== undefined) await options.whenIdle()
      if (options.emitError !== undefined) listeners.get('agent/error')?.({ agent, error: options.emitError })
    },
  }
  agent.calls = calls
  return agent
}

/** Run `body` inside a throwaway directory, always cleaned up. */
async function withScratch(body) {
  const directory = await mkdtemp(join(tmpdir(), 'wj-reporter-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Build a reporter over fakes. */
function makeReporter(sessions, options = {}) {
  const persistence = options.persistence ?? fakePersistence(sessions, options)
  const store = options.store ?? fakeStore()
  const created = []
  const agents = options.agents ?? fakeAgents(async (creation) => {
    const agent = options.agent === undefined ? fakeAgent('## 概览\n\n做了些事。') : options.agent
    created.push(agent)
    return agent
  })
  const loggerCalls = { info: [], warn: [], error: [] }
  const reporter = createReporter({
    agents,
    persistence,
    store,
    embedder: options.embedder,
    model: Object.hasOwn(options, 'model') ? options.model : { provider: 'sub2api-gpt', model: 'deepseek-flash' },
    reportsDir: options.reportsDir,
    logger: {
      info: (...args) => loggerCalls.info.push(args.join(' ')),
      warn: (...args) => loggerCalls.warn.push(args.join(' ')),
      error: (...args) => loggerCalls.error.push(args.join(' ')),
    },
    presetName: options.presetName ?? PRESET,
    maxSessions: options.maxSessions,
    tzOffsetMinutes: TZ,
    cwd: options.cwd ?? '/w/alpha',
    now: options.now ?? (() => DAY_END + 1),
    createSessionId: options.createSessionId ?? ((kind, key) => `wj-${kind}-${key}`),
    ...options.reporterOptions,
  })
  return { reporter, persistence, store, agents, created, loggerCalls }
}

const DAY_RANGE = { startTime: DAY_START, endTime: DAY_END, label: '2026-09-13' }

test('excludes the reporter\'s own sessions from the material (self-contamination guard)', async () => {
  // The regression this guards: the report agent is itself a DSH session in the
  // same store. Without the preset filter, the next run would find yesterday's
  // report session and summarize the summary.
  const sessions = [
    session('human-1'),
    session('report-agent-1', { header: { agentPreset: PRESET } }),
    session('report-agent-2', { header: { agentPreset: PRESET } }),
  ]
  const { reporter, persistence, store } = makeReporter(sessions)
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)

  assert.equal(outcome.ok, true)
  assert.equal(outcome.sessionCount, 1)
  // The excluded sessions are never even opened: the filter runs on the list
  // snapshot, before any log read.
  assert.deepEqual(persistence.counters.opens, ['human-1'])
  const [write] = store.writes
  assert.equal(write.meta.sessionCount, 1)
  assert.match(write.body, /排除本插件自身会话 2 个/u)
  assert.doesNotMatch(write.body, /report-agent-1/u)
})

test('stamps the created agent with the preset so the next scan can exclude it', async () => {
  const { reporter, agents } = makeReporter([session('human-1')])
  await reporter.generate('day', '2026-09-13', DAY_RANGE)

  assert.equal(agents.created.length, 1)
  const [creation] = agents.created
  assert.equal(creation.meta.agentPreset, PRESET)
  assert.equal(creation.meta.delegationDepth, 0)
  // `origin: 'subagent'` would make the journal count the report prompt as
  // delegated work; a one-shot top-level session must not claim to be a child.
  assert.equal(creation.meta.origin, undefined)
  assert.equal(creation.sessionId, 'wj-day-2026-09-13')
  assert.deepEqual(creation.agentOptions, { provider: 'sub2api-gpt', model: 'deepseek-flash' })
})

test('only sessions with activity inside the range become material', async () => {
  const inside = session('inside', { time: BASE })
  // Created before the range but active inside it: the log window, not the
  // creation time, is what includes this one.
  const longLived = session('long-lived', {
    createdAt: DAY_START - 30 * 86400000,
    time: BASE + 3600000,
  })
  // Created before and last active before the range. This one is read — the
  // cheap filter only drops sessions created *after* the range — and then
  // rejected on its observed window.
  const before = session('before', { createdAt: DAY_START - 10 * 86400000, time: DAY_START - 5 * 86400000 })
  // Created after the range: rejected by the exact creation-time test, before
  // any log is opened.
  const after = session('after', { createdAt: DAY_END + 1, time: DAY_END + 1 })

  const { reporter, persistence, store } = makeReporter([inside, longLived, before, after])
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)

  assert.equal(outcome.ok, true)
  assert.equal(outcome.sessionCount, 2)
  // `after` is never opened: a session cannot contain activity that predates
  // its own creation, so that direction needs no log read.
  assert.deepEqual([...persistence.counters.opens].sort(), ['before', 'inside', 'long-lived'])
  assert.match(store.writes[0].body, /纳入 2 个/u)
  assert.doesNotMatch(store.writes[0].body, /### 会话 before/u)
})

test('writes a successful report with every frozen metadata field', async () => {
  const { reporter, store, agents } = makeReporter([session('human-1')])
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)

  assert.deepEqual(outcome, { ok: true, key: '2026-09-13', sessionCount: 1, error: null })
  assert.equal(store.writes.length, 1)
  const { meta, body } = store.writes[0]
  assert.equal(meta.version, 1)
  assert.equal(meta.key, '2026-09-13')
  assert.equal(meta.kind, 'day')
  assert.equal(meta.label, '2026-09-13')
  assert.equal(meta.startTime, DAY_START)
  assert.equal(meta.endTime, DAY_END)
  assert.equal(meta.generatedAt, DAY_END + 1)
  assert.deepEqual(meta.model, { provider: 'sub2api-gpt', model: 'deepseek-flash' })
  assert.equal(meta.status, 'ok')
  assert.equal(meta.sessionCount, 1)
  assert.equal(meta.error, null)
  // The report must open with its provenance, so a reader always knows where
  // the text came from and when it was made.
  assert.match(body, /^> 数据来源：DSH 会话日志/u)
  assert.match(body, /^> 报告区间：2026-09-13 00:00:00 ~ 2026-09-13 23:59:59$/mu)
  assert.match(body, /^> 生成时间：/mu)
  assert.match(body, /^> 模型：sub2api-gpt \/ deepseek-flash$/mu)
  assert.match(body, /^## 概览$/mu)
  assert.match(body, /做了些事。/u)
  // The agent's own session is removed after the run.
  assert.deepEqual(agents.disposed, ['wj-day-2026-09-13'])
})

test('a failing agent yields status failed with the reason, and does not throw', async () => {
  const agent = fakeAgent(undefined, { whenIdleError: new Error('provider exploded') })
  const { reporter, store, agents } = makeReporter([session('human-1')], { agent })
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)

  assert.equal(outcome.ok, false)
  assert.equal(outcome.key, '2026-09-13')
  assert.match(outcome.error, /provider exploded/u)
  assert.equal(store.writes.length, 1)
  const { meta, body } = store.writes[0]
  assert.equal(meta.status, 'failed')
  assert.equal(meta.error, 'provider exploded')
  assert.equal(meta.sessionCount, 1)
  // The failed run writes no body: the store must be free to keep a previously
  // good Markdown rather than blank it.
  assert.equal(body, '')
  // A failed run still cleans up its agent.
  assert.deepEqual(agents.disposed, ['wj-day-2026-09-13'])
})

test('a model error dispatched through agent/error is recorded even though whenIdle resolves', async () => {
  const agent = fakeAgent(undefined, { emitError: new Error('context window exceeded') })
  const { reporter, store } = makeReporter([session('human-1')], { agent })
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)

  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /context window exceeded/u)
  assert.equal(store.writes[0].meta.status, 'failed')
})

test('a failed turn reason is reported when the agent produced no text', async () => {
  const events = [
    { type: 'turn/start', seq: 0, time: BASE, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: BASE, data: { turn: 1, reason: { kind: 'aborted' } } },
  ]
  const { reporter, store } = makeReporter([session('human-1')], { agent: fakeAgent(undefined, { events }) })
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)

  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /aborted/u)
  assert.equal(store.writes[0].meta.status, 'failed')
})

test('an agent that never settles is cancelled by the run timeout', async () => {
  // A provider that accepts a request and never answers would otherwise hold
  // the scheduler's serial queue forever. The run's own timeout aborts the
  // signal, and the abort is observed once `whenIdle` releases.
  const agent = fakeAgent('too late', {
    whenIdle: () => new Promise((resolve) => {
      setTimeout(resolve, 60).unref?.()
    }),
  })
  const { reporter, store } = makeReporter([session('human-1')], {
    agent,
    reporterOptions: { timeoutMs: 20 },
  })
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)

  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /超时/u)
  assert.equal(store.writes[0].meta.status, 'failed')
  assert.equal(store.writes[0].body, '')
})

test('a hung agent is released by the timeout even though whenIdle never settles', async () => {
  // The failure the first implementation could not handle: `whenIdle` resolves
  // from the loop's own driver, so aborting a signal nothing races against
  // leaves the run hanging forever on a provider that never answers.
  const cancels = []
  const agent = {
    id: 'hang',
    session: { ownEvents: () => [] },
    ctx: { on: () => () => {} },
    followup() {},
    cancel(cause) { cancels.push(cause) },
    whenIdle: () => new Promise(() => {}),
  }
  const store = fakeStore()
  const reporter = createReporter({
    agents: { async create() { return { agent, async dispose() { throw new Error('dispose failed too') } } } },
    persistence: fakePersistence([session('human-1')]),
    store,
    tzOffsetMinutes: TZ,
    createSessionId: () => 'wj-day-2026-09-13',
    timeoutMs: 50,
    logger: { info() {}, warn() {}, error() {} },
  })
  const started = Date.now()
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)

  assert.ok(Date.now() - started < 5000, 'the run must not hang')
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /超时/u)
  // The agent is cancelled, which is what actually retires the turn.
  assert.equal(cancels.length, 1)
  assert.equal(cancels[0].kind, 'hook')
  assert.equal(store.writes[0].meta.status, 'failed')
  assert.equal(store.writes[0].body, '')
})

test('the system provenance header is the first thing in the body', async () => {
  // The model is instructed not to write provenance; a model that ignores that
  // cannot displace the system header, which is always prepended.
  const { reporter, store } = makeReporter([session('human-1')], {
    agent: fakeAgent('> 数据来源：我瞎写的\n\n## 概览\n\n正文。'),
  })
  await reporter.generate('day', '2026-09-13', DAY_RANGE)
  const [first] = store.writes[0].body.split('\n')
  assert.match(first, /^> 数据来源：DSH 会话日志/u)
  assert.match(store.writes[0].body, /正文。/u)
})

test('an empty range writes a deterministic empty report without calling the model', async () => {
  const { reporter, store, agents, created } = makeReporter([session('human-1')])
  const otherDay = { startTime: DAY_START + 10 * 86400000, endTime: DAY_END + 10 * 86400000 }
  const outcome = await reporter.generate('day', '2026-09-23', otherDay)

  assert.equal(outcome.ok, true)
  assert.equal(outcome.sessionCount, 0)
  // No agent: a model asked to summarize nothing invents something.
  assert.equal(agents.created.length, 0)
  assert.equal(created.length, 0)
  assert.equal(store.writes[0].meta.status, 'ok')
  assert.match(store.writes[0].body, /本区间内没有记录到会话活动/u)
  assert.match(store.writes[0].body, /^> 数据来源：/u)
})

test('maxSessions truncates the read budget and the truncation is reported', async () => {
  const sessions = []
  for (let index = 0; index < 5; index += 1) {
    // Distinct creation times so the newest-first ordering is deterministic.
    sessions.push(session(`s${index}`, { createdAt: BASE + index * 1000, time: BASE + index * 1000 }))
  }
  const { reporter, persistence, store } = makeReporter(sessions, { maxSessions: 2 })
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)

  assert.equal(outcome.ok, true)
  assert.equal(outcome.sessionCount, 2)
  // The two newest survive the cut.
  assert.deepEqual([...persistence.counters.opens].sort(), ['s3', 's4'])
  assert.match(store.writes[0].body, /候选会话超过上限 2/u)
})

test('a missing embedder degrades to a keyword-only report without breaking', async () => {
  const { reporter, store, loggerCalls } = makeReporter([session('human-1')], { embedder: undefined })
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)

  assert.equal(outcome.ok, true)
  assert.equal(store.writes[0].meta.status, 'ok')
  assert.match(loggerCalls.info.join('\n'), /keyword search only/u)
})

test('an unusable embedder is reported once at wiring time and does not fail a report', async () => {
  const store = fakeStore({ vectorSupport: false })
  const { reporter, loggerCalls } = makeReporter([session('human-1')], {
    store,
    embedder: { dims: 512, async embed(texts) { return texts.map(() => null) }, async close() {} },
  })
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)

  assert.equal(outcome.ok, true)
  assert.match(loggerCalls.warn.join('\n'), /sqlite-vec is unavailable/u)
})

test('an unreadable session is counted, warns, and does not lose the report', async () => {
  const sessions = [session('good'), session('bad')]
  const { reporter, store, loggerCalls } = makeReporter(sessions, { openErrors: new Set(['bad']) })
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)

  assert.equal(outcome.ok, true)
  assert.equal(outcome.sessionCount, 1)
  assert.match(loggerCalls.warn.join('\n'), /could not read session bad/u)
  assert.match(store.writes[0].body, /有 1 个会话日志无法读取/u)
})

test('a store that cannot list produces a failed report rather than an exception', async () => {
  const { reporter, store } = makeReporter([], { listError: new Error('store offline') })
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)

  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /store offline/u)
  assert.equal(store.writes.length, 1)
  assert.equal(store.writes[0].meta.status, 'failed')
  assert.equal(store.writes[0].meta.sessionCount, 0)
})

test('a failure to record the failed report is logged and still returned', async () => {
  const store = fakeStore({ async upsert() { throw new Error('disk full') } })
  const { reporter, loggerCalls } = makeReporter([session('human-1')], {
    store,
    agent: fakeAgent(undefined, { whenIdleError: new Error('provider exploded') }),
  })
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)

  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /provider exploded/u)
  assert.match(loggerCalls.error.join('\n'), /could not record the failed report/u)
})

test('a store that does not own files gets the Markdown and JSON pair written', async () => {
  await withScratch(async (directory) => {
    const store = fakeStore({ reportsDir: undefined })
    const { reporter } = makeReporter([session('human-1')], {
      store,
      reportsDir: directory,
      agent: fakeAgent('## 概览\n\nfallback 落盘。'),
    })
    const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)

    assert.equal(outcome.ok, true)
    const body = await readFile(join(directory, 'day', '2026-09-13.md'), 'utf8')
    const meta = JSON.parse(await readFile(join(directory, 'day', '2026-09-13.json'), 'utf8'))
    assert.match(body, /fallback 落盘。/u)
    assert.equal(meta.status, 'ok')
    assert.equal(meta.key, '2026-09-13')
    // The store row is still written: the files are an addition, not a
    // replacement for the index.
    assert.equal(store.writes.length, 1)
  })
})

test('accepts date-string ranges and rejects an inverted one', async () => {
  const { reporter, store } = makeReporter([session('human-1')])
  const outcome = await reporter.generate('day', '2026-09-13', { startDate: '2026-09-13', endDate: '2026-09-13' })

  assert.equal(outcome.ok, true)
  const { meta } = store.writes[0]
  assert.equal(meta.startTime, DAY_START)
  assert.equal(meta.endTime, DAY_END)
  await assert.rejects(
    () => reporter.generate('day', '2026-09-13', { startTime: DAY_END, endTime: DAY_START }),
    /startTime must not be after endTime/u,
  )
})

test('rejects an unknown kind and a malformed key before doing any work', async () => {
  const { reporter, persistence, store } = makeReporter([session('human-1')])
  await assert.rejects(() => reporter.generate('year', '2026', DAY_RANGE), /unknown report kind/u)
  await assert.rejects(() => reporter.generate('day', '../escape', DAY_RANGE), /invalid report key/u)
  assert.equal(persistence.counters.lists, 0)
  assert.equal(store.writes.length, 0)
})

test('a caller abort is recorded as a failed report and the agent is disposed', async () => {
  const controller = new AbortController()
  const agent = fakeAgent('late', { onFollowup: () => controller.abort(new Error('user cancelled')) })
  const { reporter, store, agents } = makeReporter([session('human-1')], { agent })
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE, controller.signal)

  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /user cancelled/u)
  assert.equal(store.writes[0].meta.status, 'failed')
  assert.deepEqual(agents.disposed, ['wj-day-2026-09-13'])
})

test('a createAgent-only registry is still usable', async () => {
  const agent = fakeAgent('## 概览\n\nvia createAgent。')
  const store = fakeStore()
  const persistence = fakePersistence([session('human-1')])
  const reporter = createReporter({
    // The factory interface underneath the registry: no `create` verb.
    agents: { async createAgent(ownerCtx, creation) { assert.equal(ownerCtx, 'owner'); return { agent, async dispose() {} } } },
    ownerCtx: 'owner',
    persistence,
    store,
    model: { provider: 'p', model: 'm' },
    tzOffsetMinutes: TZ,
    createSessionId: () => 'wj-day-2026-09-13',
  })
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)
  assert.equal(outcome.ok, true)
  assert.match(store.writes[0].body, /via createAgent。/u)
})

test('a missing agent service is a recorded failure, not a load-time throw', async () => {
  const store = fakeStore()
  const reporter = createReporter({
    agents: undefined,
    persistence: fakePersistence([session('human-1')]),
    store,
    tzOffsetMinutes: TZ,
    createSessionId: () => 'wj-day-2026-09-13',
  })
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)
  assert.equal(outcome.ok, false)
  assert.match(outcome.error, /agent service is unavailable/u)
  assert.equal(store.writes[0].meta.status, 'failed')
})

test('refuses to construct without persistence or a store', () => {
  assert.throws(() => createReporter({ store: fakeStore() }), /requires the sessionPersistence service/u)
  assert.throws(() => createReporter({ persistence: fakePersistence([]) }), /requires an open report store/u)
  assert.throws(() => createReporter({ persistence: fakePersistence([]), store: fakeStore(), maxSessions: 0 }), /maxSessions/u)
  assert.throws(() => createReporter({ persistence: fakePersistence([]), store: fakeStore(), presetName: '' }), /presetName/u)
})

test('caps the prompt material so one huge store cannot flood the model', async () => {
  const sessions = []
  for (let index = 0; index < 60; index += 1) {
    const prompts = []
    for (let prompt = 0; prompt < 12; prompt += 1) {
      prompts.push({
        type: 'user/message',
        seq: 1 + prompt,
        time: BASE + prompt,
        data: { turn: 1, step: 1, role: 'user', content: [{ type: 'text', text: `${'x'.repeat(390)}-${index}-${prompt}` }], source: { kind: 'user' } },
      })
    }
    sessions.push(session(`s${index}`, { createdAt: BASE + index, time: BASE, events: prompts }))
  }
  const { reporter, created } = makeReporter(sessions, { maxSessions: 60 })
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)

  assert.equal(outcome.ok, true)
  assert.equal(outcome.sessionCount, 60)
  const prompt = created[0].calls[0].content[0].text
  // 60 sessions x ~4.8 KB of prompts would be ~290 KB; the material cap keeps
  // the prompt an order of magnitude smaller than that.
  assert.ok(prompt.length < 140000, `prompt was ${prompt.length} characters`)
  assert.match(prompt, /素材已达 \d+ 字符上限/u)
})

test('reads sessions concurrently but never more than the read window', async () => {
  const sessions = Array.from({ length: 12 }, (_, index) => session(`s${index}`, { createdAt: BASE + index, time: BASE + index }))
  const { reporter, persistence } = makeReporter(sessions)
  await reporter.generate('day', '2026-09-13', DAY_RANGE)
  assert.equal(persistence.counters.opens.length, 12)
  assert.equal(persistence.counters.closes, 12)
})

test('an empty inherited session projects to nothing and is not counted', async () => {
  // A seeded fork nobody used has no own work: `projectSession` returns
  // undefined, so it must not appear in the material or the count.
  const seeded = session('seeded', {
    events: [{ type: 'session/end-seed', seq: 0, time: BASE, data: { inherited: true } }],
  })
  const { reporter, store } = makeReporter([seeded, session('human-1')])
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)

  assert.equal(outcome.ok, true)
  assert.equal(outcome.sessionCount, 1)
  assert.doesNotMatch(store.writes[0].body, /seeded/u)
})

test('a warning is logged when reportsDir disagrees with the store', async () => {
  const { loggerCalls } = makeReporter([session('human-1')], { reportsDir: '/elsewhere' })
  assert.match(loggerCalls.warn.join('\n'), /differs from the store's/u)
})

test('a streamed assistant message is used when no committed message exists', async () => {
  const events = [
    { type: 'turn/start', seq: 0, time: BASE, data: { turn: 1 } },
    {
      type: 'assistant/message',
      seq: 1,
      time: BASE,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [] },
        stream: [{ type: 'text-chunks', texts: ['## 概览', '\n\n流式内容。'] }],
      },
    },
    { type: 'turn/end', seq: 2, time: BASE, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const { reporter, store } = makeReporter([session('human-1')], { agent: fakeAgent(undefined, { events }) })
  const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)

  assert.equal(outcome.ok, true)
  assert.match(store.writes[0].body, /流式内容。/u)
})

test('week and month report kinds are accepted', async () => {
  const { reporter, store } = makeReporter([session('human-1')])
  const week = await reporter.generate('week', '2026-W37', { startTime: DAY_START - 6 * 86400000, endTime: DAY_END })
  assert.equal(week.ok, true)
  assert.equal(store.writes[0].meta.kind, 'week')

  const month = await reporter.generate('month', '2026-09', { startTime: Date.UTC(2026, 7, 31, 16), endTime: Date.UTC(2026, 8, 30, 15, 59, 59, 999) })
  assert.equal(month.ok, true)
  assert.equal(store.writes[1].meta.kind, 'month')
})

test('the provenance block names the default route when no model is configured', async () => {
  const { reporter, store } = makeReporter([session('human-1')], { model: undefined })
  await reporter.generate('day', '2026-09-13', DAY_RANGE)
  assert.match(store.writes[0].body, /^> 模型：\(默认路由\)$/mu)
  assert.deepEqual(store.writes[0].meta.model, { provider: null, model: null })
})

test('the reporter file and metadata are written with owner-only modes', async () => {
  await withScratch(async (directory) => {
    const store = fakeStore({ reportsDir: undefined })
    const { reporter } = makeReporter([session('human-1')], {
      store,
      reportsDir: directory,
      reporterOptions: {
        // Assert the options the atomic writer is given, without reaching the
        // real writer (which would need a real directory layout).
        write: async (path, content, options) => {
          assert.equal(options.mode, 0o600)
          assert.equal(options.dirMode, 0o700)
          await mkdir(dirname(path), { recursive: true, mode: options.dirMode })
          await writeFile(path, content, { mode: options.mode, flag: 'w' })
        },
      },
    })
    const outcome = await reporter.generate('day', '2026-09-13', DAY_RANGE)
    assert.equal(outcome.ok, true)
    assert.match(await readFile(join(directory, 'day', '2026-09-13.md'), 'utf8'), /数据来源/u)
  })
})