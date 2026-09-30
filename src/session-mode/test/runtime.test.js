import assert from 'node:assert/strict'
import test from 'node:test'

async function harness({ saved = new Map(), config = {}, failWrite = false, legacy = false } = {}) {
  const { installSessionMode } = await import('../runtime.js')
  const agents = new Map(), commands = new Map(), listeners = new Map(), disposers = [], routes = []
  let guard, section
  const store = {
    async read(id) { return saved.get(id) },
    async ensure(id, mode) {
      if (!saved.has(id)) saved.set(id, { version: 1, sessionId: id, mode, revision: 0 })
      return saved.get(id)
    },
    async set(id, mode, revision, check) {
      check?.()
      if (failWrite) throw new Error('disk full')
      const old = saved.get(id)
      if (old.revision !== revision) throw Object.assign(new Error('conflict'), { code: 'conflict' })
      const next = { ...old, mode, revision: revision + 1 }
      saved.set(id, next)
      return next
    },
  }
  const ctx = {
    tools: { guard(fn) { guard = fn; return () => { guard = undefined } } },
    systemPrompt: { section(value) { section = value; return () => { section = undefined } }, async assemble() { return { tools: ctx.tools.schemas?.() ?? [{ name: 'subagent' }] } } },
    sessions: { async flush() { return true } },
    agents: { get(id) { return agents.get(id) }, list() { return [...agents.values()] } },
    commands: { register(value) { commands.set(value.name, value); return () => commands.delete(value.name) } },
    connection: legacy ? { rpc: { handle(path, handler) { routes.push({ path, handler }); return () => {} } } } : { fetch: { register(value) { routes.push(value); return () => {} } } },
    sessionController: { async resolveAgent(id) { return agents.has(id) ? { agent: agents.get(id) } : { error: {} } } },
    effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose },
    on(name, fn) { listeners.set(name, fn) },
  }
  const runtime = await installSessionMode(ctx, { normalPrompt: 'normal instructions', delegateWritesPrompt: 'coordinate instructions', ...config }, { store })
  const add = async (id, parent, depth = parent ? 1 : 0) => {
    const agent = { id, options: {}, status: 'idle', session: { id, header: { id, ...(parent ? { parentSession: parent, origin: 'subagent', delegationDepth: depth } : {}) } } }
    agents.set(id, agent)
    await listeners.get('agent/created')({ agent })
    return agent
  }
  return { ctx, store, add, runtime, saved, agents, commands, routes, listeners, get guard() { return guard }, get section() { return section }, async unload() { for (const fn of disposers.reverse()) await fn?.() } }
}

test('a mode change requires durable session metadata before committing its policy', async () => {
  const h = await harness(), main = await h.add('s')
  h.ctx.sessions = { async flush() { return false } }
  await assert.rejects(() => h.runtime.set(main, 'delegate-writes', 0), { code: 'persistence_unavailable' })
  assert.equal(h.runtime.read(main).mode, 'normal')
  let flushed = false
  h.ctx.sessions.flush = async () => { flushed = true; return true }
  const original = h.store.set
  h.store.set = (...args) => { assert.equal(flushed, true); return original(...args) }
  await h.runtime.set(main, 'delegate-writes', 0)
})

test('cold reads do not resume agents; writes resolve and attach the addressed main', async () => {
  const h = await harness()
  let resumed = 0
  h.ctx.sessionController.inspect = async () => ({ meta: { origin: undefined } })
  h.ctx.sessionController.resolveAgent = async (id) => { resumed += 1; return { agent: await h.add(id) } }
  const route = h.routes[0]
  const call = async (payload) => (await (await route.fetch(new Request('http://localhost/api/session-mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'session-mode', payload }) }))).json()).result
  const cold = await call({ v: 1, op: 'read', sessionId: 'cold' })
  assert.equal(cold.value.mode, 'normal')
  assert.equal(resumed, 0)
  assert.equal((await call({ v: 1, op: 'set', sessionId: 'cold', mode: 'delegate-writes', revision: 0 })).value.mode, 'delegate-writes')
  assert.equal(resumed, 1)
  assert.equal((await call({ v: 1, op: 'read', sessionId: 'cold' })).value.mode, 'delegate-writes')
  h.agents.delete('cold')
  assert.equal((await call({ v: 1, op: 'read', sessionId: 'cold' })).value.mode, 'delegate-writes')
})

test('legacy RPC rejects unsupported endpoints, aborted requests and unavailable sessions', async () => {
  const h = await harness({ legacy: true }), main = await h.add('s')
  const route = h.routes[0]
  const input = { v: 1, op: 'read', sessionId: 's' }
  assert.equal((await route.handler('wrong', input)).ok, false)
  const aborted = new AbortController(); aborted.abort()
  assert.equal((await route.handler('control', input, aborted.signal)).ok, false)
  assert.equal((await route.handler('control', input)).value.mode, 'normal')
  assert.equal((await route.handler('control', { v: 1, op: 'set', sessionId: 'missing', mode: 'normal', revision: 0 })).value.code, 'unavailable')
  await h.listeners.get('agent/disposed')({ agent: { ...main } })
  assert.equal(h.runtime.read(main).mode, 'normal')
  await h.listeners.get('agent/disposed')({ agent: main })
  assert.throws(() => h.runtime.read(main), { code: 'unavailable' })
  await assert.rejects(() => h.runtime.set(main, 'normal'), { code: 'unavailable' })
  assert.equal(h.section.text({}), '')
})

test('commands speak switch states and accept on/off aliases', async () => {
  const h = await harness(), main = await h.add('s')
  const command = h.commands.get('agent-mode')
  assert.ok((await command.handler({ agent: main, rawInput: 'status' })).text.includes('off'), 'a fresh session reports off')
  assert.ok((await command.handler({ agent: main, rawInput: 'on' })).text.includes('on'))
  assert.equal(h.runtime.read(main).mode, 'delegate-writes', 'on maps to delegate-writes')
  assert.ok((await command.handler({ agent: main, rawInput: 'off' })).text.includes('off'))
  assert.equal(h.runtime.read(main).mode, 'normal', 'off maps back to normal')
  assert.ok((await command.handler({ agent: main, rawInput: 'yes' })).text.includes('on'))
  assert.ok((await command.handler({ agent: main, rawInput: 'no' })).text.includes('off'))
  assert.equal((await command.handler({ agent: main, rawInput: 'other' })).kind, 'error')
  const child = await h.add('child', 's')
  assert.ok((await command.handler({ agent: child, rawInput: '' })).text.includes('worker'))
  await assert.rejects(() => harness({ config: { defaultMode: 'other' } }), { code: 'invalid_mode' })
})

test('HTTP route rejects oversized, malformed and non-JSON requests before control admission', async () => {
  const h = await harness(), route = h.routes[0]
  const raw = (body, type = 'application/json') => new Request('http://localhost/api/session-mode', { method: 'POST', headers: { 'content-type': type }, body })
  assert.equal((await route.fetch(raw('{}', 'text/plain'))).status, 415)
  assert.equal((await route.fetch(raw('{broken'))).status, 400)
  assert.equal((await route.fetch(raw(' '.repeat(8193)))).status, 413)
  assert.equal((await (await route.fetch(raw('{}'))).json()).result.ok, false)
  for (const payload of [null, [], { v: 2, op: 'read', sessionId: 's' }, { v: 1, op: 'unknown', sessionId: 's' }, { v: 1, op: 'read', sessionId: 's', other: true }, { v: 1, op: 'set', sessionId: 's', mode: 'other', revision: 0 }, { v: 1, op: 'set', sessionId: 's', mode: 'normal', revision: -1 }]) {
    const response = await route.fetch(raw(JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'session-mode', payload })))
    assert.equal((await response.json()).result.ok, false)
  }
})

test('active background jobs and PTC-only presets cannot switch into delegate-writes', async () => {
  const h = await harness(), main = await h.add('s')
  h.ctx.jobs = { list: () => [{ owner: 's', status: 'running' }] }
  await assert.rejects(() => h.runtime.set(main, 'delegate-writes', 0), { code: 'busy' })
  h.ctx.jobs.list = () => []
  h.ctx.tools.schemas = () => [{ name: 'run_code' }]
  await assert.rejects(() => h.runtime.set(main, 'delegate-writes', 0), { code: 'unsupported' })
  assert.equal(h.runtime.read(main).mode, 'normal')
})

test('permission and prompt cannot be used while a policy write is pending', async () => {
  const h = await harness(), main = await h.add('s')
  let release, entered
  const writing = new Promise((resolve) => { entered = resolve })
  const original = h.store.set
  h.store.set = async (...args) => {
    await new Promise((resolve) => { release = resolve; entered() })
    return original(...args)
  }
  const pending = h.runtime.set(main, 'delegate-writes', 0)
  await writing
  assert.equal(typeof h.guard({ agent: main, name: 'write' }), 'string')
  assert.throws(() => h.section.text({ agent: main }), { code: 'busy' })
  await assert.rejects(() => h.runtime.set(main, 'normal', 0), { code: 'busy' })
  release()
  await pending
  assert.equal(h.runtime.read(main).mode, 'delegate-writes')
})

test('HTTP mode control requires an explicit string session identity', async () => {
  const h = await harness()
  const route = h.routes[0]
  let attempts = 0
  h.ctx.sessionController.resolveAgent = async () => { attempts += 1; return { error: {} } }
  for (const id of [undefined, null, 123]) {
    const response = await route.fetch(new Request('http://localhost/api/session-mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'r', method: 'session-mode', payload: { v: 1, op: 'set', sessionId: id, mode: 'normal', revision: 0 } }) }))
    assert.equal((await response.json()).result.ok, false)
  }
  assert.equal(attempts, 0)
})

test('session switches update permission and prompt together without affecting another session', async () => {
  const h = await harness()
  const first = await h.add('first'), second = await h.add('second')
  assert.equal(h.runtime.read(first).mode, 'normal')
  await h.runtime.set(first, 'delegate-writes', 0)
  assert.equal(typeof h.guard({ agent: first, name: 'write' }), 'string')
  assert.equal(h.guard({ agent: second, name: 'write' }), undefined)
  assert.equal(h.section.text({ agent: first }), 'coordinate instructions')
  assert.equal(h.section.text({ agent: second }), 'normal instructions')
})

test('spawn and resumed workers retain their creation mode after parent changes', async () => {
  const h = await harness()
  const main = await h.add('main')
  await h.runtime.set(main, 'delegate-writes', 0)
  const child = await h.add('child', 'main')
  assert.equal(h.runtime.read(child).mode, 'delegate-writes')
  assert.equal(h.guard({ agent: child, name: 'write' }), undefined)
  assert.ok(h.section.text({ agent: child }).includes('normal instructions'))
  assert.ok(!h.section.text({ agent: child }).includes('coordinate instructions'))
  await h.runtime.set(main, 'normal', 1)
  const restored = await harness({ saved: h.saved })
  const cold = await restored.add('child', 'main')
  assert.equal(restored.runtime.read(cold).mode, 'delegate-writes')
  await assert.rejects(() => restored.runtime.set(cold, 'normal', 0), { code: 'worker' })
})

test('busy sessions, stale revisions and invalid modes cannot switch', async () => {
  const h = await harness(), main = await h.add('s')
  main.status = 'running'
  await assert.rejects(() => h.runtime.set(main, 'delegate-writes', 0), { code: 'busy' })
  main.status = 'idle'
  await assert.rejects(() => h.runtime.set(main, 'other', 0), { code: 'invalid_mode' })
  await h.runtime.set(main, 'delegate-writes', 0)
  await assert.rejects(() => h.runtime.set(main, 'normal', 0), { code: 'conflict' })
  assert.equal(typeof h.guard({ agent: main, name: 'write' }), 'string')
})

test('failed mode save preserves restricted permission and prompt', async () => {
  const saved = new Map([['s', { version: 1, sessionId: 's', mode: 'delegate-writes', revision: 1 }]])
  const h = await harness({ saved, failWrite: true }), main = await h.add('s')
  await assert.rejects(() => h.runtime.set(main, 'normal', 1), /disk full/)
  assert.equal(typeof h.guard({ agent: main, name: 'write' }), 'string')
  assert.equal(h.section.text({ agent: main }), 'coordinate instructions')
})

test('user command is not an agent tool, and unload removes policy registrations', async () => {
  const h = await harness(), main = await h.add('s')
  const result = await h.commands.get('agent-mode').handler({ agent: main, rawInput: 'delegate-writes' })
  assert.equal(result.kind, 'success')
  assert.equal(h.runtime.read(main).mode, 'delegate-writes')
  await h.unload()
  assert.equal(h.guard, undefined)
  assert.equal(h.section, undefined)
  assert.equal(h.commands.has('agent-mode'), false)
})

test('HTTP session control rejects invalid envelopes and returns revision-checked save results', async () => {
  const h = await harness(), main = await h.add('s')
  const route = h.routes.find((value) => value.path === '/api/session-mode')
  const request = (payload) => new Request('http://localhost/api/session-mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'session-mode', payload }) })
  const changed = await route.fetch(request({ v: 1, op: 'set', sessionId: 's', mode: 'delegate-writes', revision: 0 }))
  const body = await changed.json()
  assert.equal(body.result.ok, true)
  assert.equal(body.result.value.mode, 'delegate-writes')
  const conflict = await (await route.fetch(request({ v: 1, op: 'set', sessionId: 's', mode: 'normal', revision: 0 }))).json()
  assert.equal(conflict.result.value.code, 'conflict')
  const invalid = await (await route.fetch(request({ v: 1, op: 'set', sessionId: '../bad', mode: 'normal', revision: 1 }))).json()
  assert.equal(invalid.result.ok, false)
  assert.equal(h.runtime.read(main).mode, 'delegate-writes')
})
