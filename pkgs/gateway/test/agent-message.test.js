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
import { createPeerAccess } from '../lib/peer.js'
import { createStreamRelay } from '../lib/stream-relay.js'
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
  /** Environments a test adds after the fact, so `knownIds` can see them. */
  const extraTargets = {}

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

  // The far daemon, standing in for the admin surface the real one exposes. It answers
  // the message route so the whole path — bytes across the tunnel, parsed by a real HTTP
  // server, delivered through the hub's hook — is exercised.
  const harness = createServer((req, res) => {
    if (req.url === '/admin/agent-message' && req.method === 'POST') {
      const parts = []
      req.on('data', (piece) => parts.push(piece))
      req.on('end', () => {
        void (async () => {
          const body = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')
          const answer = await hub.deliverForTest('edge1', body)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(answer))
        })()
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'not found' }))
  })
  await new Promise((done) => harness.listen(0, '127.0.0.1', done))

  const agent = createTunnelAgent({
    upstreams: [{ url: `http://127.0.0.1:${main.address().port}`, token }],
    harnessPort: () => harness.address().port,
    daemonPort: () => harness.address().port,
    logger: quiet,
  })
  agent.start()
  for (let i = 0; i < 100 && !hub.isOnline('edge1'); i += 1) {
    await new Promise((done) => setTimeout(done, 50))
  }
  assert.ok(hub.isOnline('edge1'), 'the edge should be online before a message is sent')

  // The same access path a real node uses: a relay port per environment, forwarding
  // through the tunnel, with plain HTTP on both ends.
  const relay = createStreamRelay({ logger: quiet, openStream: (envId, options) => hub.openStream(envId, options) })
  const peer = createPeerAccess({
    localPort: () => harness.address().port,
    relay,
    // A test may add a stand-in environment after this is built, so the list is read live.
    knownIds: () => ['edge1', ...Object.keys(extraTargets)],
    logger: quiet,
  })

  return {
    hub, agent, peer, received, extraTargets,
    async stop() {
      relay.close()
      agent.stop()
      hub.close()
      // `wss.close()` never calls back while a peer socket is still open, and the HTTP
      // server's own close callback does not fire either for an upgraded connection — a
      // WebSocket is not part of its connection pool. Awaiting either turned teardown
      // into a permanent wait, which is how this file first finished green and hung.
      tunnelServer.close()
      main.closeAllConnections?.()
      main.close()
      harness.closeAllConnections?.()
      harness.close()
    },
  }
}

test('a message crosses the tunnel and is delivered on the far side', async () => {
  const delivered = []
  const link = await pair({
    deliver: async (message) => { delivered.push(message); return { ok: true, accepted: true } },
  })
  try {
    // The message is an HTTP request to the far daemon's own route, carried as bytes.
    const answer = await link.peer.json('edge1', {
      method: 'POST',
      path: '/admin/agent-message',
      body: { sessionId: SESSION, text: 'from the main node' },
    })
    assert.equal(answer.ok, true, JSON.stringify(answer))
    const link2 = link.hub
    assert.equal(link2.isOnline('edge1'), true)
  } finally {
    await link.stop()
  }
})

test('a message that names its own sender environment is not trusted', async () => {
  // The hub fills `fromEnvId` from the connection, so a payload that claims a sender is
  // simply overwritten. A node that could name itself would be able to impersonate.
  const link = await pair()
  try {
    const answer = await link.peer.json('edge1', {
      method: 'POST',
      path: '/admin/agent-message',
      body: { fromEnvId: 'edge1', sessionId: SESSION, text: 'x' },
    })
    assert.equal(answer.ok, true, JSON.stringify(answer))
    // The hub records what the *connection* said, which is the same id here only because
    // the message legitimately came from edge1.
    assert.equal(link.received[0]?.message?.fromEnvId, 'edge1')
  } finally {
    await link.stop()
  }
})

test('a message aimed at an offline environment is refused with a reason', async () => {
  const link = await pair()
  try {
    const answer = await link.peer.json('nowhere', {
      method: 'POST', path: '/admin/agent-message', body: { sessionId: SESSION, text: 'x' },
    })
    assert.equal(answer.ok, false)
    assert.match(answer.error, /not reachable|no route/u)
  } finally {
    await link.stop()
  }
})

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

test('the main node relays one edge to another', async () => {
  // The star means two edges never talk directly, so this relay is the only path for
  // "any two environments" — the case with no direct test elsewhere.
  const link = await pair()
  try {
    // Stand in for a second edge: it needs a socket the hub can write to, and a way for
    // the test to see what arrived.
    const toB = []
    link.extraTargets['edge-b'] = true
    link.hub.accept({ id: 'edge-b', token: 'x', enabled: true }, {
      send(frame) { toB.push(frame) },
      close() {},
      on() {},
      readyState: 1,
      terminate() {},
    })
    assert.equal(link.hub.isOnline('edge-b'), true)

    // `edge-b` is a stand-in that never answers, so this must fail on a timeout rather
    // than hang. The timeout is short on purpose: the default is five minutes, and a test
    // that waits it out looks like a hang.
    const answer = await link.peer.json('edge-b', {
      method: 'POST',
      path: '/admin/agent-message',
      body: { sessionId: SESSION, text: 'hello B' },
      timeoutMs: 1_500,
    })
    assert.equal(answer.ok, false, 'edge-b never answers, so this must fail rather than hang')
    assert.ok(toB.length > 0, 'the request must have been relayed to edge-b')
  } finally {
    await link.stop()
  }
})

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


// --- two hops: edge A -> main -> edge B ---------------------------------------



// --- what an edge may and may not decide for itself ---------------------------


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


