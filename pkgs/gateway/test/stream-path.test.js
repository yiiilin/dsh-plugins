/**
 * The whole path, with real components at both ends.
 *
 * A hub, an agent, a relay and a peer, joined by a real WebSocket and a real TCP relay,
 * talking to a real HTTP server standing in for the far daemon. This is the test that
 * catches interface mismatches between those four pieces — the kind that unit tests on
 * each of them individually cannot see.
 *
 * It exists because a first draft of `peer.js` returned a promise that could never
 * resolve: the callback it waited for was assigned to a property nothing ever called. No
 * type checks the wiring of a promise, but a request that never comes back does.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { WebSocketServer } from 'ws'

import { createTunnelAgent } from '../lib/federation/agent.js'
import { createTunnelHub, TUNNEL_PATH } from '../lib/federation/hub.js'
import { createPeerAccess } from '../lib/peer.js'
import { createStreamRelay } from '../lib/stream-relay.js'

const quiet = { info() {}, warn() {} }
const TOKEN = 'e'.repeat(43)

test('a request crosses a tunnel and reaches the far daemon', async (t) => {
  // The far side's daemon: a real HTTP server, so the bytes have to be a valid request.
  const edgeDaemon = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ at: req.url, method: req.method }))
  })
  await new Promise((done) => edgeDaemon.listen(0, '127.0.0.1', done))
  t.after(() => {
    edgeDaemon.closeAllConnections?.()
    edgeDaemon.close()
  })

  const hub = createTunnelHub({
    logger: quiet,
    verifyToken: () => ({ id: 'edge-a', token: TOKEN }),
    deliver: async () => ({ ok: true }),
    listNodes: () => [
      { envId: 'self', label: 'main', kind: 'self', online: true },
      { envId: 'edge-a', label: 'A', kind: 'remote', online: true },
    ],
  })
  t.after(() => hub.close())

  const wss = new WebSocketServer({ noServer: true })
  const main = createServer((req, res) => {
    res.writeHead(200)
    res.end('main')
  })
  main.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== TUNNEL_PATH) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.accept({ id: 'edge-a' }, ws))
  })
  await new Promise((done) => main.listen(0, '127.0.0.1', done))
  t.after(() => {
    // `close()` stops accepting but does not drop a live client, and a listening server
    // keeps the process alive — which is how this file first finished green and hung.
    main.closeAllConnections?.()
    main.close()
    wss.close()
  })

  const agent = createTunnelAgent({
    upstreams: [{ url: `http://127.0.0.1:${main.address().port}`, token: TOKEN }],
    harnessPort: () => 0,
    daemonPort: () => edgeDaemon.address().port,
    logger: quiet,
  })
  agent.start()
  t.after(() => agent.stop())

  for (let i = 0; i < 100 && !hub.isOnline('edge-a'); i += 1) await new Promise((done) => setTimeout(done, 20))
  assert.equal(hub.isOnline('edge-a'), true, 'the tunnel should come up')

  const relay = createStreamRelay({ logger: quiet, openStream: (envId, options) => hub.openStream(envId, options) })
  t.after(() => relay.close())

  const peer = createPeerAccess({
    localPort: () => main.address().port,
    relay,
    knownIds: () => ['edge-a'],
    logger: quiet,
  })

  const answer = await peer.json('edge-a', { method: 'GET', path: '/admin/state' })
  assert.equal(answer.ok, true, `expected an answer, got ${JSON.stringify(answer)}`)
  assert.equal(answer.status, 200)
  assert.deepEqual(answer.body, { at: '/admin/state', method: 'GET' })
})

test('an unreachable environment is refused with a reason rather than hanging', async (t) => {
  const relay = createStreamRelay({ logger: quiet, openStream: () => ({ ok: false, error: 'offline' }) })
  t.after(() => relay.close())
  const peer = createPeerAccess({
    localPort: () => 1,
    relay,
    knownIds: () => [],
    logger: quiet,
  })
  const answer = await peer.json('nobody', { method: 'GET', path: '/admin/state' })
  assert.equal(answer.ok, false)
  assert.match(answer.error, /not reachable/u)
})
