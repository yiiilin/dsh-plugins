/**
 * Tests for the three agent tools that manage browser instances.
 *
 * Every test drives the tools the way an agent does — through a real
 * `ToolRuntime` mounted with the actual plugin — so the registration path,
 * argument validation and error results are the ones production uses, not a
 * hand-called copy. The instance table is the real one, wired to a fake backend,
 * so nothing here needs Xephyr, Chromium or x11vnc.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'

import { apply, inject, name } from '../index.js'
import { INSTANCE_STATES, createInstanceRegistry } from '../instances.js'

const SESSIONS_PATH = '/_dsh/desktop-vnc/sessions'

/** A clock the test advances by hand, so timestamps are known literals. */
function fakeClock(startMs = 1_000_000) {
  const clock = { ms: startMs }
  clock.now = () => clock.ms
  return clock
}

/** A backend that starts cleanly and records that it was disposed. */
function fakeBackend({ display = ':200', port = 5900 } = {}) {
  const calls = { ensure: 0, dispose: 0 }
  return {
    calls,
    browser: {
      ensure: async () => {
        calls.ensure += 1
        return { ok: true, display }
      },
      status: () => ({ display, running: true, xephyr: true, chromium: true, mode: 'xephyr', degraded: false, pids: {} }),
      stop: async () => {},
    },
    vnc: {
      ensure: async () => ({ running: true, port }),
      status: () => ({ running: true, port }),
      display: () => display,
      setDisplay: () => display,
      setAuthority: () => undefined,
      stop: async () => {},
    },
    capture: {
      setDisplay: () => display,
      setAuthority: () => undefined,
      capture: async () => Buffer.alloc(0),
    },
    dispose: async () => {
      calls.dispose += 1
    },
  }
}

/**
 * Mount the real plugin with a real instance table and a real tool runtime.
 *
 * `webServer` is the only fake: it records the HTTP routes and the per-instance
 * upgrade routes, which is how the tests see the plugin's own bookkeeping.
 *
 * @returns {Promise<object>} the context, table, recorded routes and an agent call helper.
 */
async function mount(t, { ports = [5900, 5901], prepareDisplay } = {}) {
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false })
  new ToolRuntime(ctx)
  // subprocess and fs are only read by the browser stack, which the fake backend replaces.
  ctx.provide('subprocess', {})
  ctx.provide('fs', {})
  const routes = []
  const upgrades = []
  ctx.provide('webServer', {
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index !== -1) routes.splice(index, 1)
      }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => {
        const index = upgrades.indexOf(route)
        if (index !== -1) upgrades.splice(index, 1)
      }
    },
    getOrigin: () => 'http://127.0.0.1:3080',
  })

  const clock = fakeClock()
  const registry = createInstanceRegistry({
    createBackend: (context) => fakeBackend({ display: ':200', port: context.port }),
    prepareDisplay: prepareDisplay ?? (async () => ({ display: ':200' })),
    ports,
    viewport: { width: 1280, height: 800 },
    now: clock.now,
    log: () => {},
  })

  const fiber = ctx.plugin({ name, inject, apply }, { instanceRegistry: registry })
  await fiber
  t.after(() => fiber.dispose())

  const agent = { id: 'main', session: { id: 'session-1' } }
  let calls = 0
  const call = (tool, args = {}) => {
    calls += 1
    return ctx.tools.execute({
      agent,
      name: tool,
      arguments: args,
      callId: `call-${calls}`,
      signal: new AbortController().signal,
    })
  }
  const created = async (ownerSessionId = 'session-1') => {
    const instance = registry.create({ ownerSessionId })
    await registry.get(instance.id).ready
    return instance
  }

  return { ctx, registry, routes, upgrades, call, created, fiber }
}

test('browser_instance_list reports an empty table as an empty array', async (t) => {
  const { call } = await mount(t)

  const result = await call('browser_instance_list')

  assert.equal(result.isError, false)
  assert.deepEqual(result.value, [])
})

test('browser_instance_list returns every browser instance as a frozen row', async (t) => {
  const { call, created } = await mount(t)
  const first = await created('session-1')
  const second = await created(null)

  const result = await call('browser_instance_list')

  assert.equal(result.isError, false)
  // Known literals, not a recomputation of the table's own projection: the id is
  // the one create() answered, the timestamps are the fake clock in whole
  // seconds, and the owner of the second instance was never set.
  assert.deepEqual(result.value, [
    {
      id: first.id,
      state: 'ready',
      width: 1280,
      height: 800,
      createdAt: 1000,
      ownerSessionId: 'session-1',
      lastActiveAt: 1000,
      viewers: 0,
    },
    {
      id: second.id,
      state: 'ready',
      width: 1280,
      height: 800,
      createdAt: 1000,
      ownerSessionId: null,
      lastActiveAt: 1000,
      viewers: 0,
    },
  ])
})

test('browser_instance_list reports a failed instance instead of refusing the whole table', async (t) => {
  // A boot that failed is exactly when the list matters most: it is the only
  // surface that says *why*. An output schema that rejects the conditional
  // `error` field would make the tool throw and hand the agent no rows at all.
  const { call, created } = await mount(t, {
    prepareDisplay: async () => ({ error: 'Xephyr 未安装（Xephyr not installed）' }),
  })
  const failed = await created('session-1')

  const result = await call('browser_instance_list')

  assert.equal(result.isError, false, 'a failed row must not cost the caller the whole list')
  assert.equal(result.value.length, 1)
  assert.equal(result.value[0].id, failed.id)
  assert.equal(result.value[0].state, 'failed')
  assert.match(result.value[0].error, /Xephyr 未安装/u)
})

test('browser_instance_list returns a failed row next to a healthy one', async (t) => {
  // One bad row must not hide the good ones either: the table is the address
  // book, so a single failure cannot take the reachable instances off it.
  const failures = { remaining: 0 }
  const { call, created } = await mount(t, {
    prepareDisplay: async () => (failures.remaining > 0
      ? { error: 'chromium exited during startup' }
      : { display: ':200' }),
  })
  const healthy = await created('session-1')
  failures.remaining += 1
  const failing = await created('session-2')

  const result = await call('browser_instance_list')

  assert.equal(result.isError, false)
  assert.deepEqual(result.value.map((row) => row.id), [healthy.id, failing.id])
  assert.equal(result.value[0].state, 'ready')
  assert.equal(result.value[1].state, 'failed')
  assert.equal(result.value[1].error, 'chromium exited during startup')
})

test('the list schema admits exactly the states the table can report', async (t) => {
  // The tool schema and the table must not drift: a state the table starts
  // reporting would make every list call fail with "not one of the allowed
  // values", and a state the schema allows but the table never emits is a
  // promise to the model that nothing keeps.
  const { ctx } = await mount(t)
  const schema = ctx.tools.get('browser_instance_list').output.schema

  assert.deepEqual(schema.items.properties.state.enum, INSTANCE_STATES)
})

test('browser_instance_create answers with the new id and the starting state', async (t) => {
  const { call } = await mount(t)

  const result = await call('browser_instance_create', {})

  assert.equal(result.isError, false)
  // The instance is addressable the moment create answers, before its stack is up.
  assert.equal(result.value.state, 'starting')
  assert.match(result.value.id, /^[0-9a-f]{8}$/u)
  assert.deepEqual(Object.keys(result.value).sort(), ['id', 'state'])
})

test('browser_instance_create records the owning session given by the caller', async (t) => {
  const { call, registry } = await mount(t)

  const result = await call('browser_instance_create', { ownerSessionId: 'session-42' })

  assert.equal(result.isError, false)
  // 实例归属 is decided at creation and readable from the table the list reports.
  assert.equal(registry.get(result.value.id).ownerSessionId, 'session-42')
})

test('browser_instance_create defaults the owner to the calling session', async (t) => {
  const { call, registry } = await mount(t)

  const result = await call('browser_instance_create', {})

  // An agent does not reliably know its own session id, so the executing session
  // is the truthful default owner: that is what makes session/disposed collect it.
  assert.equal(registry.get(result.value.id).ownerSessionId, 'session-1')
})

test('browser_instance_create mounts a viewer route for the instance it made', async (t) => {
  const { call, upgrades } = await mount(t)
  const before = upgrades.length

  const result = await call('browser_instance_create', {})

  assert.equal(result.isError, false)
  // Upgrade dispatch is an exact path lookup, so an instance created through the
  // tool must get its own route; calling the registry directly would not.
  assert.equal(upgrades.length, before + 1)
  assert.equal(upgrades[upgrades.length - 1].path, `${SESSIONS_PATH}/${result.value.id}/ws`)
})

test('browser_instance_close closes exactly the instance named', async (t) => {
  const { call, registry, upgrades } = await mount(t)
  // Created through the tool, so each instance also gets its viewer route on top
  // of the v1-compatible `ws` route the plugin always has.
  const baseline = upgrades.length
  const target = (await call('browser_instance_create', {})).value
  const other = (await call('browser_instance_create', {})).value
  assert.equal(upgrades.length, baseline + 2)

  const result = await call('browser_instance_close', { id: target.id })

  assert.equal(result.isError, false)
  assert.deepEqual(result.value, { closed: true })
  assert.equal(registry.get(target.id), undefined, 'the named instance must be gone')
  assert.notEqual(registry.get(other.id), undefined, 'no other instance may be closed in its place')
  assert.deepEqual(registry.list().map((row) => row.id), [other.id])
  // The closed instance's viewer route is released too, so a stale path cannot answer.
  assert.equal(upgrades.length, baseline + 1)
})

test('browser_instance_close refuses an id that does not exist', async (t) => {
  const { call, registry, created } = await mount(t)
  const existing = await created('session-1')

  const result = await call('browser_instance_close', { id: 'deadbeef' })

  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /no such browser instance: deadbeef/u)
  // The failure must leave the table exactly as it was: no fallback close, no new
  // instance created on the caller's behalf.
  assert.notEqual(registry.get(existing.id), undefined)
  assert.deepEqual(registry.list().map((row) => row.id), [existing.id])
})

test('browser_instance_close refuses an id that is not an instance id', async (t) => {
  const { call, registry, created } = await mount(t)
  const existing = await created('session-1')

  // A path-looking or truncated id is not a browser instance id: guessing a
  // prefix would let an agent close an instance it did not name.
  const result = await call('browser_instance_close', { id: '../sessions' })

  assert.equal(result.isError, true)
  assert.deepEqual(registry.list().map((row) => row.id), [existing.id])
})

test('the plugin registers exactly the three browser_instance tools', async (t) => {
  const { ctx } = await mount(t)

  const names = ctx.tools.schemas().map((schema) => schema.name).filter((tool) => tool.startsWith('browser_instance_'))

  assert.deepEqual(names.sort(), ['browser_instance_close', 'browser_instance_create', 'browser_instance_list'])
  // Focus is a per-client UI state, not an instance property: a server tool that
  // changed it would be modifying another client's screen, so it must not exist.
  assert.equal(ctx.tools.get('browser_instance_focus'), undefined)
})

test('the tools describe the id as the only way to name a browser instance', async (t) => {
  const { ctx } = await mount(t)
  const description = (tool) => ctx.tools.get(tool).description

  // The model reads these descriptions and nothing else, so the fallback rule has
  // to be stated where it will be read.
  assert.match(description('browser_instance_list'), /id/u)
  assert.match(description('browser_instance_create'), /browser instance id/u)
  assert.match(description('browser_instance_close'), /does not exist is an error/u)
  assert.match(description('browser_instance_close'), /no other instance is substituted/u)
})

test('the plugin still mounts and serves its routes when no tool registry exists', async () => {
  const ctx = new Context()
  ctx.provide('subprocess', {})
  ctx.provide('fs', {})
  const routes = []
  ctx.provide('webServer', {
    register(route) {
      routes.push(route)
      return () => {}
    },
    registerUpgrade: () => () => {},
    getOrigin: () => 'http://127.0.0.1:3080',
  })

  const fiber = ctx.plugin({ name, inject, apply }, { instanceRegistry: createInstanceRegistry({ createBackend: () => ({ dispose: async () => {} }) }) })
  await fiber

  // A panel-only profile has no tool registry; its routes must be unaffected.
  assert.equal(ctx.get('tools'), undefined)
  assert.ok(routes.some((route) => route.path === SESSIONS_PATH))
  await fiber.dispose()
})

test('every tool is released when the plugin unloads', async (t) => {
  const { ctx, fiber } = await mount(t)
  assert.notEqual(ctx.tools.get('browser_instance_list'), undefined)

  await fiber.dispose()

  assert.equal(ctx.tools.get('browser_instance_list'), undefined)
  assert.equal(ctx.tools.get('browser_instance_create'), undefined)
  assert.equal(ctx.tools.get('browser_instance_close'), undefined)
})

test('browser_instance_list and GET /sessions report the same table', async (t) => {
  const { call, routes, created } = await mount(t)
  await created('session-1')
  await created('session-2')

  const toolRows = (await call('browser_instance_list')).value
  const route = routes.find((candidate) => candidate.path === SESSIONS_PATH)
  const written = []
  await route.handler({ method: 'GET', url: SESSIONS_PATH, headers: {} }, {
    writeHead: (status, headers) => written.push([status, headers]),
    end: (body) => written.push(body),
    on: () => {},
  })
  const httpRows = JSON.parse(String(written[written.length - 1]))

  // One table, two surfaces: the agent tool and the panel must never disagree
  // about what exists or what state it is in.
  assert.deepEqual(toolRows, httpRows)
})

test('browser_instance_create reports an exhausted port pool instead of opening another browser', async (t) => {
  // No port left to claim: the failure has to reach the model as an error naming
  // the problem, because a silent reuse would show a different instance's desktop.
  const { call, registry } = await mount(t, { ports: [] })

  const result = await call('browser_instance_create', {})

  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /no free RFB port/u)
  assert.deepEqual(registry.list(), [], 'a failed create must not leave a row behind')
})

test('browser_instance_close without an id is refused before anything is closed', async (t) => {
  const { call, registry, created } = await mount(t)
  const existing = await created('session-1')

  const result = await call('browser_instance_close')

  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /missing required property "id"/u)
  assert.deepEqual(registry.list().map((row) => row.id), [existing.id], 'nothing may be closed when the id is absent')
})

test('the create description states ownership is fixed at creation', async (t) => {
  const { ctx } = await mount(t)
  const description = ctx.tools.get('browser_instance_create').description

  // 实例归属 is the reason `session/disposed` can collect exactly that session's
  // instances; a model that believes it can reassign it would create orphans.
  assert.match(description, /实例归属/u)
  assert.match(description, /fixed at creation and never reassigned/u)
})

test('the list description uses the glossary term for the id', async (t) => {
  const { ctx } = await mount(t)

  // The panel, the docs and the tools must speak of the same thing: 浏览器实例 id,
  // never an index, a number, or an external tool's instance name.
  assert.match(ctx.tools.get('browser_instance_list').description, /浏览器实例 id/u)
  assert.match(ctx.tools.get('browser_instance_close').description, /浏览器实例 id/u)
})
