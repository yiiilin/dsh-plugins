import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { installMentor, plainConfig } from '../lib/mentor.js'
import { projectJournal } from '../lib/journal.js'

test('exposes the Loader-visible plugin entry shape', async () => {
  // The Cordis Loader resolves a plugin with `exports.default ?? exports` and
  // then reads Config/inject/name off that value, so a default export would
  // hide the Config schema and leave every settings control read-only.
  const source = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  assert.equal(/^export default/mu.test(source), false)
  for (const declaration of ['export const name', 'export const inject', 'export const Config', 'export function apply']) {
    assert.equal(source.includes(declaration), true, `index.js must declare ${declaration}`)
  }
})

test('unwraps live-editable config wrappers before the runtime reads them', () => {
  assert.deepEqual(plainConfig({
    enabled: { get: () => true },
    provider: { get: () => 'mentor-route' },
    requestTimeoutMs: 1000,
    nested: { model: { get: () => 'mentor-model' } },
  }), {
    enabled: true,
    provider: 'mentor-route',
    requestTimeoutMs: 1000,
    nested: { model: 'mentor-model' },
  })
})

function createHarness({ requestTimeoutMs = 1000, replyText = 'Use the smallest discriminating test.', settingsReadOnly = false, volatileConfig = false, persistenceStyle = 'modern', toolSchemas = false, extraSystemBlock = false, mutateRenderedResults = false, waitForAbort = false, noAdapterOnce = false, emitAssistantStream = true, sharedFetch = false, strictMessageSource = false, sessionSystemMessage = false, profileProvider = 'mentor-route', profileModel = 'mentor-model' } = {}) {
  const listeners = new Map()
  const journalRows = new Map()
  const childRows = new Map()
  const commands = new Map()
  const rpcHandlers = new Map()
  const fetchRoutes = new Map()
  const handles = []
  const createdAgents = []
  const rootAgents = []
  const requests = []
  const flushes = []
  let providerCalls = 0
  let routeFailure = noAdapterOnce
  let providerStartedResolve
  const providerStarted = new Promise((resolve) => { providerStartedResolve = resolve })
  let tool
  let rootTool
  let globalToolRegistrations = 0
  let rootToolRegistrations = 0
  let parentAgent
  let inspectPause
  let currentAgent

  let idCounter = 0
  let turnCounter = 0

  const on = (event, listener) => {
    const values = listeners.get(event) ?? []
    values.push(listener)
    listeners.set(event, values)
  }
  const event = (target, type, data) => {
    const record = { seq: target.records.length, type, time: Date.now(), data }
    target.records.push(record)
    return record
  }
  const makeSession = (id, records = []) => ({
    id,
    header: { id },
    records: records.slice(),
    get seq() { return this.records.length },
    ownEvents() { return this.records.slice() },
    snapshotEvents() { return this.records.slice() },
    eventAt(seq) { return this.records.find((entry) => entry.seq === seq) },
    deriveMessages() {
      return this.records
        .filter((entry) => ['user/message', 'assistant/message', 'tool/result'].includes(entry.type)
          || (sessionSystemMessage && entry.type === 'system/message'))
        .map((entry) => entry.data.message ?? entry.data)
    },
    append(type, data) {
      if (strictMessageSource && type === 'user/message' && data?.source?.kind === 'plugin') {
        throw new TypeError('format v4 message requires a producer-owned source kind')
      }
      return event(this, type, data)
    },
  })



  function publishAgent(agent, parentAgent) {
    let handle
    handle = {
      agent,
      ownerId: parentAgent?.id,
      async dispose() {
        const index = handles.indexOf(handle)
        if (index >= 0) handles.splice(index, 1)
        for (const listener of listeners.get('agent/disposed') ?? []) listener({ agent })
      },
    }
    handles.push(handle)
    createdAgents.push(agent)
    if (parentAgent === undefined) rootAgents.push(agent)
    for (const listener of listeners.get('agent/created') ?? []) listener({ agent })
    return handle
  }

  const agents = {
    currentInitiator: () => currentAgent,
    get(id) { return handles.find((handle) => handle.agent.id === id)?.agent ?? rootAgents.find((agent) => agent.id === id) },
    isOwnedBy(id, owner) { return handles.some((handle) => handle.agent.id === id && handle.ownerId === owner.id) },
    roots() { return rootAgents.slice() },
    async create(options) {
      const session = makeSession(options.sessionId)
      const agent = makeAgent(session, options.agentOptions)
      await options.setup(agent.ctx)
      return publishAgent(agent, options.parentAgent)
    },
    async resume(options) {
      const session = makeSession(options.resumeSessionId, childRows.get(options.resumeSessionId) ?? [])
      const agent = makeAgent(session, options.agentOptions)
      await options.setup(agent.ctx)
      return publishAgent(agent, options.parentAgent)
    },
  }
  let activeParent

  function waterfall(name, args, terminal) {
    const chain = listeners.get(name) ?? []
    const invoke = (index) => index === chain.length
      ? terminal()
      : chain[index](...args, () => invoke(index + 1))
    return invoke(0)
  }

  function makeAgent(session, agentOptions) {
    const scoped = new Map()
    let turnController
    const scope = {
      listeners: scoped,
      prompt: [],
      toolRegistrations: 0,
      restrictions: [],
      guards: [],
      presentation: null,
      runtimeContextSuppressed: false,
    }
    const agent = {
      id: session.id,
      session,
      options: agentOptions,
      status: 'idle',
      scope,
      ctx: {
        agents,
        tools: {
          presentAs(mode) { scope.presentation = mode; return () => {} },
          restrict(filter) { scope.restrictions.push(filter); return () => {} },
          guard(guard) { scope.guards.push(guard); return () => {} },
          register(definition) { scope.tool = definition; scope.toolRegistrations += 1; return () => {} },
        },
        systemPrompt: {
          section(section) { scope.prompt.push(section); return () => {} },
          suppressRuntimeContext() { scope.runtimeContextSuppressed = true; return () => {} },
        },
        effect(factory) { return factory() },
        on(name, listener) {
          const values = scoped.get(name) ?? []
          values.push(listener)
          scoped.set(name, values)
        },
      },
      cancel(cause) {
        this.cancelCause = cause
        turnController?.abort(new Error('fake Agent cancelled'))
      },
      whenIdle() { return this.pending ?? Promise.resolve() },
      followup(message) {
        const turn = ++turnCounter
        turnController = new AbortController()
        this.status = 'running'
        this.pending = (async () => {
          let decision = { kind: 'enter', messages: [message, {
            id: `hidden-${turn}`,
            role: 'user',
            content: [{ type: 'text', text: 'unsubmitted workspace instructions' }],
            source: { kind: 'plugin', plugin: 'workspace-context' },
          }] }
          for (const listener of scoped.get('agent/pre-step') ?? []) {
            decision = await listener({ agent: this, messages: decision.messages, turn, step: 1 }, async () => decision)
          }
          session.append('turn/start', { turn })
          const fullPrompt = scope.prompt.find((item) => item.complete)?.text
          const systemMessage = {
            id: `system-${turn}`,
            role: 'system',
            source: { kind: 'system-prompt' },
            content: [
              { type: 'text', text: fullPrompt },
              ...(extraSystemBlock ? [{ type: 'reasoning', text: 'hidden instruction' }] : []),
            ],
          }
          if (sessionSystemMessage) session.append('system/message', { turn, step: 1, message: systemMessage })
          for (const input of decision.messages) session.append('user/message', input)
          for (const listener of scoped.get('agent/inbox/claimed') ?? []) listener({ agent: this, message, turn })
          const options = {
            provider: agentOptions.provider,
            model: agentOptions.model,
            reasoningEffort: agentOptions.reasoningEffort,
            maxTokens: agentOptions.maxTokens,
            system: undefined,
            tools: toolSchemas ? [{ name: 'bash', description: 'shell', parameters: {} }] : [],
            messages: sessionSystemMessage ? session.deriveMessages() : [systemMessage, ...session.deriveMessages()],
            purpose: undefined,
            sessionId: this.id,
            signal: turnController.signal,
          }
          requests.push(options)
          currentAgent = this
          try {
            const attemptId = `attempt-${turn}`
            if (emitAssistantStream) {
              for (const listener of scoped.get('agent/assistant-stream') ?? []) {
                listener({ agent: this, frame: { type: 'start', attemptId, turn, step: 1 } })
              }
            }
            const stream = waterfall('llm/stream', [options], () => (async function* () {
              providerStartedResolve()
              if (routeFailure) {
                routeFailure = false
                throw Object.assign(new Error('no adapter for mentor route'), { code: 'NO_ADAPTER' })
              }
              providerCalls += 1
              if (waitForAbort) {
                await new Promise((resolve, reject) => {
                  const onAbort = () => reject(options.signal.reason ?? new Error('request aborted'))
                  options.signal.addEventListener('abort', onAbort, { once: true })
                  if (options.signal.aborted) onAbort()
                })
              }
              yield { type: 'text-delta', index: 0, text: replyText }
              yield { type: 'finish', reason: { kind: 'stop' } }
            })())
            for await (const _chunk of stream) {}
            const assistantEvent = session.append('assistant/message', {
              turn,
              step: 1,
              usage: undefined,
              stream: [{ type: 'chunk', time: Date.now(), chunk: { type: 'finish', reason: { kind: 'stop' } } }],
              message: {
                id: `assistant-${turn}`,
                role: 'assistant',
                source: { kind: 'model', provider: agentOptions.provider, model: agentOptions.model },
                content: [{ type: 'text', text: replyText }],
              },
            })
            if (emitAssistantStream) {
              for (const listener of scoped.get('agent/assistant-stream') ?? []) {
                listener({ agent: this, frame: {
                  type: 'end',
                  attemptId,
                  outcome: { kind: 'committed', eventType: 'assistant/message', seq: assistantEvent.seq },
                } })
              }
            }
            session.append('turn/end', { turn, reason: { kind: 'completed' } })
          } finally {
            currentAgent = undefined
            this.status = 'idle'
          }
        })()
      },
    }
    return agent
  }

  const notFound = () => Object.assign(new Error('session not found'), { code: 'SESSION_NOT_FOUND' })
  const rowsFor = (id) => journalRows.get(id) ?? childRows.get(id)
  const modernPersistence = {
    async inspect(id) {
      if (inspectPause !== undefined) {
        const pause = inspectPause
        inspectPause = undefined
        pause.startedResolve()
        await pause.wait
      }
      const events = rowsFor(id)
      if (events === undefined) throw notFound()
      return { meta: { id }, events }
    },
    async load(id) {
      const events = rowsFor(id)
      if (events === undefined) throw notFound()
      return { meta: { id }, events }
    },
    async create(header) {
      if (journalRows.has(header.id)) throw new Error('already exists')
      journalRows.set(header.id, [])
    },
    async append(id, batch) {
      const values = journalRows.get(id)
      if (values === undefined) throw notFound()
      if (batch[0]?.seq !== values.length) throw new Error('bad journal sequence')
      values.push(...batch)
    },
  }
  const legacyHandle = (id, mode) => ({
    async read() {
      const events = rowsFor(id)
      if (events === undefined) throw notFound()
      return { meta: { id }, events: events.slice() }
    },
    async append(batch) {
      if (mode !== 'write') throw new Error('read-only handle')
      const values = journalRows.get(id)
      if (values === undefined || batch[0]?.seq !== values.length) throw new Error('bad journal sequence')
      values.push(...batch)
    },
    async flush() {},
    async close() {},
  })
  const legacyPersistence = {
    async open(id, mode) {
      if (rowsFor(id) === undefined) throw notFound()
      return legacyHandle(id, mode)
    },
    async create(header) {
      if (journalRows.has(header.id)) throw new Error('already exists')
      journalRows.set(header.id, [])
      return legacyHandle(header.id, 'write')
    },
  }
  const persistence = persistenceStyle === 'legacy' ? legacyPersistence : modernPersistence
  const parentSession = makeSession('parent-session')
  parentAgent = {
    id: parentSession.id,
    session: parentSession,
    ctx: {
      agents,
      tools: {
        register(definition) { rootTool = definition; tool = definition; rootToolRegistrations += 1; return () => {} },
      },
      systemPrompt: { section() { return () => {} } },
      effect(factory) { return factory() },
    },
  }
  rootAgents.push(parentAgent)
  const modelCatalog = {
    default: { provider: 'mentor-route', model: 'mentor-model', reasoningEffort: 'low' },
    routableProviders: ['mentor-route'],
    groups: [{
      id: 'mentor-route',
      name: 'Mentor Route',
      models: [
        { id: 'mentor-model', name: 'Mentor Model', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
        { id: 'mentor-model-fast', name: 'Mentor Model Fast', reasoning: { efforts: [{ id: 'minimal', name: 'Minimal' }, { id: 'medium', name: 'Medium' }], defaultEffort: 'minimal' } },
      ],
    }],
    failures: [],
  }
  const settingsRow = {
    enabled: true,
    provider: profileProvider,
    model: profileModel,
    reasoningEffort: '',
    requestTimeoutMs,
    globalConcurrency: 2,
  }
  const settingsUpdates = []
  const settingsPolicies = []
  const ctxFiber = Symbol('mentor-fiber')
  const settings = {
    writable: !settingsReadOnly,
    configure(presentation, fiber) {
      settingsPolicies.push({ presentation, fiber })
      return () => {}
    },
    describe() {
      return [{
        ns: 'dsh-mentor',
        autoGenerate: false,
        schema: {},
        revision: settingsUpdates.length,
        applies: 'live',
        value: { ...settingsRow },
      }]
    },
    ...(settingsReadOnly ? {} : {
      async update(ns, patch, expected) {
        if (ns !== 'dsh-mentor') throw new Error(`unknown settings namespace: ${ns}`)
        if (expected !== undefined && expected !== settingsUpdates.length) {
          throw Object.assign(new Error('settings changed since they were read'), { code: 'SETTINGS_CONFLICT' })
        }
        settingsUpdates.push({ ns, patch, expected })
        Object.assign(settingsRow, patch)
      },
    }),
  }
  const configEditor = { entries: () => [{ options: { id: 'dsh-mentor' }, fiber: ctxFiber }] }
  const ctx = {
    fiber: ctxFiber,
    agents,
    settings,
    configEditor,
    commands: {
      register(definition) { commands.set(definition.name, definition); return () => {} },
    },
    connection: {
      rpc: {
        handle(channel, handler) {
          rpcHandlers.set(channel, handler)
          return () => rpcHandlers.delete(channel)
        },
      },
      ...(sharedFetch ? {
        fetch: {
          register(route) {
            fetchRoutes.set(route.path, route)
            return () => fetchRoutes.delete(route.path)
          },
        },
      } : {}),
    },
    sessionController: { async modelCatalog() { return modelCatalog } },
    sessionPersistence: persistence,
    sessions: {
      async flush(session) {
        flushes.push(session.id)
        if (session.id !== parentSession.id) childRows.set(session.id, session.snapshotEvents())
        return true
      },
    },
    tools: {
      register(definition) { tool = definition; globalToolRegistrations += 1; return () => {} },
    },
    systemPrompt: { section(section) { ctx.globalPrompt = section; return () => {} } },
    logger: { warn() {}, info() {} },
    on,
    effect(factory) { factory() },
  }

  const installConfig = {
    enabled: true,
    provider: profileProvider,
    model: profileModel,
    requestTimeoutMs,
    globalConcurrency: 2,
  }
  // A live-editable row reaches apply() as lazy volatile wrappers.
  const asVolatile = (value) => volatileConfig && value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, { get: () => child }]))
    : value
  installMentor(ctx, asVolatile(installConfig), {
    defineTool: (definition) => definition,
    createUserMessage: (input) => ({ ...input, id: `input-${++idCounter}`, role: 'user' }),
    freezeMessage: (message) => message,
    lastAssistantStreamChunk: (stream, type) => stream?.findLast((record) => (record.chunk ?? record).type === type)?.chunk,
    sessionFormatVersion: 0,
    createId: (prefix) => `${prefix}${String(++idCounter).padStart(16, '0')}`,
  })

  return {
    ctx,
    tool: () => tool,
    commands,
    viewHandler: () => rpcHandlers.get('/mentor-view'),
    fetchRoutes,
    parentAgent,
    parentSession,
    rootTool: () => rootTool,
    globalToolRegistrations: () => globalToolRegistrations,
    rootToolRegistrations: () => rootToolRegistrations,
    handles,
    createdAgents,
    rootAgents,
    requests,
    providerCalls: () => providerCalls,
    providerStarted,
    pauseNextJournalRead() {
      let startedResolve
      let releaseWait
      const started = new Promise((resolve) => { startedResolve = resolve })
      const wait = new Promise((resolve) => { releaseWait = resolve })
      inspectPause = { startedResolve, wait }
      return { started, release: releaseWait }
    },
    flushes,
    journalRows,
    childRows,
    settingsUpdates: () => settingsUpdates,
    settingsPolicies: () => settingsPolicies,
    settingsRow: () => ({ ...settingsRow }),
    async invoke(args, callId = `call-${idCounter + 1}`, agent = parentAgent, signal = new AbortController().signal) {
      activeParent = agent
      const rawArgs = JSON.stringify(args)
      agent.session.append('tool/call', { turn: 1, step: 1, callId, name: 'mentor', arguments: rawArgs })
      let value
      try {
        value = await tool.execute(args, { agent, callId, signal })
      } catch (error) {
        agent.session.append('tool/result', {
          turn: 1,
          step: 1,
          error: { code: error.code ?? 'TEST', message: error.message },
          message: {
            id: `tool-result-${callId}`,
            role: 'user',
            source: { kind: 'tool', callId },
            content: [{ type: 'tool-result', toolCallId: callId, isError: true, content: [{ type: 'text', text: error.message }] }],
          },
        })
        await ctx.sessions.flush(agent.session)
        throw error
      }
      const rendered = tool.output.render(args, value)
      if (mutateRenderedResults) rendered[0].text = 'result content changed by post-execute policy'
      agent.session.append('tool/result', {
        turn: 1,
        step: 1,
        meta: tool.output.presentationMeta(args, value),
        message: {
          id: `tool-result-${callId}`,
          role: 'user',
          source: { kind: 'tool', callId },
          content: [{ type: 'tool-result', toolCallId: callId, content: rendered }],
        },
      })
      await ctx.sessions.flush(agent.session)
      return value
    },
    async invokeWithoutResult(args, callId, agent = parentAgent) {
      activeParent = agent
      agent.session.append('tool/call', { turn: 1, step: 1, callId, name: 'mentor', arguments: JSON.stringify(args) })
      return tool.execute(args, { agent, callId, signal: new AbortController().signal })
    },
    async appendUnknownToolOutcome(callId, agent = parentAgent) {
      agent.session.append('tool/result', {
        turn: 1,
        step: 1,
        error: { code: 'TOOL_OUTCOME_UNKNOWN', message: 'Interrupted before the tool result was saved.' },
        message: {
          id: `tool-result-${callId}`,
          role: 'user',
          source: { kind: 'tool', callId },
          content: [{ type: 'tool-result', toolCallId: callId, isError: true, content: [{ type: 'text', text: 'TOOL_OUTCOME_UNKNOWN' }] }],
        },
      })
      await ctx.sessions.flush(agent.session)
    },
    async invokePtc(args, callId, agent = parentAgent) {
      activeParent = agent
      agent.session.append('tool/ptc-dispatch-start', {
        rootCallId: 'outer-run-code',
        parentCallId: 'outer-run-code',
        subCallId: callId,
        name: 'mentor',
        arguments: args,
      })
      const value = await tool.execute(args, {
        agent,
        callId,
        rootCallId: 'outer-run-code',
        parent: Symbol('ptc-dispatch'),
        signal: new AbortController().signal,
      })
      agent.session.append('tool/ptc-dispatch', {
        rootCallId: 'outer-run-code',
        parentCallId: 'outer-run-code',
        subCallId: callId,
        name: 'mentor',
        arguments: args,
        isError: false,
        content: tool.output.render(args, value),
      })
      await ctx.sessions.flush(agent.session)
      return value
    },
  }
}

test('accepts a live-editable row whose fields arrive as volatile wrappers', async () => {
  const harness = createHarness({ volatileConfig: true })
  assert.equal(harness.rootToolRegistrations(), 1)
  const result = await harness.invoke({ message: 'Run with a live-editable row.' }, 'volatile-config-call')
  assert.equal(result.kind, 'reply')
  assert.equal(harness.requests[0].provider, 'mentor-route')
  assert.equal(harness.requests[0].model, 'mentor-model')
  assert.equal(harness.providerCalls(), 1)
})

test('registers Mentor shared Fetch at the full RC.1 /api path', () => {
  const harness = createHarness({ sharedFetch: true })
  assert.equal(harness.fetchRoutes.has('/api/mentor.view'), true)
  assert.equal(harness.fetchRoutes.has('/mentor.view'), false)
})

test('serves the current Session Mentor transcript through a root-scoped view RPC', async () => {
  const harness = createHarness()
  await harness.invoke({
    message: 'Review the request boundary.',
    evidence: [{ id: 'diff-1', kind: 'diff', source: 'change.diff', content: '+ safe change' }],
  }, 'view-call-1')

  const handler = harness.viewHandler()
  assert.equal(typeof handler, 'function')
  const carrier = await handler('read', {
    v: 'mentor_view_request_v1',
    op: 'read',
    sessionId: harness.parentSession.id,
  }, new AbortController().signal)
  assert.equal(carrier.ok, true)
  assert.equal(carrier.value.v, 'mentor_view_response_v1')
  assert.equal(carrier.value.result.kind, 'present')
  assert.equal(carrier.value.result.records.length, 1)
  assert.equal(carrier.value.result.records[0].message, 'Review the request boundary.')
  assert.equal(carrier.value.result.records[0].evidence[0].content, '+ safe change')
  assert.equal(carrier.value.result.records[0].answer, 'Use the smallest discriminating test.')
  assert.equal(carrier.value.result.records[0].deliveryStatus, 'delivered')

  const unavailable = await handler('read', {
    v: 'mentor_view_request_v1',
    op: 'read',
    sessionId: 'not-a-root-session',
  }, new AbortController().signal)
  assert.equal(unavailable.ok, true)
  assert.equal(unavailable.value.result.kind, 'unavailable')
})

test('reads and writes one global settings row instead of per-Session overrides', async () => {
  const harness = createHarness()
  // The plugin owns its own settings card, so it opts out of the generic form.
  assert.deepEqual(harness.settingsPolicies(), [{ presentation: { auto: false }, fiber: harness.ctx.fiber }])
  const handler = harness.viewHandler()
  const signal = new AbortController().signal
  const initial = await handler('read', { v: 'mentor_view_request_v1', op: 'settings-read' }, signal)
  assert.equal(initial.ok, true)
  assert.equal(initial.value.op, 'settings-read')
  assert.equal(initial.value.result.kind, 'settings')
  assert.equal(initial.value.result.namespace, 'dsh-mentor')
  assert.equal(initial.value.result.writable, true)
  assert.equal(initial.value.result.revision, 0)
  assert.equal(initial.value.result.values.model, 'mentor-model')
  assert.equal(initial.value.result.effective.model, 'mentor-model')
  assert.equal(initial.value.result.values.requestTimeoutMs, 1000)

  const removedLimit = await handler('read', {
    v: 'mentor_view_request_v1',
    op: 'settings-save',
    settings: { maxOutputTokens: 2049 },
    revision: 0,
  }, signal)
  assert.equal(removedLimit.value.result.kind, 'fault')
  assert.equal(removedLimit.value.result.code, 'invalid_settings')
  const unlisted = await handler('read', {
    v: 'mentor_view_request_v1',
    op: 'settings-save',
    settings: { provider: 'untrusted-route', model: 'unlisted-model' },
    revision: 0,
  }, signal)
  assert.equal(unlisted.value.result.code, 'invalid_settings')
  const unsupportedEffort = await handler('read', {
    v: 'mentor_view_request_v1',
    op: 'settings-save',
    settings: { reasoningEffort: 'medium' },
    revision: 0,
  }, signal)
  assert.equal(unsupportedEffort.value.result.code, 'invalid_settings')
  assert.equal(harness.settingsUpdates().length, 0)

  const saved = await handler('read', {
    v: 'mentor_view_request_v1',
    op: 'settings-save',
    settings: {
      enabled: true,
      provider: 'mentor-route',
      model: 'mentor-model-fast',
      reasoningEffort: 'medium',
      requestTimeoutMs: 512,
      globalConcurrency: 3,
    },
    revision: 0,
  }, signal)
  assert.equal(saved.ok, true)
  assert.equal(saved.value.result.kind, 'settings')
  assert.equal(saved.value.result.values.model, 'mentor-model-fast')
  assert.equal(saved.value.result.values.requestTimeoutMs, 512)
  assert.equal(saved.value.result.revision, 1)
  assert.deepEqual(harness.settingsUpdates().at(-1), {
    ns: 'dsh-mentor',
    expected: 0,
    patch: {
      enabled: true,
      provider: 'mentor-route',
      model: 'mentor-model-fast',
      reasoningEffort: 'medium',
      requestTimeoutMs: 512,
      globalConcurrency: 3,
    },
  })

  const staleSave = await handler('read', {
    v: 'mentor_view_request_v1',
    op: 'settings-save',
    settings: { requestTimeoutMs: 900 },
    revision: 0,
  }, signal)
  assert.equal(staleSave.value.result.code, 'conflict')
  assert.equal(harness.settingsUpdates().length, 1)

  // The row is global: every Session and a thread reset see the same values.
  const otherSession = makeSessionForTest('other-settings-session')
  const otherAgent = { id: otherSession.id, session: otherSession, ctx: harness.parentAgent.ctx }
  harness.rootAgents.push(otherAgent)
  const custom = await harness.invoke({ message: 'Use the global route.' }, 'settings-call')
  assert.equal(custom.kind, 'reply')
  assert.equal(harness.requests[0].model, 'mentor-model')
  const reset = await harness.commands.get('mentor').handler({ agent: harness.parentAgent, rawInput: 'reset' })
  assert.equal(reset.kind, 'success')
  const afterReset = await handler('read', { v: 'mentor_view_request_v1', op: 'settings-read' }, signal)
  assert.equal(afterReset.value.result.values.model, 'mentor-model-fast')
  assert.equal(afterReset.value.result.values.globalConcurrency, 3)
  const journalData = [...harness.journalRows.values()].flat().map((event) => event.data)
  assert.equal(journalData.some((data) => data.kind === 'session-settings-set'), false)
})

test('refuses global settings writes when the deployment is read-only', async () => {
  const harness = createHarness({ settingsReadOnly: true })
  const handler = harness.viewHandler()
  const signal = new AbortController().signal
  const read = await handler('read', { v: 'mentor_view_request_v1', op: 'settings-read' }, signal)
  assert.equal(read.value.result.kind, 'settings')
  assert.equal(read.value.result.writable, false)
  const save = await handler('read', {
    v: 'mentor_view_request_v1',
    op: 'settings-save',
    settings: { requestTimeoutMs: 900 },
    revision: 0,
  }, signal)
  assert.equal(save.value.result.kind, 'fault')
  assert.equal(save.value.result.code, 'read_only')
})

test('uses the global ModelCatalog default when Mentor profile route fields are blank', async () => {
  const harness = createHarness({ profileProvider: '', profileModel: '' })
  const result = await harness.invoke({ message: 'Use the global default model.' }, 'global-default-call')
  assert.equal(result.kind, 'reply')
  assert.equal(harness.requests[0].provider, 'mentor-route')
  assert.equal(harness.requests[0].model, 'mentor-model')
  const settings = await harness.viewHandler()('read', { v: 'mentor_view_request_v1', op: 'settings-read' }, new AbortController().signal)
  assert.equal(settings.value.result.values.provider, '')
  assert.equal(settings.value.result.effective.provider, 'mentor-route')
  assert.equal(settings.value.result.effective.model, 'mentor-model')
})

test('registers the tool and direct host commands without creating a Mentor on idle sessions', async () => {
  const harness = createHarness()
  const tool = harness.tool()
  assert.equal(tool.name, 'mentor')
  const descriptions = [
    tool.description,
    tool.parameters.message.description,
    tool.parameters.evidence.description,
    tool.parameters.evidence.items.properties.id.description,
    tool.parameters.evidence.items.properties.kind.description,
    tool.parameters.evidence.items.properties.source.description,
    tool.parameters.evidence.items.properties.content.description,
  ]
  assert.ok(descriptions.every((description) => typeof description === 'string' && /^[\x00-\x7F]+$/u.test(description)))
  assert.equal(harness.globalToolRegistrations(), 0)
  assert.equal(harness.rootToolRegistrations(), 1)
  assert.equal(harness.commands.has('mentor'), true)
  assert.equal(harness.commands.get('mentor').description, 'View or reset the Mentor thread for the current primary Session.')
  const status = await harness.commands.get('mentor').handler({ agent: harness.parentAgent, rawInput: 'status' })
  assert.equal(status.kind, 'success')
  assert.equal(harness.requests.length, 0)
})

test('creates an isolated zero-tool Mentor, persists the result, and continues its thread', async () => {
  const harness = createHarness()
  const first = await harness.invoke({ message: 'Review this failure.' }, 'call-1')
  assert.equal(first.kind, 'reply')
  const accepted = [...harness.journalRows.values()].flat().find((event) => event.data?.kind === 'consultation-accepted')
  assert.equal(accepted.data.inputMeasureMode, 'serialized-json-utf8-bytes')
  assert.equal(accepted.data.newInputBytes > 0, true)
  assert.equal(harness.createdAgents[0].scope.toolRegistrations, 0)
  assert.equal(harness.rootAgents.includes(harness.createdAgents[0]), false)
  const recursive = await harness.tool().execute({ message: 'Do not recursively consult Mentor.' }, {
    agent: harness.createdAgents[0],
    callId: 'recursive-call',
    signal: new AbortController().signal,
  })
  assert.equal(recursive.code, 'MENTOR_DISABLED')
  assert.equal(first.usage.status, 'unknown')
  assert.equal(harness.requests.length, 1)
  assert.equal(harness.requests[0].tools.length, 0)
  assert.equal(harness.requests[0].messages[0].content[0].text.includes('没有工具'), true)
  assert.deepEqual(harness.requests[0].messages.filter((message) => message.role === 'user').map((message) => message.source.kind), ['dsh-plugin-mentor'])
  const second = await harness.invoke({
    message: 'I checked that path; compare the alternative.',
  }, 'call-2')
  assert.equal(second.thread_id, first.thread_id)
  assert.equal(second.context_revision, 2)
  assert.equal(harness.requests.length, 2)
  assert.equal(harness.requests[1].messages.length, 4)
  const deliveryState = projectJournal([...harness.journalRows.values()].flat())
  assert.equal(deliveryState.calls.get('call-1').deliveryStatus, 'delivered')
  assert.equal(harness.createdAgents.length, 2)
  assert.equal(harness.rootAgents.includes(harness.createdAgents[1]), false)
  assert.equal(harness.flushes.includes(harness.parentSession.id), true)
})

test('matches RC.1 system messages already persisted in Session history', async () => {
  const harness = createHarness({ sessionSystemMessage: true })
  const result = await harness.invoke({ message: 'Keep RC.1 Session history aligned.' }, 'call-rc1-history')

  assert.equal(result.kind, 'reply')
  assert.equal(result.message, 'Use the smallest discriminating test.')
})

test('uses a producer-owned user source accepted by RC.1 format v4', async () => {
  const harness = createHarness({ strictMessageSource: true })
  const result = await harness.invoke({ message: 'Verify the RC.1 user-message source.' }, 'call-v4-source')

  assert.equal(result.kind, 'reply')
  const userEvent = harness.createdAgents[0].session.ownEvents().find((event) => event.type === 'user/message')
  assert.equal(userEvent.data.source.kind, 'dsh-plugin-mentor')
})

test('recovers a committed reply from durable events when assistant-stream frames are absent', async () => {
  const harness = createHarness({ emitAssistantStream: false })
  const result = await harness.invoke({ message: 'Recover only a committed reply.' }, 'call-no-stream')

  assert.equal(result.kind, 'reply')
  assert.equal(result.message, 'Use the smallest discriminating test.')
  assert.equal(result.context_revision, 1)
})

test('isolates implicit threads by parent session and reset advances the epoch without model calls', async () => {
  const harness = createHarness()
  const first = await harness.invoke({ message: 'Private thread.' }, 'call-1')
  const otherSession = makeSessionForTest('other-session')
  const otherAgent = { id: otherSession.id, session: otherSession, ctx: harness.parentAgent.ctx }
  harness.rootAgents.push(otherAgent)
  const foreign = await harness.invoke({ message: 'Other session gets its own thread.' }, 'foreign-call', otherAgent)
  assert.equal(foreign.kind, 'reply')
  assert.notEqual(foreign.thread_id, first.thread_id)

  const reset = await harness.commands.get('mentor').handler({ agent: harness.parentAgent, rawInput: 'reset', signal: new AbortController().signal })
  assert.equal(reset.kind, 'success')
  const after = await harness.invoke({ message: 'Start a clean consultation.' }, 'call-2')
  assert.notEqual(after.thread_id, first.thread_id)
  assert.equal(harness.requests.length, 3)
})

test('reset holds the parent transition lock while journal reads are pending', async () => {
  const harness = createHarness()
  await harness.invoke({ message: 'Prepare a thread.' }, 'before-reset')
  const gate = harness.pauseNextJournalRead()
  const resetPromise = harness.commands.get('mentor').handler({
    agent: harness.parentAgent,
    rawInput: 'reset',
    signal: new AbortController().signal,
  })
  await gate.started
  const raced = await harness.invoke({ message: 'Race a new call.' }, 'during-reset')
  assert.equal(raced.kind, 'blocked')
  assert.equal(raced.code, 'THREAD_BUSY')
  assert.equal(harness.providerCalls(), 1)
  gate.release()
  const reset = await resetPromise
  assert.equal(reset.kind, 'success')
  assert.equal(harness.providerCalls(), 1)
})

test('records generation, input, context, and reply measurements without capping them', async () => {
  const harness = createHarness()
  for (let index = 1; index <= 3; index += 1) {
    const result = await harness.invoke({ message: `Consultation ${index}.` }, `measure-${index}`)
    assert.equal(result.kind, 'reply')
  }
  assert.equal(harness.providerCalls(), 3)
  const events = [...harness.journalRows.values()].flat().map((event) => event.data)
  const accepted = events.filter((event) => event.kind === 'consultation-accepted')
  assert.equal(accepted.length, 3)
  for (const event of accepted) {
    assert.equal(event.inputMeasureMode, 'serialized-json-utf8-bytes')
    assert.equal(Number.isSafeInteger(event.newInputBytes) && event.newInputBytes > 0, true)
  }
  const dispatched = events.filter((event) => event.kind === 'consultation-dispatched')
  assert.equal(dispatched.length, 3)
  for (const event of dispatched) {
    assert.equal(event.contextMeasureMode, 'serialized-json-utf8-upper-bound')
    assert.equal(Number.isSafeInteger(event.contextUpperBoundBytes) && event.contextUpperBoundBytes > 0, true)
    assert.equal(Object.hasOwn(event, 'requestMaxTokens'), false)
  }
  const settled = events.filter((event) => event.kind === 'consultation-settled')
  assert.equal(settled.length, 3)
  for (const event of settled) {
    assert.equal(Number.isSafeInteger(event.replyUtf8Bytes) && event.replyUtf8Bytes > 0, true)
  }
  const state = projectJournal([...harness.journalRows.values()].flat())
  const call = state.calls.get('measure-3')
  assert.equal(Number.isSafeInteger(call.contextUpperBoundBytes), true)
  assert.equal(Number.isSafeInteger(call.replyUtf8Bytes), true)
})

test('keeps recording generations and per-Session metrics across a reset', async () => {
  const harness = createHarness()
  await harness.invoke({ message: 'First generation.' }, 'budget-before-reset')
  const reset = await harness.commands.get('mentor').handler({
    agent: harness.parentAgent,
    rawInput: 'reset',
    signal: new AbortController().signal,
  })
  assert.equal(reset.kind, 'success')
  const next = await harness.invoke({ message: 'A new thread keeps counting.' }, 'budget-after-reset')
  assert.equal(next.kind, 'reply')
  assert.equal(harness.providerCalls(), 2)
  const status = await harness.commands.get('mentor').handler({ agent: harness.parentAgent, rawInput: 'status' })
  assert.match(status.text, /已派发生成：2 次（无上限/u)
})

test('replays the canonical tool result by host call id without another provider call', async () => {
  const harness = createHarness()
  const args = { message: 'Check this failure.' }
  const first = await harness.invoke(args, 'repeat-call')
  const replay = await harness.invoke(args, 'repeat-call')
  assert.deepEqual(replay, first)
  assert.equal(harness.providerCalls(), 1)
  await assert.rejects(harness.invoke({ message: 'Different input.' }, 'repeat-call'), /different input/u)
  assert.equal(harness.providerCalls(), 1)
})

test('recovers PTC dispatch records with normalized object arguments and no presentation metadata', async () => {
  const harness = createHarness()
  const args = { message: 'Review the PTC path.' }
  const first = await harness.invokePtc(args, 'ptc-subcall-1')
  harness.childRows.delete(first.thread_id)
  const replay = await harness.invokePtc(args, 'ptc-subcall-1')
  assert.deepEqual(replay, first)
  assert.equal(harness.providerCalls(), 1)
})

test('reconstructs a settled canonical reply if the parent tool result was not recorded yet', async () => {
  const harness = createHarness()
  const args = { message: 'Recover the committed reply.' }
  const exec = { agent: harness.parentAgent, callId: 'lost-parent-result', signal: new AbortController().signal }
  harness.parentSession.append('tool/call', {
    turn: 1,
    step: 1,
    callId: exec.callId,
    name: 'mentor',
    arguments: JSON.stringify(args),
  })
  const first = await harness.tool().execute(args, exec)
  const recovered = await harness.tool().execute(args, exec)
  assert.deepEqual(recovered, first)
  assert.equal(harness.providerCalls(), 1)
  const next = await harness.invoke({ message: 'Do not assume the previous result was delivered.' }, 'next-before-delivery')
  assert.equal(next.kind, 'blocked')
  assert.equal(next.code, 'THREAD_BUSY')
  assert.equal(harness.providerCalls(), 1)
})

test('recovers a settled result after RC.2 parent repair using a new host call id', async () => {
  const harness = createHarness()
  const args = { message: 'Recover the answer after parent-session repair.' }
  const first = await harness.invokeWithoutResult(args, 'crashed-call')
  await harness.appendUnknownToolOutcome('crashed-call')

  const recovered = await harness.invoke(args, 'retry-after-resume')
  assert.deepEqual(recovered, first)
  assert.equal(harness.providerCalls(), 1)
  assert.equal(harness.requests.length, 1)

  const status = await harness.commands.get('mentor').handler({ agent: harness.parentAgent, rawInput: 'status' })
  const state = projectJournal([...harness.journalRows.values()].flat())
  assert.equal(state.calls.get('crashed-call').deliveryStatus, 'delivered')
  assert.equal(state.calls.get('retry-after-resume').generationSent, false)
  assert.match(status.text, /已派发生成：1 次（无上限/u)
  const followUp = await harness.invoke({ message: 'Continue from the answer the parent now received.' }, 'after-recovery-followup')
  assert.equal(followUp.thread_id, first.thread_id)
  assert.equal(followUp.context_revision, 2)
  assert.equal(harness.requests[1].messages.length, 4)
  assert.equal(harness.providerCalls(), 2)
})

test('manual reset prevents replaying a pending result from the prior epoch', async () => {
  const harness = createHarness()
  const args = { message: 'Do not recover this answer after an explicit reset.' }
  const first = await harness.invokeWithoutResult(args, 'reset-recovery-source')
  await harness.appendUnknownToolOutcome('reset-recovery-source')
  const reset = await harness.commands.get('mentor').handler({
    agent: harness.parentAgent,
    rawInput: 'reset',
    signal: new AbortController().signal,
  })
  assert.equal(reset.kind, 'success')

  const fresh = await harness.invoke(args, 'reset-recovery-fresh-call')
  assert.notEqual(fresh.thread_id, first.thread_id)
  assert.equal(harness.providerCalls(), 2)
})

test('fails closed if any tool schema survives assembly', async () => {
  const harness = createHarness({ toolSchemas: true })
  await assert.rejects(harness.invoke({ message: 'No tools should be visible.' }, 'schema-call'), /MENTOR_TOOL_VIOLATION/u)
  assert.equal(harness.providerCalls(), 0)
  const journalState = projectJournal([...harness.journalRows.values()].flat())
  assert.equal(journalState.activeThread, null)
  assert.equal(journalState.calls.get('schema-call').status, 'aborted')
})

test('rejects extra hidden content in the system-role message before provider dispatch', async () => {
  const harness = createHarness({ extraSystemBlock: true })
  await assert.rejects(harness.invoke({ message: 'Keep the system message exact.' }, 'system-prompt-call'), /MENTOR_PROMPT_VIOLATION/u)
  assert.equal(harness.providerCalls(), 0)
})

test('delivers a reply larger than the former byte cap and records its size', async () => {
  const harness = createHarness({ replyText: 'x'.repeat(40000) })
  const result = await harness.invoke({ message: 'Answer with a long reply.' }, 'large-reply')
  assert.equal(result.kind, 'reply')
  assert.equal(result.message.length, 40000)
  const settled = [...harness.journalRows.values()].flat()
    .map((event) => event.data)
    .find((data) => data.kind === 'consultation-settled')
  assert.equal(settled.replyUtf8Bytes, 40000)
  assert.equal(settled.deliveryStatus, 'pending')
  const state = projectJournal([...harness.journalRows.values()].flat())
  assert.equal(state.calls.get('large-reply').deliveryStatus, 'pending')
})

test('retires a thread when post-execute policy alters the delivered reply', async () => {
  const harness = createHarness({ mutateRenderedResults: true })
  const first = await harness.invoke({ message: 'Ask Mentor once.' }, 'modified-result-1')
  const second = await harness.invoke({ message: 'Continue only from what was delivered.' }, 'modified-result-2')
  assert.notEqual(second.thread_id, first.thread_id)
  assert.equal(harness.requests[1].messages.length, 2)
  const state = projectJournal([...harness.journalRows.values()].flat())
  assert.equal(state.calls.get('modified-result-1').deliveryStatus, 'undelivered')
  assert.equal(harness.providerCalls(), 2)
})

test('propagates caller cancellation and records an unknown dispatched outcome without retry', async () => {
  const harness = createHarness({ waitForAbort: true })
  const controller = new AbortController()
  const pending = harness.invoke({ message: 'Cancel this consultation.' }, 'cancel-call', harness.parentAgent, controller.signal)
  await harness.providerStarted
  controller.abort(new Error('parent cancelled'))
  await assert.rejects(pending, /fake Agent cancelled/u)
  assert.equal(harness.createdAgents[0].cancelCause.kind, 'parent')
  assert.equal(harness.providerCalls(), 1)
  const state = projectJournal([...harness.journalRows.values()].flat())
  assert.equal(state.calls.get('cancel-call').status, 'indeterminate')
})

test('local timeout cancels the child Agent and records unknown usage without retry', async () => {
  const harness = createHarness({ waitForAbort: true, requestTimeoutMs: 10 })
  const pending = harness.invoke({ message: 'This request should time out.' }, 'timeout-call')
  await harness.providerStarted
  await assert.rejects(pending, /fake Agent cancelled/u)
  assert.equal(harness.createdAgents[0].cancelCause.kind, 'hook')
  assert.equal(harness.providerCalls(), 1)
  const state = projectJournal([...harness.journalRows.values()].flat())
  const call = state.calls.get('timeout-call')
  assert.equal(call.status, 'indeterminate')
  assert.equal(call.usage.status, 'unknown')
})

test('pre-dispatch route failures are aborted and do not poison a new consultation', async () => {
  const harness = createHarness({ noAdapterOnce: true })
  await assert.rejects(harness.invoke({ message: 'The configured route is unavailable.' }, 'route-failure'), /no adapter/u)
  assert.equal(harness.providerCalls(), 0)
  const state = projectJournal([...harness.journalRows.values()].flat())
  assert.equal(state.calls.get('route-failure').status, 'aborted')
  assert.equal(state.activeThread, null)

  const next = await harness.invoke({ message: 'Use the recovered configuration.' }, 'route-retry')
  assert.equal(next.kind, 'reply')
  assert.equal(harness.providerCalls(), 1)
  assert.equal(harness.requests.length, 2)
})

test('supports rc.2 handle persistence and flushes ignorable journal events', async () => {
  const harness = createHarness({ persistenceStyle: 'legacy' })
  const result = await harness.invoke({ message: 'Check legacy persistence.' }, 'legacy-call')
  assert.equal(result.kind, 'reply')
  const journal = [...harness.journalRows.values()].flat()
  assert.equal(journal.length > 0, true)
  assert.equal(journal.every((event) => event.ignorable === true), true)
  assert.equal(harness.providerCalls(), 1)
})

function makeSessionForTest(id) {
  const records = []
  return {
    id,
    header: { id },
    ownEvents: () => records.slice(),
    snapshotEvents: () => records.slice(),
    append(type, data) { records.push({ seq: records.length, type, time: Date.now(), data }) },
  }
}
