/**
 * The federation's shape, and how a node decides where a stream goes.
 *
 * The interesting cases are the ones that were bugs before: an edge that asked its own
 * table whether a peer was online (always false there), and a snapshot arriving out of
 * order and resurrecting a node that had already gone.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTopologyView,
  edgeRow,
  isNewer,
  nodeRow,
  snapshot,
  TOPOLOGY_FRAME,
} from '../lib/federation/topology.js'

const main = { id: 'self' }
const edgeA = { id: 'n95c', label: '6.13', kind: 'remote', hostname: 'six13', lastSeen: 100 }
const edgeB = { id: 'dev2', label: 'dev', kind: 'remote', hostname: 'devbox' }

const view = (rows, edges, seq = 1) => {
  const v = createTopologyView({ selfId: 'self' })
  v.apply(snapshot({ nodes: rows, edges, seq }))
  return v
}

// --- rows ---------------------------------------------------------------------

test('a node row carries the metadata a peer needs, and no token', () => {
  const row = nodeRow(edgeA, { online: true })
  assert.deepEqual(row, {
    envId: 'n95c', label: '6.13', kind: 'remote', hostname: 'six13', online: true, lastSeen: 100,
  })
  assert.equal('token' in row, false, 'a secret has no business in a broadcast')
})

test("this node's own row is always online and marked as self", () => {
  const row = nodeRow(main, { online: false, selfId: 'self' })
  assert.equal(row.online, true, 'a node is reachable from itself')
  assert.equal(row.kind, 'self')
})

// --- ordering -----------------------------------------------------------------

test('a newer snapshot replaces an older one, an older one is ignored', () => {
  const older = snapshot({ nodes: [], edges: [], seq: 5 })
  const newer = snapshot({ nodes: [], edges: [], seq: 6 })
  assert.equal(isNewer(older, newer), true)
  assert.equal(isNewer(newer, older), false, 'a late broadcast must not win')
  assert.equal(isNewer(newer, newer), false, 'a duplicate changes nothing')
})

test('a malformed snapshot is refused rather than adopted', () => {
  const held = snapshot({ nodes: [], edges: [], seq: 1 })
  assert.equal(isNewer(held, { seq: 9 }), false, 'no nodes/edges')
  assert.equal(isNewer(held, { seq: 9, nodes: [], edges: 'x' }), false)
  assert.equal(isNewer(held, undefined), false)
})

test('the view keeps the newest snapshot it was given', () => {
  const v = view([nodeRow(edgeA)], [edgeRow('n95c')], 1)
  assert.equal(v.apply(snapshot({ seq: 1, nodes: [], edges: [] })), false, 'same seq is not newer')
  assert.equal(v.nodes().length, 1)
})

// --- routing ------------------------------------------------------------------

test('routing to this node is answered locally, not forwarded', () => {
  const v = view([], [])
  assert.deepEqual(v.routeTo('self'), { done: true })
  assert.deepEqual(v.routeTo(''), { done: true }, 'an empty target is this node')
})

test('a direct edge names no intermediate hop', () => {
  const v = view([nodeRow(edgeA)], [edgeRow('n95c')])
  assert.deepEqual(v.routeTo('n95c'), { done: false, next: '' })
})

test('an edge reached through an intermediate names it', () => {
  // The shape a tree or mesh would take; a star never produces one today.
  const v = view([nodeRow(edgeB)], [edgeRow('dev2', { via: 'n95c', hops: 1 })])
  assert.deepEqual(v.routeTo('dev2'), { done: false, next: 'n95c' })
})

test('an unknown environment has no route rather than a wrong one', () => {
  // Returning "direct" here would send the stream into nothing; the caller needs to be
  // able to say "I have no route to that" instead.
  const v = view([], [])
  assert.equal(v.routeTo('nowhere'), undefined)
})

test('an edge that is listed but offline is still routed, so the failure is real', () => {
  // Deciding "offline" from a cached snapshot would be guessing; the node that holds the
  // tunnel is the authority, and its refusal is the truthful answer.
  const v = view([nodeRow(edgeA, { online: false })], [edgeRow('n95c')])
  assert.equal(v.get('n95c').online, false)
  assert.deepEqual(v.routeTo('n95c'), { done: false, next: '' })
})

test('a leaf learns its own id from the broadcast, and then routes to itself locally', () => {
  // A leaf knows only its token; without this it would treat its own id as a peer and
  // forward a stream meant for itself.
  const v = createTopologyView({})
  const table = snapshot({ seq: 1, nodes: [nodeRow(edgeA, { online: true })], edges: [edgeRow('n95c')] })
  v.setSelfId('n95c')
  v.apply(table)
  assert.deepEqual(v.routeTo('n95c'), { done: true })
})

// --- concurrent change ---------------------------------------------------------

test('successive broadcasts produce increasing sequences and the newest table', async () => {
  // A broadcast can synchronously trigger another (a failing send closes a socket, which
  // broadcasts again). Without coalescing, the inner call built from the newer table and
  // took a higher sequence, then the outer loop finished the older snapshot under a lower
  // one — peers would hold a stale table believing it current.
  const { createTunnelHub } = await import('../lib/federation/hub.js')

  const table = [
    { envId: 'self', kind: 'self', label: 'm', online: true },
    { envId: 'a', kind: 'remote', label: 'A', online: true },
  ]
  const frames = []
  const socket = {
    on() {},
    send(buffer) {
      const length = buffer.readUInt32BE(0)
      frames.push({
        type: buffer.readUInt8(4),
        body: JSON.parse(buffer.subarray(21, 21 + length).toString('utf8')),
      })
    },
    close() {},
  }
  const hub = createTunnelHub({
    logger: { info() {}, warn() {} },
    verifyToken: () => undefined,
    listNodes: () => table,
  })
  hub.accept({ id: 'a' }, socket)

  table.push({ envId: 'b', kind: 'remote', label: 'B', online: true })
  hub.broadcastTopology()

  assert.ok(frames.length >= 2)
  const sequences = frames.map((frame) => frame.body.seq)
  assert.deepEqual(sequences, [...sequences].sort((x, y) => x - y), 'sequences must increase')
  const last = frames[frames.length - 1]
  assert.equal(last.type, TOPOLOGY_FRAME)
  assert.equal(last.body.nodes.length, 3, 'the final frame carries the newest table')
  assert.equal(last.body.selfEnvId, 'a', 'each edge is told which environment it is')
  hub.close()
})

test('a row already in wire shape keeps its envId', () => {
  // `listNodes` hands the hub rows keyed `envId` while a stored record is keyed `id`.
  // Reading only one of them produced nodes whose `envId` was null — and a node with no
  // id cannot be a route destination, so routing silently found nothing.
  const wireShape = { envId: 'n95c', label: '6.13', kind: 'remote', online: true, lastSeen: 1 }
  assert.equal(nodeRow(wireShape).envId, 'n95c')
  assert.equal(nodeRow(edgeA).envId, 'n95c', 'registry shape still works')
})
