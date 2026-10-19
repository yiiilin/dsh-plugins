import assert from 'node:assert/strict'
import { mkdtemp, readFile, access, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import { installSessionMode } from '../runtime.js'

// Real Cordis scope resolution, tool dispatch, and prompt assembly; no model API.
test('actual DSH tools deny main writes but permit scoped child writes and dynamic prompts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mode-integration-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false })
  new ToolRuntime(ctx)
  const agents = new Map(), commands = new Map()
  ctx.provide('agents', { get: (id) => agents.get(id), list: () => [...agents.values()] })
  ctx.provide('commands', { register(definition) { commands.set(definition.name, definition); return () => commands.delete(definition.name) } })
  ctx.provide('connection', { fetch: { register() { return () => {} } } })
  ctx.provide('sessionController', {})
  ctx.provide('sessions', { async flush() { return true } })
  ctx.provide('jobs', { list: () => [] })
  ctx.provide('ptcRuntime', { language: 'typescript' })
  const runtime = await installSessionMode(ctx, { stateDir: join(directory, 'policy'), normalPrompt: 'normal-system', delegateWritesPrompt: 'delegate-system' })
  const presetKey = {}
  const preset = createScope(ctx, presetKey)
  const register = (name) => preset.ctx.tools.register(defineTool({
    name, description: `Fixture ${name}`, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { await writeFile(join(directory, 'result.txt'), name); return name },
  }))
  register('write')
  register('subagent')
  // Agent Teams coordination tools mutate only Team state, never the workspace,
  // so the restricted main agent must be able to call them.
  const teamCalls = []
  const registerTeam = (name) => preset.ctx.tools.register(defineTool({
    name, description: `Fixture ${name}`, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { teamCalls.push(name); return name },
  }))
  for (const name of ['spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']) registerTeam(name)
  const make = async (id, child = false) => {
    const agent = { id, options: {}, status: 'idle', session: Session.create(id, [], { type: 'session', version: 4, id, createdAt: 0, isSeeded: false, ...(child ? { parentSession: 'main', origin: 'subagent', delegationDepth: 1 } : {}) }) }
    const scope = createScope(ctx, agent, { parent: presetKey })
    agent.ctx = scope.ctx
    agents.set(id, agent)
    await runtime.attach(agent)
    t.after(() => scope.dispose())
    return agent
  }
  const main = await make('main')
  await runtime.set(main, 'delegate-writes', 0)
  const worker = await make('worker', true)
  const call = (agent) => ctx.tools.execute({ agent, name: 'write', arguments: {}, callId: `call-${agent.id}`, signal: new AbortController().signal })
  const denied = await call(main)
  assert.equal(denied.isError, true)
  await assert.rejects(() => access(join(directory, 'result.txt')))
  // The restricted main agent's WIRE CATALOG is pruned, not merely guarded: the
  // model never receives the schema for a withheld tool. `write`/`edit` are the
  // workspace-writing tools this mode exists to withhold; the preset-plane
  // `subagent` survives because it is on the audited allowlist.
  const mainWire = ctx.tools.schemas(main).map((tool) => tool.name)
  assert.ok(!mainWire.includes('write'), `withheld tool leaked into the catalog: ${mainWire.join(', ')}`)
  const workerWire = ctx.tools.schemas(worker).map((tool) => tool.name)
  assert.ok(workerWire.includes('write'), 'workers must keep the full catalog for inheritance')
  // The Team surface stays callable for the Leader while the mode is active.
  for (const name of ['spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']) {
    const result = await ctx.tools.execute({ agent: main, name, arguments: {}, callId: `team-${name}`, signal: new AbortController().signal })
    assert.equal(result.isError, false, name)
  }
  assert.deepEqual(teamCalls, ['spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update'])
  await assert.rejects(() => access(join(directory, 'result.txt')), 'Team tools must not touch the workspace')
  const workerResult = await call(worker)
  assert.equal(workerResult.isError, false)
  assert.equal(await readFile(join(directory, 'result.txt'), 'utf8'), 'write')
  assert.ok(renderPrompt(await ctx.systemPrompt.assemble({ scope: main, agent: main })).includes('delegate-system'))
  assert.ok(renderPrompt(await ctx.systemPrompt.assemble({ scope: worker, agent: worker })).includes('normal-system'))
  await runtime.set(main, 'normal', 1)
  assert.equal((await call(main)).isError, false)
  // Leaving the mode lifts the pruning, so the catalog is genuinely restored
  // rather than permanently narrowed for the rest of the session.
  assert.ok(ctx.tools.schemas(main).map((tool) => tool.name).includes('write'), 'normal mode must restore the catalog')
  const otherGuard = ctx.tools.guard(() => 'Another plugin denies this call')
  assert.equal((await call(main)).isError, true)
  otherGuard()
  const restorePresentation = main.ctx.tools.presentAs('ptc')
  assert.ok(ctx.tools.schemas(main).some((tool) => tool.name === 'subagent'))
  const ptcAssembly = await ctx.systemPrompt.assemble({ scope: main, agent: main })
  assert.deepEqual(ptcAssembly.tools.map((tool) => tool.name), ['run_code'])
  await assert.rejects(() => runtime.set(main, 'delegate-writes', 2), { code: 'unsupported' })
  restorePresentation()
  t.after(() => preset.dispose())
})

// The Agent Teams tool plugin registers through `agent.ctx`, i.e. the agent's
// OWN layer, which `tools.restrict()` deliberately exempts. Pruning must
// therefore intersect the audited names with the INHERITED surface: naming a
// Team tool in the allow list would either throw "unknown global tool" (when
// the scope does not inherit it) or be pointless (when it does). This test
// pins that own-layer Team tools survive pruning and that pruning does not
// throw when the allow list names tools the scope never inherited.
test('own-layer Team tools survive catalog pruning without an unknown-name throw', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mode-ownlayer-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false })
  new ToolRuntime(ctx)
  const agents = new Map()
  ctx.provide('agents', { get: (id) => agents.get(id), list: () => [...agents.values()] })
  ctx.provide('commands', { register() { return () => {} } })
  ctx.provide('connection', { fetch: { register() { return () => {} } } })
  ctx.provide('sessionController', {})
  ctx.provide('sessions', { async flush() { return true } })
  ctx.provide('jobs', { list: () => [] })
  ctx.provide('ptcRuntime', { language: 'typescript' })
  const runtime = await installSessionMode(ctx, { stateDir: join(directory, 'policy') })

  const define = (name) => defineTool({
    name, description: name, parameters: {},
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: name }] },
    async execute() { return name },
  })
  const presetKey = {}
  const preset = createScope(ctx, presetKey)
  t.after(() => preset.dispose())
  // Inherited (preset-plane) capabilities: shell plus the delegation surface.
  for (const name of ['bash', 'edit', 'write', 'read', 'subagent']) preset.ctx.tools.register(define(name))

  const agent = { id: 'main', options: {}, status: 'idle', session: Session.create('main', [], { type: 'session', version: 4, id: 'main', createdAt: 0, isSeeded: false }) }
  const scope = createScope(ctx, agent, { parent: presetKey })
  agent.ctx = scope.ctx
  t.after(() => scope.dispose())
  agents.set('main', agent)
  // Team tools land in the agent's OWN layer, exactly as the real plugin does.
  for (const name of ['spawn_teammate', 'send_message', 'team_task_create']) agent.ctx.tools.register(define(name))

  await runtime.attach(agent)
  // Must not throw even though the allow list names many absent tools.
  await runtime.set(agent, 'delegate-writes', 0)
  const visible = ctx.tools.schemas(agent).map((tool) => tool.name)
  for (const name of ['spawn_teammate', 'send_message', 'team_task_create']) {
    assert.ok(visible.includes(name), `own-layer Team tool ${name} must stay visible`)
  }
  assert.ok(visible.includes('subagent'), 'audited inherited delegation tool stays visible')
  for (const name of ['bash', 'edit', 'write']) {
    assert.ok(!visible.includes(name), `inherited write tool ${name} must be pruned`)
  }
  // The wire catalog the model actually receives is pruned too.
  const wire = (await ctx.systemPrompt.assemble({ scope: agent, agent })).tools.map((tool) => tool.name)
  assert.ok(!wire.includes('bash') && wire.includes('spawn_teammate'))
})
