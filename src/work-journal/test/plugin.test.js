import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, Config, inject, name } from '../index.js'

// Every `apply` in this file opens the report store, which falls back to
// `DSH_HOME` when a call omits `reportsDir`. Pin it to a throwaway directory so
// a missing argument can never write into the live `~/.dsh` — which it did once.
process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'wj-plugin-home-'))
process.env.DSH_PROFILE_DIR = 'test'

const TZ = 480
const BASE = Date.UTC(2026, 8, 13, 12, 0, 0)

const eventsFor = (file) => [
  { type: 'session/title', seq: 0, time: BASE, data: { title: `t ${file}`, messageSeqs: [], source: { kind: 'fallback' } } },
  { type: 'user/message', seq: 1, time: BASE, data: { turn: 1, step: 1, role: 'user', content: [{ type: 'text', text: `do ${file}` }], source: { kind: 'user' } } },
  { type: 'tool/call', seq: 2, time: BASE + 10, data: { turn: 1, step: 1, callId: 'c', name: 'edit', arguments: JSON.stringify({ file_path: file }) } },
]

function fakePersistence(options = {}) {
  const entry = { header: { id: 's1', createdAt: BASE, cwd: '/w/alpha', isSeeded: false }, revision: 'r1', events: eventsFor('/w/alpha/a.js') }
  return {
    async list() {
      if (options.failList === true) throw new Error('session store unavailable')
      return [{ header: entry.header, revision: entry.revision }]
    },
    async open() {
      return { header: entry.header, async read() { return { eventState: 'detached', events: entry.events } }, async close() {} }
    },
  }
}

/**
 * A Cordis-shaped context recording every registration, so the test asserts the
 * plugin's contract — one tool, one command, one RPC channel — rather than its
 * internals.
 *
 * Cordis exposes an injected service both as `ctx.<name>` and through
 * `ctx.get(name)`, so the double provides both; a double with only one of them
 * would pass a plugin that reads services the wrong way.
 */
function harness(options = {}) {
  const recorded = { tools: [], commands: [], channels: [], routes: [], effects: [] }
  const services = {
    sessionPersistence: options.persistence === false ? undefined : fakePersistence(options),
    tools: {
      register(definition) {
        recorded.tools.push(definition)
        return () => recorded.tools.splice(recorded.tools.indexOf(definition), 1)
      },
    },
    commands: {
      register(definition) {
        recorded.commands.push(definition)
        return () => {}
      },
    },
    timer: options.timer,
    agents: options.agents,
    agentDefaultModel: options.agentDefaultModel,
    connection: options.connection === false ? undefined : {
      ...(options.shared === true ? { generation: 1 } : {}),
      rpc: {
        handle(channel, handler) {
          recorded.channels.push({ channel, handler })
          return () => {}
        },
      },
      ...(options.shared === true ? {
        fetch: {
          register(route) {
            recorded.routes.push(route)
            return () => {}
          },
        },
      } : {}),
    },
  }
  const ctx = {
    ...services,
    logger: { warn() {}, error() {} },
    get: (service) => services[service],
    effect(factory, label) {
      recorded.effects.push({ label, dispose: factory() })
    },
  }
  return { ctx, recorded }
}

test('declares its loader identity and a schema whose defaults the row relies on', () => {
  assert.equal(name, 'work-journal')
  assert.deepEqual([...inject], ['tools', 'commands', 'sessionPersistence', 'connection'])
  const parsed = new Config({})
  assert.equal(parsed.indexDir, '')
  assert.equal(parsed.refreshTtlMs, 60000)
  assert.equal(parsed.maxSessionsPerScan, 400)
  assert.ok(Number.isNaN(parsed.tzOffsetMinutes))
})

test('registers the tool, the command, and the panel channel under their effects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-plugin-'))
  try {
    const { ctx, recorded } = harness()
    await apply(ctx, { indexDir: directory, reportsDir: join(directory, 'reports'), tzOffsetMinutes: TZ })
    assert.equal(recorded.tools.length, 1)
    assert.equal(recorded.tools[0].name, 'work_journal')
    assert.equal(recorded.commands.length, 1)
    assert.equal(recorded.commands[0].name, 'journal')
    assert.equal(recorded.channels.length, 1)
    assert.equal(recorded.channels[0].channel, '/work-journal')
    assert.deepEqual(recorded.effects.map((entry) => entry.label), [
      'work-journal: model tool',
      'work-journal: command',
      'work-journal: web panel route',
      'work-journal: report store',
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/**
 * Regression: the panel used to POST to `/work-journal` and get a 405, because
 * `connection.rpc.handle` resolves its route through `ctx.webServer`, which a
 * plugin row never injects. The route must instead ride the shared `/api` fetch
 * transport, and must still fall back for a runtime that has no `fetch`.
 */
test('serves the panel over the shared api route when the runtime offers one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-plugin-'))
  try {
    const { ctx, recorded } = harness({ shared: true })
    await apply(ctx, { indexDir: directory, reportsDir: join(directory, 'reports'), tzOffsetMinutes: TZ })
    assert.deepEqual(recorded.channels, [])
    assert.equal(recorded.routes.length, 1)
    const route = recorded.routes[0]
    assert.equal(route.path, '/api/work-journal')
    assert.deepEqual(route.methods, ['POST'])
    assert.equal(route.requestBody, 'buffered')

    const post = (body) => route.fetch(new Request('http://localhost/api/work-journal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))

    const ok = await (await post({ type: 'client-request', rpcId: 'r1', method: 'work-journal', payload: { endpoint: 'status', payload: {} } })).json()
    assert.equal(ok.type, 'server-response')
    assert.equal(ok.rpcId, 'r1')
    assert.equal(ok.result.ok, true)
    assert.equal(typeof ok.result.value.status.indexed, 'number')

    const bad = await (await post({ type: 'client-request', rpcId: 'r2', method: 'other', payload: {} })).json()
    assert.equal(bad.result.ok, false)
    assert.equal(bad.result.error.code, 'bad-request')

    const wrongType = await route.fetch(new Request('http://localhost/api/work-journal', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'nope',
    }))
    assert.equal(wrongType.status, 415)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/**
 * Scheduled generation is opt-in and additive. A deployment that never sets
 * `schedule` must not start spending model tokens unattended just because this
 * row mounted — and the row must still register everything else when it does.
 */
/**
 * The reports directory is keyed by the resolved timezone offset, and so is the
 * live index. Passing the raw `NaN` sentinel to one and a resolved number to the
 * other split one profile's data across two directories: the index landed under
 * the host-offset key while every report landed under the NaN key.
 *
 * The suite pins DSH_HOME and DSH_PROFILE_DIR, so the expected key is derivable
 * and the assertion is about the real path on disk rather than a proxy.
 */
test('keys the report store by the same resolved offset the index uses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-plugin-'))
  try {
    const { ctx } = harness()
    // Omit tzOffsetMinutes on purpose: the NaN sentinel is the whole point, and
    // passing an explicit offset would skip the resolution under test.
    await apply(ctx, { indexDir: directory })
    const { createHash } = await import('node:crypto')
    const resolved = -new Date().getTimezoneOffset()
    const key = createHash('sha256').update(`test\0${resolved}`).digest('hex').slice(0, 24)
    const expected = join(process.env.DSH_HOME, 'work-journal', key, 'reports')
    assert.ok(existsSync(expected), `report store should be keyed at ${expected}`)
    const nanKey = createHash('sha256').update(`test\0NaN`).digest('hex').slice(0, 24)
    assert.ok(
      !existsSync(join(process.env.DSH_HOME, 'work-journal', nanKey)),
      'the NaN sentinel must never become a directory key',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('does not arm a report schedule unless the row opts in', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-plugin-'))
  try {
    let armed = 0
    const timer = { setTimeout() { armed += 1; return () => {} } }
    const { ctx, recorded } = harness({ timer })
    await apply(ctx, { indexDir: directory, reportsDir: join(directory, 'reports'), tzOffsetMinutes: TZ })
    assert.equal(armed, 0, 'no schedule without schedule: true')
    assert.deepEqual(recorded.effects.map((entry) => entry.label), [
      'work-journal: model tool',
      'work-journal: command',
      'work-journal: web panel route',
      'work-journal: report store',
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('opting in arms the schedule and exposes it as its own effect', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-plugin-'))
  try {
    let armed = 0
    const timer = { setTimeout() { armed += 1; return () => {} } }
    const { ctx, recorded } = harness({
      timer,
      agents: { create: async () => { throw new Error('not reached during start') } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    })
    await apply(ctx, {
      indexDir: directory,
      reportsDir: join(directory, 'reports'),
      tzOffsetMinutes: TZ,
      schedule: true,
      // One period per kind: `start()` backfills before it arms, and the default
      // 31-per-kind budget would make this test a timing race for no extra
      // coverage. Catch-up breadth is the scheduler's own suite's concern.
      maxCatchUp: 1,
      // A backfilled report is written through the store, and a wired embedder
      // makes that write embed — which on a cold machine means downloading the
      // model. Disable it here: this test is about arming, not about vectors.
      semanticSearch: false,
    })
    assert.ok(recorded.effects.some((entry) => entry.label === 'work-journal: report schedule'))
    // Arming happens after backfill, so it is not observable in the same tick as
    // `apply`; poll rather than assume a delay.
    for (let i = 0; i < 300 && armed === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(armed > 0, 'the schedule must arm a timer')
    // Dispose before cleanup: a run still in flight would recreate directories
    // under the temp path after `rm` walks it.
    for (const entry of recorded.effects) entry.dispose()
    await new Promise((resolve) => setTimeout(resolve, 50))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a schedule without the services it needs stays idle instead of failing the row', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-plugin-'))
  try {
    const { ctx, recorded } = harness()
    await apply(ctx, {
      indexDir: directory,
      reportsDir: join(directory, 'reports'),
      tzOffsetMinutes: TZ,
      schedule: true,
    })
    // The row still contributed its tool, command, route and store.
    assert.equal(recorded.tools.length, 1)
    assert.equal(recorded.commands.length, 1)
    assert.ok(recorded.effects.some((entry) => entry.label === 'work-journal: report schedule'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the tool answers a range query with Markdown and a bounded envelope', async () => {  const directory = await mkdtemp(join(tmpdir(), 'wj-plugin-'))
  try {
    const { ctx, recorded } = harness()
    await apply(ctx, { indexDir: directory, reportsDir: join(directory, 'reports'), tzOffsetMinutes: TZ })
    const tool = recorded.tools[0]
    const value = await tool.execute({ range: 'day', date: '2026-09-13' }, {})
    assert.equal(value.range, 'day')
    assert.equal(value.sessions, 1)
    assert.equal(value.prompts, 1)
    assert.equal(value.toolCalls, 1)
    assert.match(value.markdown, /do \/w\/alpha\/a\.js/u)
    // A canonical tool value must be lossless JSON, so "not requested" is
    // `null` rather than `undefined`.
    assert.equal(value.report, null)
    assert.equal(JSON.parse(JSON.stringify(value)).report, null)
    // The renderer is what the model reads, and it is the Markdown report.
    const blocks = tool.output.render({ range: 'day' }, value)
    assert.equal(blocks[0].type, 'text')
    assert.equal(blocks[0].text, value.markdown)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the tool returns the structured aggregate when json is requested', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-plugin-'))
  try {
    const { ctx, recorded } = harness()
    await apply(ctx, { indexDir: directory, reportsDir: join(directory, 'reports'), tzOffsetMinutes: TZ })
    const tool = recorded.tools[0]
    const value = await tool.execute({ range: 'day', date: '2026-09-13', format: 'json' }, {})
    assert.equal(value.report.totals.sessions, 1)
    // The whole canonical value survives a JSON round trip, which is the
    // boundary the tool registry enforces.
    assert.deepEqual(JSON.parse(JSON.stringify(value)).report.totals.sessions, 1)
    const blocks = tool.output.render({ range: 'day', format: 'json' }, value)
    assert.equal(JSON.parse(blocks[0].text).totals.sessions, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the command reports a range, its status, and a rebuild', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-plugin-'))
  try {
    const { ctx, recorded } = harness()
    await apply(ctx, { indexDir: directory, reportsDir: join(directory, 'reports'), tzOffsetMinutes: TZ })
    const command = recorded.commands[0]

    const report = await command.handler({ rawInput: 'day 2026-09-13' })
    assert.equal(report.kind, 'success')
    assert.match(report.text, /工作日志/u)
    assert.match(report.text, /do \/w\/alpha\/a\.js/u)

    // A bare date is accepted as the anchor with the default day range.
    const byDate = await command.handler({ rawInput: '2026-09-13' })
    assert.equal(byDate.kind, 'success')
    assert.match(byDate.text, /2026-09-13/u)

    const status = await command.handler({ rawInput: 'status' })
    assert.equal(status.kind, 'success')
    assert.match(status.text, /已索引 1 \/ 1 个会话/u)

    const rebuild = await command.handler({ rawInput: 'rebuild' })
    assert.equal(rebuild.kind, 'success')
    assert.match(rebuild.text, /已重建索引/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the command answers a query failure instead of throwing at the UI', async () => {
  const { ctx, recorded } = harness({ failList: true })
  await apply(ctx, { indexDir: '/tmp/wj-plugin-absent', reportsDir: '/tmp/wj-plugin-absent/reports', tzOffsetMinutes: TZ })
  const command = recorded.commands[0]
  const result = await command.handler({ rawInput: 'day' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /工作日志查询失败/u)
})

test('the panel channel answers a query and rejects an unknown endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-plugin-'))
  try {
    const { ctx, recorded } = harness()
    await apply(ctx, { indexDir: directory, reportsDir: join(directory, 'reports'), tzOffsetMinutes: TZ })
    const { handler } = recorded.channels[0]

    const queried = await handler('query', { range: 'day', date: '2026-09-13' }, new AbortController().signal)
    assert.equal(queried.ok, true)
    assert.equal(queried.value.report.totals.sessions, 1)
    assert.match(queried.value.markdown, /工作日志/u)

    const status = await handler('status', {}, new AbortController().signal)
    assert.equal(status.ok, true)
    assert.equal(status.value.activities.length, 1)
    assert.equal(status.value.activities[0].project, 'alpha')

    const unknown = await handler('delete', {}, new AbortController().signal)
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'bad-request')

    const aborted = new AbortController()
    aborted.abort()
    const cancelled = await handler('query', {}, aborted.signal)
    assert.equal(cancelled.ok, false)
    assert.equal(cancelled.error.code, 'aborted')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('degrades to no panel channel when the deployment has no connection service', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-plugin-'))
  try {
    const { ctx, recorded } = harness({ connection: false })
    await apply(ctx, { indexDir: directory, reportsDir: join(directory, 'reports'), tzOffsetMinutes: TZ })
    assert.equal(recorded.channels.length, 0)
    // The tool and command are unaffected: the panel is an addition, not a
    // dependency.
    assert.equal(recorded.tools.length, 1)
    assert.equal(recorded.commands.length, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a relative index directory fails the row loudly instead of silently degrading', async () => {
  const { ctx, recorded } = harness()
  // A misconfigured path is an operator error, not a transient failure: the
  // loader must see it rather than a plugin that quietly contributes nothing.
  await assert.rejects(() => apply(ctx, { indexDir: 'relative-path', tzOffsetMinutes: TZ }), /absolute/u)
  assert.equal(recorded.tools.length, 0)
  assert.equal(recorded.commands.length, 0)
})

test('a deployment without the persistence service fails the row before it registers anything', async () => {
  const { ctx, recorded } = harness({ persistence: false })
  await assert.rejects(() => apply(ctx, { tzOffsetMinutes: TZ }), /sessionPersistence/u)
  assert.equal(recorded.effects.length, 0)
})
