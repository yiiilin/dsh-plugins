import { DEFAULT_ALLOWED_TOOLS, MODES, SESSION_ID, isWorker, modeError, promptFor, toolDenial } from './policy.js'
import { createPolicyStore, defaultStateDir } from './store.js'

export async function installSessionMode(ctx, config = {}, adapters = {}) {
  const store = adapters.store ?? createPolicyStore(config.stateDir || defaultStateDir(ctx.get?.('profileContext')))
  const records = new Map(), attached = new Map(), changing = new Set()
  const allowed = config.mainAllowedTools ?? DEFAULT_ALLOWED_TOOLS
  const defaultMode = config.defaultMode ?? 'normal'
  if (!MODES.includes(defaultMode)) throw modeError('invalid_mode', 'Invalid default session mode')
  const activeJobs = (id) => (ctx.jobs?.list(id) ?? []).some((job) => String(job.owner) === id && ['running', 'stopping'].includes(job.status))
  const assertSupported = async (agent, mode) => {
    if (mode !== 'delegate-writes' || isWorker(agent)) return
    const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent, sessionModeProbe: true })
    const names = assembly.tools.map((tool) => tool.name)
    if (!['subagent', 'subagent_fork'].some((name) => names.includes(name) && allowed.includes(name))) {
      throw modeError('unsupported', 'delegate-writes requires a directly callable native subagent or subagent_fork tool')
    }
  }

  const attach = async (agent) => {
    const id = String(agent.session.id)
    let policy = await store.read(id)
    if (!policy) {
      const parentId = agent.session.header.parentSession
      const parent = parentId ? records.get(String(parentId)) ?? await store.read(String(parentId)) : undefined
      policy = await store.ensure(id, parent?.mode ?? defaultMode)
    }
    await assertSupported(agent, policy.mode)
    records.set(id, policy)
    attached.set(id, agent)
  }
  const read = (agent) => {
    const id = String(agent.session.id), policy = records.get(id)
    if (!policy) throw modeError('unavailable', 'Session mode policy is unavailable')
    return { v: 1, sessionId: id, mode: policy.mode, revision: policy.revision, worker: isWorker(agent), busy: agent.status !== 'idle' || changing.has(id) }
  }
  const set = async (agent, mode, revision) => {
    if (!MODES.includes(mode)) throw modeError('invalid_mode', 'Use normal or delegate-writes')
    if (isWorker(agent)) throw modeError('worker', 'Only the user of a main session can change its mode')
    const id = String(agent.session.id)
    if (attached.get(id) !== agent) throw modeError('unavailable', 'Session mode policy is unavailable')
    const checkIdle = () => {
      if (agent.status !== 'idle' || ctx.agents.get(id) !== agent || activeJobs(id)) throw modeError('busy', 'Wait until the session and its background jobs are idle before changing its mode')
    }
    checkIdle()
    if (changing.has(id)) throw modeError('busy', 'A session mode change is already in progress')
    changing.add(id)
    try {
      await assertSupported(agent, mode)
      checkIdle()
      const current = records.get(id)
      if (await ctx.sessions.flush(agent.session) !== true) {
        throw modeError('persistence_unavailable', 'Session mode changes require durable session storage')
      }
      checkIdle()
      const next = await store.set(id, mode, revision ?? current.revision, checkIdle)
      records.set(id, next)
      return { ...read(agent), busy: false }
    } catch (error) {
      if (error.code === 'conflict') {
        const latest = await store.read(id)
        if (latest) records.set(id, latest)
      }
      throw error
    } finally {
      changing.delete(id)
    }
  }
  const runtime = { attach, read, set }

  ctx.effect(() => ctx.tools.guard((exec) => {
    const id = exec.agent ? String(exec.agent.session.id) : undefined
    if (changing.has(id)) return 'Session mode is changing; retry after it settles.'
    return toolDenial(records.get(id), exec.agent, exec.name, allowed)
  }), 'session-mode: execution policy')
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'yiln:session-mode', order: 650, interpolate: false,
    text: ({ agent, sessionModeProbe }) => {
      if (!agent || sessionModeProbe === true) return ''
      const id = String(agent.session.id)
      if (changing.has(id)) throw modeError('busy', 'Session mode is changing')
      return promptFor(records.get(id), agent, config)
    },
  }), 'session-mode: system instructions')
  ctx.on('agent/created', ({ agent }) => attach(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    const id = String(agent.session.id)
    if (attached.get(id) !== agent) return
    attached.delete(id)
    records.delete(id)
  })
  for (const agent of ctx.agents.list()) await attach(agent)

  ctx.effect(() => ctx.commands.register({
    name: 'agent-mode',
    description: 'Turn delegated writes on or off for this session.',
    recordInput: true,
    handler: async ({ agent, rawInput }) => {
      try {
        const input = String(rawInput ?? '').trim().toLowerCase()
        const alias = { on: 'delegate-writes', off: 'normal', yes: 'delegate-writes', no: 'normal' }
        if (input === '' || input === 'status') {
          const value = read(agent)
          const state = value.mode === 'delegate-writes' ? 'on' : 'off'
          return { kind: 'success', text: `Delegated writes: ${state} (${value.mode})${value.worker ? ' — worker, fixed at creation' : ''}` }
        }
        if (!MODES.includes(alias[input] ?? input)) {
          return { kind: 'error', text: 'Usage: /agent-mode on | off | status' }
        }
        const value = await set(agent, alias[input] ?? input)
        const state = value.mode === 'delegate-writes' ? 'on' : 'off'
        return { kind: 'success', text: `Delegated writes: ${state}` }
      } catch (error) {
        return { kind: 'error', text: error.message }
      }
    },
  }), 'session-mode: user command')

  installRoute(ctx, runtime, store, defaultMode)
  return runtime
}

function decode(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== 1 || typeof value.sessionId !== 'string' || !SESSION_ID.test(value.sessionId)
    || !['read', 'set'].includes(value.op)) return undefined
  const keys = value.op === 'read' ? ['v', 'op', 'sessionId'] : ['v', 'op', 'sessionId', 'mode', 'revision']
  if (Object.keys(value).some((key) => !keys.includes(key))) return undefined
  if (value.op === 'set' && (!MODES.includes(value.mode) || !Number.isSafeInteger(value.revision) || value.revision < 0)) return undefined
  return value
}

function installRoute(ctx, runtime, store, defaultMode) {
  const failure = (code) => ({ ok: false, error: { code } })
  const handler = async (endpoint, payload, signal) => {
    const input = decode(payload)
    if (endpoint !== 'control' || !input) return failure('bad-request')
    if (signal?.aborted) return failure('aborted')
    try {
      let agent = ctx.agents.get(input.sessionId)
      if (input.op === 'set') {
        if (!agent) agent = (await ctx.sessionController.resolveAgent(input.sessionId)).agent
        if (!agent) throw modeError('unavailable', 'Session is unavailable')
        if (signal?.aborted) return failure('aborted')
        return { ok: true, value: await runtime.set(agent, input.mode, input.revision) }
      }
      if (agent) return { ok: true, value: runtime.read(agent) }
      // Cold reads must not activate an agent just to display a selector.
      const inspected = await ctx.sessionController.inspect(input.sessionId, signal)
      const policy = await store.read(input.sessionId)
      return { ok: true, value: { v: 1, sessionId: input.sessionId, mode: policy?.mode ?? defaultMode, revision: policy?.revision ?? 0, worker: inspected.meta.origin === 'subagent' || (inspected.meta.delegationDepth ?? 0) > 0, busy: false } }
    } catch (error) {
      return { ok: true, value: { v: 1, sessionId: input.sessionId, code: ['busy', 'worker', 'conflict', 'unavailable', 'unsupported'].includes(error.code) ? error.code : 'save_failed' } }
    }
  }
  ctx.effect(() => {
    if (!Reflect.has(ctx.connection, 'fetch')) {
      return ctx.connection.rpc.handle('/session-mode', handler, { authority: 'loopback' })
    }
    return ctx.connection.fetch.register({
      path: '/api/session-mode', methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          return new Response('Expected application/json', { status: 415 })
        }
        const raw = await request.text()
        if (Buffer.byteLength(raw) > 8192) return new Response('Request too large', { status: 413 })
        let body
        try { body = JSON.parse(raw) } catch { return new Response('Invalid JSON', { status: 400 }) }
        const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request'
        const valid = body?.type === 'client-request' && typeof body.rpcId === 'string' && body.method === 'session-mode' && Object.hasOwn(body, 'payload')
        const result = valid ? await handler('control', body.payload, request.signal) : failure('bad-request')
        return Response.json({ type: 'server-response', rpcId, result })
      },
    })
  }, 'session-mode: user control route')
}
