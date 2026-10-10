import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, Config, inject, name } from '../index.js'

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
  const recorded = { tools: [], commands: [], channels: [], effects: [] }
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
    connection: options.connection === false ? undefined : {
      rpc: {
        handle(channel, handler) {
          recorded.channels.push({ channel, handler })
          return () => {}
        },
      },
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
  assert.deepEqual([...inject], ['tools', 'commands', 'sessionPersistence'])
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
    await apply(ctx, { indexDir: directory, tzOffsetMinutes: TZ })
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
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the tool answers a range query with Markdown and a bounded envelope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-plugin-'))
  try {
    const { ctx, recorded } = harness()
    await apply(ctx, { indexDir: directory, tzOffsetMinutes: TZ })
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
    await apply(ctx, { indexDir: directory, tzOffsetMinutes: TZ })
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
    await apply(ctx, { indexDir: directory, tzOffsetMinutes: TZ })
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
  await apply(ctx, { indexDir: '/tmp/wj-plugin-absent', tzOffsetMinutes: TZ })
  const command = recorded.commands[0]
  const result = await command.handler({ rawInput: 'day' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /工作日志查询失败/u)
})

test('the panel channel answers a query and rejects an unknown endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-plugin-'))
  try {
    const { ctx, recorded } = harness()
    await apply(ctx, { indexDir: directory, tzOffsetMinutes: TZ })
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
    await apply(ctx, { indexDir: directory, tzOffsetMinutes: TZ })
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
