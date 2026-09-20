import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const VIEW_REQUEST_VERSION = 'loopx_view_request_v1'
const VIEW_RESPONSE_VERSION = 'loopx_view_response_v1'
const VIEW_CHANNEL = '/loopx-view'
const VIEW_ENDPOINT = 'read'
const VIEW_SHARED_API_ENDPOINT = 'loopx.view'
const HOST_SURFACE = 'deepseek-harness-native'
const BINDING_SCHEMA = 'loopx_thread_agent_binding_resolution_v0'
const DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024
const VIEW_TIMEOUT_MS = 20_000
const MAX_TEXT = 640
const LOOPX_AGENT_ID = /^[a-z][a-z0-9_.:@-]{0,79}$/u
const GOAL_ID = /^(?!\.{1,2}$)[^\u0000-\u001f\u007f]{1,512}$/u
const SESSION_ID = /^[^\s\u0000-\u001f/\\'"]{1,128}$/u

export const name = 'loopx-view'
export const inject = ['agents', 'connection']

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined
}

function safeId(value, pattern = LOOPX_AGENT_ID) {
  return typeof value === 'string' && pattern.test(value) ? value : undefined
}

export function sanitizeText(value, limit = MAX_TEXT) {
  if (typeof value !== 'string') return ''
  let text = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  text = text.replace(/\b(bearer|authorization|password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
  text = text.replace(/(?:\/home\/[^\s]+|\/root\/[^\s]+|\/Users\/[^\s]+|[A-Za-z]:\\[^\s]+)/gu, '[path]')
  return [...text].slice(0, limit).join('')
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function runFile(file, args, cwd, signal, maxOutputBytes = DEFAULT_MAX_OUTPUT) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const child = spawn(file, args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    })
    const stdout = []
    const stderr = []
    let bytes = 0
    let settled = false
    const collect = (target, chunk) => {
      if (settled) return
      bytes += chunk.byteLength
      if (bytes > maxOutputBytes) {
        child.kill('SIGTERM')
        reject(new Error('LoopX output exceeded its limit'))
        settled = true
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', chunk => collect(stdout, chunk))
    child.stderr.on('data', chunk => collect(stderr, chunk))
    child.once('error', error => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('close', code => {
      if (settled) return
      settled = true
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
  })
}

function commandCandidates() {
  const configured = process.env.LOOPX_BIN?.trim()
  if (configured) return [{ file: configured, prefix: [] }]
  const agentsHome = process.env.DSH_AGENTS_HOME?.trim() || join(homedir(), '.agents')
  const launcher = join(agentsHome, 'runtime', 'dsh-loopx-plugin', 'loopx_cli.py')
  const python = process.env.PYTHON_BIN?.trim()
  const pythons = python ? [python] : ['python3', 'python3.14', 'python3.13', 'python3.12', 'python3.11']
  return [
    ...pythons.map(file => ({ file, prefix: [launcher] })),
    { file: 'loopx', prefix: [] },
    { file: python || 'python3', prefix: ['-m', 'loopx.cli'] },
  ]
}

async function resolveCommand(signal) {
  for (const candidate of commandCandidates()) {
    try {
      const result = await runFile(candidate.file, [...candidate.prefix, '--version'], process.cwd(), signal, 16 * 1024)
      if (result.exitCode === 0 && /^loopx\s+/u.test(result.stdout.trim())) return candidate
    } catch {
      // Try the next bounded, fixed candidate.
    }
  }
  throw new Error('LoopX CLI is unavailable')
}

async function runJson(command, args, cwd, signal) {
  const result = await runFile(command.file, [...command.prefix, ...args], cwd, signal)
  let payload
  try {
    payload = JSON.parse(result.stdout.trim())
  } catch {
    throw new Error(result.exitCode === 0 ? 'LoopX returned invalid JSON' : 'LoopX command failed')
  }
  if (result.exitCode !== 0 || record(payload) === undefined) throw new Error('LoopX command failed')
  return payload
}

function captureAgent(agents, sessionId) {
  if (!SESSION_ID.test(sessionId)) return undefined
  try {
    const agent = agents.get(sessionId)
    const session = agent?.session
    const cwd = session?.header?.cwd
    if (agent === undefined || session === undefined || typeof cwd !== 'string' || cwd.length === 0) return undefined
    if (String(agent.id) !== sessionId || String(session.id) !== sessionId) return undefined
    if (agent.status !== 'idle' && agent.status !== 'running') return undefined
    return { agent, session, cwd }
  } catch {
    return undefined
  }
}

function bindingResult(payload, sessionId) {
  if (payload?.schema_version !== BINDING_SCHEMA || payload?.host_surface !== HOST_SURFACE || payload?.thread_id !== sessionId) return { kind: 'fault' }
  const matches = Array.isArray(payload.matches) ? payload.matches : []
  const pairs = matches.filter(item => record(item) !== undefined && safeId(item.goal_id, GOAL_ID) !== undefined && safeId(item.agent_id) !== undefined)
  if (payload.status === 'missing' && payload.ok === true && pairs.length === 0) return { kind: 'hidden', reason: 'binding_missing' }
  if (payload.status === 'ambiguous' && pairs.length > 1) return { kind: 'hidden', reason: 'binding_ambiguous' }
  if (payload.status !== 'bound' || payload.ok !== true || pairs.length !== 1) return { kind: 'fault' }
  if (payload.goal_id !== pairs[0].goal_id || payload.agent_id !== pairs[0].agent_id) return { kind: 'fault' }
  return { kind: 'bound', goalId: pairs[0].goal_id, loopxAgentId: pairs[0].agent_id }
}

function projectGraph(raw) {
  const graph = record(raw)
  if (graph === undefined || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return null
  const nodes = graph.nodes.slice(0, 100).flatMap(node => {
    const item = record(node)
    if (item === undefined || typeof item.node_id !== 'string' || typeof item.kind !== 'string') return []
    return [{
      nodeId: sanitizeText(item.node_id, 160),
      kind: sanitizeText(item.kind, 40),
      title: sanitizeText(item.title, 420),
      state: sanitizeText(item.state, 40),
      ownerAgent: sanitizeText(item.owner_agent, 100),
    }]
  })
  const edges = graph.edges.slice(0, 160).flatMap(edge => {
    const item = record(edge)
    if (item === undefined || typeof item.from_node_id !== 'string' || typeof item.to_node_id !== 'string') return []
    return [{
      from: sanitizeText(item.from_node_id, 160),
      to: sanitizeText(item.to_node_id, 160),
      relation: sanitizeText(item.relation, 40),
      reason: sanitizeText(item.reason, 240),
    }]
  })
  return {
    schemaVersion: typeof graph.schema_version === 'string' ? graph.schema_version : 'task_graph_projection_v0',
    nodes,
    edges,
  }
}

function progressFrom(item) {
  const asset = record(item?.project_asset) || {}
  const todos = record(item?.agent_todos) || record(asset.agent_todos) || {}
  const open = safeCount(todos.open)
  const done = safeCount(todos.done)
  const total = safeCount(todos.total) || open + done
  return { open, done, total }
}

function statusItem(payload, goalId) {
  const queue = record(payload?.attention_queue)
  const items = Array.isArray(queue?.items) ? queue.items : []
  return items.find(item => record(item)?.goal_id === goalId)
}

function activationOf(status) {
  const value = String(status || '').toLowerCase()
  return value.includes('stopped') || value.includes('paused') ? 'stopped' : 'active'
}

export function buildViewProjection(payload, binding, sessionId, agentStatus) {
  const item = statusItem(payload, binding.goalId)
  if (item === undefined) return undefined
  const asset = record(item.project_asset) || {}
  return {
    sessionId,
    goalId: binding.goalId,
    loopxAgentId: binding.loopxAgentId,
    agentStatus,
    goalActivation: activationOf(item.status),
    status: sanitizeText(item.status, 120),
    severity: sanitizeText(item.severity, 60),
    waitingOn: sanitizeText(item.waiting_on, 240),
    gate: sanitizeText(asset.gate || item.gate, 320),
    nextAction: sanitizeText(asset.next_action || item.recommended_action || item.next_action, 520),
    progress: progressFrom(item),
    graph: projectGraph(item.task_graph_projection),
  }
}

function resultEnvelope(sessionId, result) {
  return { v: VIEW_RESPONSE_VERSION, op: 'read', sessionId, result }
}

function fault(sessionId, code) {
  return resultEnvelope(sessionId, { kind: 'fault', code })
}

async function readView(agents, request, signal) {
  const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(VIEW_TIMEOUT_MS)])
  const capture = captureAgent(agents, request.sessionId)
  if (capture === undefined) return fault(request.sessionId, 'session_unavailable')
  let command
  try {
    command = await resolveCommand(operationSignal)
  } catch {
    return fault(request.sessionId, 'cli_unavailable')
  }
  let bindingPayload
  try {
    bindingPayload = await runJson(command, [
      '--registry', '.loopx/registry.json',
      '--format', 'json',
      'resolve-agent-thread',
      '--host-surface', HOST_SURFACE,
      '--thread-id', request.sessionId,
    ], capture.cwd, operationSignal)
  } catch {
    return fault(request.sessionId, 'binding_read_failed')
  }
  const binding = bindingResult(bindingPayload, request.sessionId)
  if (binding.kind === 'hidden') return resultEnvelope(request.sessionId, binding)
  if (binding.kind !== 'bound') return fault(request.sessionId, 'binding_read_failed')
  let statusPayload
  try {
    statusPayload = await runJson(command, [
      '--registry', '.loopx/registry.json',
      '--format', 'json',
      'status',
      '--goal-id', binding.goalId,
      '--include-task-graph',
      '--limit', '20',
    ], capture.cwd, operationSignal)
  } catch {
    return fault(request.sessionId, 'status_read_failed')
  }
  const snapshot = buildViewProjection(statusPayload, binding, request.sessionId, capture.agent.status)
  return snapshot === undefined
    ? fault(request.sessionId, 'status_read_failed')
    : resultEnvelope(request.sessionId, { kind: 'present', snapshot })
}

function decodeRequest(value) {
  const input = record(value)
  return input?.v === VIEW_REQUEST_VERSION
    && input.op === 'read'
    && typeof input.sessionId === 'string'
    && SESSION_ID.test(input.sessionId)
    && Object.keys(input).length === 3
    ? { v: VIEW_REQUEST_VERSION, op: 'read', sessionId: input.sessionId }
    : undefined
}

function connectionResult(value) {
  return { ok: true, value }
}

function connectionFailure(code = 'internal') {
  return { ok: false, error: { code, message: 'LoopX view request failed', details: {} } }
}

function createRpcHandler(agents) {
  return async (_endpoint, payload, signal) => {
    const request = decodeRequest(payload)
    if (request === undefined) return connectionFailure('bad-request')
    try {
      return connectionResult(await readView(agents, request, signal))
    } catch {
      return connectionResult(fault(request.sessionId, 'status_read_failed'))
    }
  }
}

async function handleSharedApiRequest(request, handler) {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return new Response('content type must be application/json', { status: 415 })
  }
  let body
  try { body = await request.json() } catch { return new Response('body is not JSON', { status: 400 }) }
  const input = record(body)
  const rpcId = typeof input?.rpcId === 'string' ? input.rpcId : 'invalid-request'
  if (input?.type !== 'client-request' || typeof input.rpcId !== 'string' || input.method !== VIEW_SHARED_API_ENDPOINT || !Object.hasOwn(input, 'payload')) {
    return Response.json({ type: 'server-response', rpcId, result: connectionFailure('bad-request') })
  }
  const result = await handler(VIEW_ENDPOINT, input.payload, request.signal)
  return Response.json({ type: 'server-response', rpcId, result })
}

export function apply(ctx) {
  const connection = ctx.get('connection')
  const agents = ctx.get('agents')
  if (connection === undefined || agents === undefined) return
  const handler = createRpcHandler(agents)
  ctx.effect(() => {
    if (Reflect.has(connection, 'fetch')) {
      return connection.fetch.register({
        path: `/api/${VIEW_SHARED_API_ENDPOINT}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: request => handleSharedApiRequest(request, handler),
      })
    }
    return connection.rpc.handle(VIEW_CHANNEL, handler, { authority: 'loopback' })
  }, 'loopx-view read route')
}

export { decodeRequest, projectGraph }
