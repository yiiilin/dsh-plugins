import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { createScope, bindScopeParent } from '@deepseek-ai/dsh-scope'
import { Session } from '@deepseek-ai/dsh-session'
import { installSessionMode } from '../runtime.js'

// The other session-mode tests register their Team fixtures on the PRESET
// layer. The real plugin registers through `agent.ctx` — the agent's OWN layer,
// which `tools.restrict()` deliberately exempts — so only a test that installs
// the actual plugin exercises the registration route that decides whether a
// restricted Lead can spawn teammates at all. The dependency is an
// experimental DSH bundle, so skip rather than fail where it is absent.
const teamTool = await import('@deepseek-ai/dsh-experimental-tool-agent-team').catch(() => undefined)
const skip = teamTool === undefined ? 'experimental agent-team tool plugin is not installed' : false

/** Minimal stand-in for TeamService with the members the tool plugin touches. */
function teamService(calls) {
  const member = (name) => ({ target: name, role: 'teammate', status: 'provisioning', diagnostics: [] })
  const task = (subject) => ({
    id: '1', revision: 1, subject, description: 'd', status: 'pending',
    blockedBy: [], writeScopes: [], ready: true, writeScopeWarnings: [],
  })
  return {
    tryMembership: (agent) => (agent?.id === 'main' ? { root: agent, id: 'team', role: 'lead', name: 'lead' } : undefined),
    spawnTeammate: async (_caller, request) => { calls.push(request.name); return { member: member(request.name) } },
    // Output shapes must satisfy each tool's declared schema, or the tool
    // result layer reports an invalid-output error that would masquerade as a
    // permission denial in the assertions below.
    sendMessage: async () => ({ messageId: 'msg-1', status: 'accepted' }),
    listMembers: () => [{ target: 'lead', role: 'lead', status: 'inactive', diagnostics: [] }],
    createTask: async (_caller, request) => task(request.subject),
    listTasks: () => [],
    getTask: () => task('s'),
    updateTask: async () => task('s'),
    waitForChange: async () => ({ kind: 'timeout' }),
    interrupt: () => ({ previousStatus: 'inactive' }),
  }
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mode-team-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context()
  new SystemPrompt(ctx, { includeHarnessIdentity: false })
  new ToolRuntime(ctx)
  const agents = new Map(), calls = []
  ctx.provide('agents', { get: (id) => agents.get(id), list: () => [...agents.values()] })
  ctx.provide('commands', { register() { return () => {} } })
  ctx.provide('connection', { fetch: { register() { return () => {} } } })
  ctx.provide('sessionController', {})
  ctx.provide('sessions', { async flush() { return true } })
  ctx.provide('jobs', { list: () => [] })
  ctx.provide('ptcRuntime', { language: 'typescript' })
  ctx.provide('agentTeams', teamService(calls))

  const runtime = await installSessionMode(ctx, { stateDir: join(directory, 'policy') })
  const define = (name) => defineTool({
    name, description: name, parameters: {},
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: name }] },
    async execute() { return name },
  })
  const presetKey = {}
  const preset = createScope(ctx, presetKey)
  t.after(() => preset.dispose())
  // Preset-plane capabilities the mode withholds or allows.
  for (const name of ['bash', 'edit', 'write', 'read', 'subagent']) preset.ctx.tools.register(define(name))

  const agent = { id: 'main', options: {}, status: 'idle', session: Session.create('main', [], { type: 'session', version: 4, id: 'main', createdAt: 0, isSeeded: false }) }
  const scope = createScope(ctx, agent)
  agent.ctx = scope.ctx
  t.after(() => scope.dispose())
  bindScopeParent(agent, presetKey)
  agents.set('main', agent)

  // The real plugin, installed into this agent scope exactly as production does.
  await ctx.plugin(teamTool, {})
  await new Promise((resolve) => setTimeout(resolve, 50))
  await runtime.attach(agent)
  const call = (name, args = {}) => ctx.tools.execute({ agent, name, arguments: args, callId: `c-${name}`, signal: new AbortController().signal })
  return { ctx, runtime, agent, call, calls }
}

test('the real Agent Teams plugin stays callable for a restricted Lead', { skip }, async (t) => {
  const { ctx, runtime, agent, call, calls } = await fixture(t)
  await runtime.set(agent, 'delegate-writes', 0)

  const spawn = await call('spawn_teammate', { name: 'worker-a', description: 'probe', prompt: 'do work' })
  assert.equal(spawn.isError, false, String(spawn.content?.[0]?.text))
  assert.deepEqual(calls, ['worker-a'], 'the real spawn body must actually run')

  // The wider Team surface is reachable too, and stays in the wire catalog.
  // Each call uses that tool's own required parameters.
  assert.equal((await call('list_agents')).isError, false, 'list_agents')
  assert.equal((await call('send_message', { target: 'worker-a', message: 'status?' })).isError, false, 'send_message')
  assert.equal((await call('team_task_create', { subject: 's', description: 'd' })).isError, false, 'team_task_create')
  const visible = ctx.tools.schemas(agent).map((tool) => tool.name)
  assert.ok(visible.includes('spawn_teammate'), 'own-layer Team tool must survive pruning')

  // Withheld workspace tools are gone from the catalog AND refused on call.
  assert.ok(!visible.includes('write'), 'withheld tool must leave the catalog')
  assert.equal((await call('write')).isError, true)
})

// Control: the same plugin, same fixture, unrestricted. This pins that the
// assertions above measure the session-mode policy and not some artifact of
// installing the real plugin.
test('the same real plugin denies nothing under normal mode', { skip }, async (t) => {
  const { ctx, agent, call, calls } = await fixture(t)
  assert.equal((await call('write')).isError, false)
  assert.equal((await call('spawn_teammate', { name: 'worker-b', description: 'd', prompt: 'p' })).isError, false)
  assert.deepEqual(calls, ['worker-b'])
  const visible = ctx.tools.schemas(agent).map((tool) => tool.name)
  assert.ok(visible.includes('write') && visible.includes('spawn_teammate'))
})
