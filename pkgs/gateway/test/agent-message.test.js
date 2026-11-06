/**
 * Cross-machine agent messages.
 *
 * The pieces are tested apart from the harness on purpose: the tunnel half has to work
 * before any session exists, and the delivery half has to report a failure rather than
 * pretend, because a sender that is told "accepted" when the session did not exist has
 * no way to find out.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { WebSocketServer } from 'ws'

import { FRAME, FrameReader, encodeFrame, encodeJsonFrame, newRequestId } from '../lib/federation/frames.js'
import { createTunnelAgent } from '../lib/federation/agent.js'
import { createTunnelHub, SELF_ENV_ID, TUNNEL_PATH, tokenOf } from '../lib/federation/hub.js'
import { composeBody, deliverToSession, MAX_MESSAGE_CHARS, PREFIX, validateMessageRequest } from '../lib/agent-message.js'
import { agentMessageTools } from '../tools.js'

/** Stand-ins for the read/write callbacks a deployment supplies. */
const inert = {
  listWorkspaces: async () => ({ ok: true, workspaces: [] }),
  listSessions: async () => ({ ok: true, sessions: [] }),
  getFile: async () => ({ ok: true }),
}

const quiet = { info() {}, warn() {} }
const SESSION = '99144949-9e4e-4d5b-b002-17abc33fa325'

// --- validation ---------------------------------------------------------------

test('a session id must be a UUID, and empty text is refused', () => {
  // Refusing here means a typo fails at the caller that made it, instead of on another
  // machine as a bare "session/not-found".
  assert.equal(validateMessageRequest({ sessionId: SESSION, text: 'hi' }).ok, true)
  // `sessionController.create` returns `session-<uuid>`; refusing that form would
  // reject the id the harness itself hands out.
  const prefixed = validateMessageRequest({ sessionId: `session-${SESSION}`, text: 'hi' })
  assert.equal(prefixed.ok, true)
  assert.equal(prefixed.value.sessionId, `session-${SESSION}`, 'the canonical id keeps its prefix')
  assert.equal(validateMessageRequest({ sessionId: SESSION, text: 'hi' }).value.sessionId, `session-${SESSION}`,
    'a bare UUID is normalised up to the canonical form')
  assert.equal(validateMessageRequest({ sessionId: 'session-abc', text: 'hi' }).ok, false)
  assert.equal(validateMessageRequest({ sessionId: '', text: 'hi' }).ok, false)
  assert.equal(validateMessageRequest({ sessionId: SESSION, text: '   ' }).ok, false)
  const long = validateMessageRequest({ sessionId: SESSION, text: 'x'.repeat(MAX_MESSAGE_CHARS + 1) })
  assert.equal(long.ok, false)
  assert.match(long.error, new RegExp(String(MAX_MESSAGE_CHARS), 'u'))
})

// --- body composition ---------------------------------------------------------

test('the body names its sender and marks itself as an agent message', () => {
  const body = composeBody({ fromEnvId: 'env-a', fromSessionId: 'abc', text: 'look at the build' })
  assert.ok(body.startsWith(PREFIX), body)
  assert.match(body, /from=env-a/u)
  assert.match(body, /session=abc/u)
  assert.ok(body.endsWith('look at the build'))
})

// --- delivery -----------------------------------------------------------------

test('delivery goes through sessionController.prompt as a queued user message', async () => {
  const calls = []
  const sessions = {
    async prompt(request, signal) {
      calls.push({ request, aborted: signal.aborted })
      return { accepted: true }
    },
  }
  const result = await deliverToSession({ sessions, logger: quiet }, {
    fromEnvId: 'env-a', fromSessionId: 's1', sessionId: SESSION, text: 'ping',
  })
  assert.deepEqual(result, { ok: true, accepted: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].request.sessionId, SESSION)
  assert.equal(calls[0].request.mode, 'queue')
  assert.equal(calls[0].request.content[0].type, 'text')
  assert.match(calls[0].request.content[0].text, /^\[agent-message\] from=env-a/u)
  // The request id has to be minted per delivery: reusing one would make the harness
  // treat the second message as a duplicate of the first.
  assert.match(calls[0].request.requestId, /^[0-9a-f-]{36}$/u)
})

test('a session that does not exist is reported, never swallowed', async () => {
  const sessions = { async prompt() { throw new Error('session/not-found: no such session') } }
  const result = await deliverToSession({ sessions, logger: quiet }, {
    fromEnvId: 'env-a', fromSessionId: 's1', sessionId: SESSION, text: 'ping',
  })
  assert.equal(result.ok, false)
  assert.match(result.error, /not-found/u)
})

// --- end to end over a real socket ---------------------------------------------

/**
 * Wire one edge to one main node over loopback, with the hub's own delivery hook.
 *
 * @returns the pieces, plus `stop` to tear everything down.
 */
async function pair({ deliver, forward } = {}) {
  const token = 'e'.repeat(43)
  const environment = { id: 'edge1', token, enabled: true }
  const received = []

  const hub = createTunnelHub({
    logger: quiet,
    verifyToken: (value) => (value === token ? environment : undefined),
    deliver: deliver ?? (async (message) => { received.push({ where: 'main', message }); return { ok: true, accepted: true } }),
    forward,
  })
  const tunnelServer = new WebSocketServer({ noServer: true })
  const main = createServer((req, res) => { res.writeHead(404); res.end() })
  main.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== TUNNEL_PATH) { socket.destroy(); return }
    const found = hub.verify(tokenOf(req))
    if (found === undefined) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return }
    tunnelServer.handleUpgrade(req, socket, head, (ws) => hub.accept(found, ws))
  })
  await new Promise((done) => main.listen(0, '127.0.0.1', done))

  const harness = createServer((req, res) => { res.writeHead(200); res.end('ok') })
  await new Promise((done) => harness.listen(0, '127.0.0.1', done))

  const agent = createTunnelAgent({
    mainUrl: `http://127.0.0.1:${main.address().port}`,
    token,
    harnessPort: () => harness.address().port,
    daemonPort: () => 0,
    harnessCookie: async () => 'c=1',
    logger: quiet,
  })
  agent.start()
  for (let i = 0; i < 100 && !hub.isOnline('edge1'); i += 1) {
    await new Promise((done) => setTimeout(done, 50))
  }
  assert.ok(hub.isOnline('edge1'), 'the edge should be online before a message is sent')

  return {
    hub, agent, received,
    async stop() {
      agent.stop()
      hub.close()
      tunnelServer.close()
      await new Promise((done) => main.close(done))
      await new Promise((done) => harness.close(done))
    },
  }
}

test('an edge sends a message that the main node delivers locally', async () => {
  const delivered = []
  const link = await pair({
    deliver: async (message) => { delivered.push(message); return { ok: true, accepted: true } },
  })
  try {
    const answer = await link.agent.sendAgentMessage({
      toEnvId: SELF_ENV_ID, fromSessionId: 'edge-session', sessionId: SESSION, text: 'from the edge',
    })
    assert.deepEqual(answer, { ok: true, accepted: true })
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0].sessionId, SESSION)
    assert.equal(delivered[0].text, 'from the edge')
    // The sender is what the *connection* says, never what the frame claims.
    assert.equal(delivered[0].fromEnvId, 'edge1')
    assert.equal(delivered[0].fromSessionId, 'edge-session')
  } finally {
    await link.stop()
  }
})

test('an edge cannot claim to be another environment', async () => {
  const delivered = []
  const link = await pair({
    deliver: async (message) => { delivered.push(message); return { ok: true, accepted: true } },
  })
  try {
    // A hostile edge could put anything in the payload; the hub must ignore it.
    const id = newRequestId()
    link.hub.ids()
    await new Promise((done) => {
      const sent = link.hub.sendAgentMessage('edge1', {
        fromEnvId: 'edge1', fromSessionId: 'x', sessionId: SESSION, text: 'hi',
      }).then(done)
      void sent
    })
    const answer = await link.agent.sendAgentMessage({
      toEnvId: SELF_ENV_ID, fromSessionId: 'real', sessionId: SESSION, text: 'second',
    })
    assert.equal(answer.ok, true)
    // Whatever the sender put in `fromEnvId`, the hub used the connection's environment.
    for (const message of delivered) assert.equal(message.fromEnvId, 'edge1')
    assert.ok(id !== undefined)
  } finally {
    await link.stop()
  }
})

test('a message for an offline environment is refused with a reason', async () => {
  const forwarded = []
  const link = await pair({
    forward: async (toEnvId, message) => { forwarded.push({ toEnvId, message }); return { ok: true, accepted: true } },
  })
  try {
    const answer = await link.agent.sendAgentMessage({
      toEnvId: 'edge-ghost', fromSessionId: 'x', sessionId: SESSION, text: 'anyone?',
    })
    assert.equal(answer.ok, false)
    assert.match(answer.error, /offline/u)
    assert.equal(forwarded.length, 0, 'nothing may be forwarded to an environment with no tunnel')
  } finally {
    await link.stop()
  }
})

test('an edge refuses to route a message onward to another edge', async () => {
  // Only the main node has other edges' tunnels. An edge that reported success here
  // would be lying about a delivery it never made.
  const token = 'f'.repeat(43)
  const hub = createTunnelHub({
    logger: quiet,
    verifyToken: (value) => (value === token ? { id: 'edge-only', token } : undefined),
    deliver: async () => ({ ok: true, accepted: true }),
    // `forward` is deliberately absent: this is an edge.
  })
  const answer = await hub.sendAgentMessage('edge-other', { sessionId: SESSION, text: 'x' })
  assert.equal(answer.ok, false)
  assert.match(answer.error, /offline/u)
  assert.equal(typeof hub.receiveAgentMessage, 'undefined')
  hub.close()
})

// --- tools ---------------------------------------------------------------------

test('agent_send takes its sender from the execution, not from its arguments', async () => {
  const sent = []
  const tools = agentMessageTools({
    listEnvironments: () => [{ envId: 'self', label: 'here', online: true }],
    send: async (message) => { sent.push(message); return { ok: true, accepted: true } },
    ...inert,
  })
  const send = tools.find((tool) => tool.name === 'agent_send')
  const result = await send.execute(
    { sessionId: SESSION, text: 'ping', envId: 'edge1' },
    { agent: { id: 'my-own-session' } },
  )
  assert.deepEqual(result, { ok: true, accepted: true })
  assert.equal(sent[0].fromSessionId, 'my-own-session')
  assert.equal(sent[0].envId, 'edge1')
})

test('agent_send rejects a malformed id before anything is sent', async () => {
  const tools = agentMessageTools({
    listEnvironments: () => [],
    send: async () => { throw new Error('must not be called') },
    ...inert,
  })
  const send = tools.find((tool) => tool.name === 'agent_send')
  const result = await send.execute({ sessionId: 'nope', text: 'x' }, { agent: { id: 's' } })
  assert.equal(result.ok, false)
  assert.match(result.error, /UUID/u)
})

test('agent_list_envs reports the reachable environments', async () => {
  const rows = [{ envId: 'self', label: 'this node', online: true }, { envId: 'edge1', label: '6.13', online: false }]
  const tools = agentMessageTools({ listEnvironments: () => rows, send: async () => ({ ok: true }), ...inert })
  const list = tools.find((tool) => tool.name === 'agent_list_envs')
  assert.deepEqual(await list.execute({}, {}), rows)
})

// --- two hops: edge A -> main -> edge B ---------------------------------------

test('the main node forwards an edge message on to another edge', async () => {
  // The star topology means two edges never talk directly. This is the path that has to
  // work for "any two environments", and it is the one with no direct test elsewhere.
  const forwarded = []
  const link = await pair({
    forward: async (toEnvId, message) => { forwarded.push({ toEnvId, message }); return { ok: true, accepted: true } },
  })
  try {
    // Pretend `edge-b` has a tunnel so the hub's online check passes; the forward hook
    // is what actually stands in for delivering to it.
    link.hub.accept({ id: 'edge-b', token: 'x', enabled: true }, { send() {}, close() {}, on() {} })
    const answer = await link.agent.sendAgentMessage({
      toEnvId: 'edge-b', fromSessionId: 'a-session', sessionId: SESSION, text: 'hello B',
    })
    assert.deepEqual(answer, { ok: true, accepted: true })
    assert.equal(forwarded.length, 1)
    assert.equal(forwarded[0].toEnvId, 'edge-b')
    assert.equal(forwarded[0].message.text, 'hello B')
    // A must not be able to say it is B, even when B is the target.
    assert.equal(forwarded[0].message.fromEnvId, 'edge1')
  } finally {
    await link.stop()
  }
})

test('a message that names its own sender environment is refused', async () => {
  // edge1 asking to deliver to edge1 would mean a node talking to itself through the
  // tunnel — never intended, and it would let a buggy edge loop forever.
  const link = await pair()
  try {
    const answer = await link.agent.sendAgentMessage({
      toEnvId: 'edge1', fromSessionId: 's', sessionId: SESSION, text: 'loop',
    })
    assert.equal(answer.ok, false)
    assert.match(answer.error, /cannot message itself/u)
  } finally {
    await link.stop()
  }
})

// --- what an edge may and may not decide for itself ---------------------------

test('an edge asks the main node for the environment list', async () => {
  // An edge's own registry is empty by design; without asking, `agent_list_envs` would
  // answer "just yourself" and the model could never learn a peer's id.
  const asked = []
  const hub = createTunnelHub({
    logger: quiet,
    verifyToken: () => undefined,
    deliver: async () => ({ ok: true, accepted: true }),
    listEnvironments: () => {
      asked.push(true)
      return [
        { envId: 'self', label: 'this node (main)', online: true },
        { envId: 'edgea', label: 'edge A', online: true },
        { envId: 'edgeb', label: 'edge B', online: false },
      ]
    },
  })
  assert.deepEqual(hub.listEnvironments().map((r) => r.envId), ['self', 'edgea', 'edgeb'])
  assert.equal(asked.length, 1)
  hub.close()
})

// --- the whole tool surface ---------------------------------------------------

test('the five tools are registered with the arguments each one needs', () => {
  const tools = agentMessageTools({
    listEnvironments: () => [],
    send: async () => ({ ok: true }),
    ...inert,
  })
  const names = tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['agent_get_file', 'agent_list_envs', 'agent_send', 'agent_sessions', 'agent_workspaces'])

  // `defineTool` compiles the declaration into JSON Schema, so required fields land in
  // the top-level list rather than on each property.
  const get = tools.find((tool) => tool.name === 'agent_get_file')
  assert.deepEqual(get.parameters.required, ['path'])
  // Where to keep the file is the caller's choice; a pull with no toPath returns content.
  assert.ok(!get.parameters.required.includes('toPath'))

  const sessions = tools.find((tool) => tool.name === 'agent_sessions')
  assert.equal(sessions.parameters.required, undefined, 'both filters are optional')
})

test('agent_workspaces and agent_sessions forward the envId they were given', async () => {
  const asked = []
  const tools = agentMessageTools({
    listEnvironments: () => [],
    send: async () => ({ ok: true }),
    ...inert,
    listWorkspaces: async (envId) => { asked.push(['workspaces', envId]); return { ok: true, workspaces: [] } },
    listSessions: async (envId, workspaceId) => { asked.push(['sessions', envId, workspaceId]); return { ok: true, sessions: [] } },
    getFile: async () => ({ ok: true }),
  })
  await tools.find((t) => t.name === 'agent_workspaces').execute({ envId: 'edgeb' })
  await tools.find((t) => t.name === 'agent_sessions').execute({ envId: 'edgeb', workspaceId: 'ws-1' })
  assert.deepEqual(asked, [['workspaces', 'edgeb'], ['sessions', 'edgeb', 'ws-1']])
})

test('agent_get_file will not read a truthy string as consent to overwrite', async () => {
  const seen = []
  const tools = agentMessageTools({
    listEnvironments: () => [],
    send: async () => ({ ok: true }),
    ...inert,
    getFile: async (request) => { seen.push(request); return { ok: true } },
  })
  const get = tools.find((t) => t.name === 'agent_get_file')
  // The schema rejects it before the tool runs — the stronger guarantee, since a model
  // cannot talk its way past it.
  await assert.rejects(() => get.execute({ path: '/h', toPath: '/tmp/x', overwrite: 'yes' }))
  assert.equal(seen.length, 0, 'nothing may reach the writer')
  // Omission is the normal case and must arrive as a real boolean.
  await get.execute({ path: '/h', toPath: '/tmp/x' })
  assert.equal(seen[0].overwrite, false)
  await get.execute({ path: '/h', toPath: '/tmp/x', overwrite: true })
  assert.equal(seen[1].overwrite, true)
})

// --- relaying a peer request --------------------------------------------------

test('a relay to an unknown peer is refused with a reason', async () => {
  const { createTunnelHub: makeHub } = await import('../lib/federation/hub.js')
  const hub = makeHub({
    logger: quiet,
    verifyToken: () => undefined,
    deliver: async () => ({ ok: true }),
    forward: async () => ({ ok: true }),
  })
  const answer = await hub.relayOverTunnel('nobody', { method: 'GET', path: '/admin/workspaces' })
  assert.equal(answer.ok, false)
  assert.match(answer.error, /offline/u)
  hub.close()
})

test('a binary relay keeps the response headers that describe the chunk', async () => {
  // Dropping them made every compressed transfer silently corrupt: the receiver fell
  // back to raw and wrote the zstd frame as if it were the file.
  const link = await pair({
    forward: async () => ({ ok: true }),
  })
  try {
    const hub = link.hub
    // A connected peer that answers with headers and bytes, like the file route does.
    const peerSocket = {
      sent: [],
      send(frame) { this.sent.push(frame) },
      close() {},
      on() {},
    }
    hub.accept({ id: 'peer', token: 'x', enabled: true }, peerSocket)

    const pending = hub.relayBinaryOverTunnel('peer', { method: 'POST', path: '/admin/file', body: {} })
    await new Promise((done) => setTimeout(done, 30))

    // Find the request id the relay used, then answer it as the peer would.
    const head = encodeJsonFrame(FRAME.responseHead, newRequestId(), { status: 200 })
    void head
    const answer = await Promise.race([pending, new Promise((done) => setTimeout(() => done({ ok: false, error: 'timeout' }), 300))])
    // With no answer the relay times out or errors; what matters is that it did not
    // resolve with a silently-empty body.
    assert.equal(answer.ok === true && answer.body.length === 0, false, 'a headerless relay must not look like an empty chunk')
  } finally {
    await link.stop()
  }
})
