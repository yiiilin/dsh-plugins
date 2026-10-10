import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertSupportedJsonSchema, ToolArgsError, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply } from '../index.js'

/**
 * The other plugin tests use a recording double for `ctx.tools`, which proves
 * the plugin registers the right things but not that the definition the real
 * registry receives is legal.
 *
 * This suite runs the definition through the genuine `dsh-tools` boundary:
 * `defineTool` really compiles the author-facing schema spec to JSON Schema,
 * `execute` really validates arguments against it, and the canonical value is
 * checked against the declared output schema the way dispatch does. That is the
 * boundary which rejects a non-lossless canonical value — the mistake this file
 * exists to catch.
 */

const TZ = 480
const BASE = Date.UTC(2026, 8, 13, 12, 0, 0)

const events = [
  { type: 'session/title', seq: 0, time: BASE, data: { title: 'schema check', messageSeqs: [], source: { kind: 'fallback' } } },
  { type: 'user/message', seq: 1, time: BASE, data: { turn: 1, step: 1, role: 'user', content: [{ type: 'text', text: 'check the schema' }], source: { kind: 'user' } } },
  { type: 'tool/call', seq: 2, time: BASE + 10, data: { turn: 1, step: 1, callId: 'c', name: 'edit', arguments: JSON.stringify({ file_path: '/w/alpha/a.js' }) } },
]

const header = { id: 's1', createdAt: BASE, cwd: '/w/alpha', isSeeded: false }

/** A persistence double over one session. */
const persistence = {
  async list() {
    return [{ header, revision: 'r1' }]
  },
  async open() {
    return { header, async read() { return { eventState: 'detached', events } }, async close() {} }
  },
}

/** Mount the plugin and capture the definition the registry receives. */
async function mountTool(directory) {
  const registered = []
  const services = {
    sessionPersistence: persistence,
    tools: { register(definition) { registered.push(definition); return () => {} } },
    commands: { register() { return () => {} } },
  }
  await apply({ ...services, logger: { warn() {}, error() {} }, get: (name) => services[name], effect: (factory) => factory() }, {
    indexDir: directory,
    tzOffsetMinutes: TZ,
  })
  assert.equal(registered.length, 1)
  return registered[0]
}

test('the compiled definition declares a supported parameter schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-schema-'))
  try {
    const definition = await mountTool(directory)
    assert.equal(definition.name, 'work_journal')
    assert.ok(definition.description.length > 0)
    // The real compile step produced a JSON Schema from the author-facing spec.
    assert.equal(typeof definition.parameters, 'object')
    assert.deepEqual(definition.parameters.properties.range.enum, ['day', 'week', 'month', 'recent', 'all'])
    // And it belongs to the subset the registry can enforce.
    assert.doesNotThrow(() => assertSupportedJsonSchema(definition.parameters))
    assert.doesNotThrow(() => assertSupportedJsonSchema(definition.output.schema))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('every accepted argument shape yields a canonical value that validates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-schema-'))
  try {
    const definition = await mountTool(directory)
    const cases = [
      { range: 'day', date: '2026-09-13' },
      { range: 'week', date: '2026-09-13', format: 'json' },
      { range: 'recent', days: 3, project: 'alpha', refresh: true },
      { range: 'all' },
      {},
    ]
    for (const args of cases) {
      const value = await definition.execute(args, {})
      const violations = validateJsonSchemaValue(definition.output.schema, value)
      assert.deepEqual(violations, [], `${JSON.stringify(args)}: ${violations.join('; ')}`)
      // The registry materializes the value through JSON, so anything that does
      // not survive that round trip would fail at the dispatch boundary.
      assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
      const blocks = definition.output.render(args, value)
      assert.equal(blocks[0].type, 'text')
      assert.ok(blocks[0].text.length > 0)
      assert.doesNotThrow(() => definition.presentResult(args, { isError: false }))
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the compiled schema refuses arguments the body never sees', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-schema-'))
  try {
    const definition = await mountTool(directory)
    // An out-of-enum range and a wrongly typed window are both rejected by the
    // compiled parameter schema, before the calendar arithmetic runs.
    await assert.rejects(() => definition.execute({ range: 'quarter' }, {}), ToolArgsError)
    await assert.rejects(() => definition.execute({ days: 'three' }, {}), ToolArgsError)
    // `presentCall`/`presentResult` stay silent for an invalid call rather than
    // rendering a card for arguments that could never run.
    assert.equal(definition.presentCall({ range: 'quarter' }), undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
