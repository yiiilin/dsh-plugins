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
  const workerResult = await call(worker)
  assert.equal(workerResult.isError, false)
  assert.equal(await readFile(join(directory, 'result.txt'), 'utf8'), 'write')
  assert.ok(renderPrompt(await ctx.systemPrompt.assemble({ scope: main, agent: main })).includes('delegate-system'))
  assert.ok(renderPrompt(await ctx.systemPrompt.assemble({ scope: worker, agent: worker })).includes('normal-system'))
  await runtime.set(main, 'normal', 1)
  assert.equal((await call(main)).isError, false)
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
