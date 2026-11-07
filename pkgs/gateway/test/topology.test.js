/**
 * The federation's shape, and how a node decides where a stream goes.
 *
 * This is a link-state table: every node holds the same facts — each environment's
 * metadata and the set of neighbours it is directly attached to — and derives its own next
 * hop from that graph. The tests below are the cases that were bugs under the previous
 * design, which broadcast a computed route instead: a table that goes stale the moment a
 * link dies, a second path never being discovered, and a peer that stayed "reachable"
 * through a machine that was gone.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createTopologyView,
  linkState,
  nodeRow,
  TOPOLOGY_FRAME,
} from '../lib/federation/topology.js'

const edgeA = { id: 'n95c', label: '6.13', hostname: 'six13', lastSeen: 100 }
const edgeB = { id: 'dev2', label: 'dev', hostname: 'devbox' }

test('a node row carries the metadata a peer needs, and no token', () => {
  const row = nodeRow({ ...edgeA, token: 'secret' }, { online: true, selfId: '' })
  assert.deepEqual(row, {
    envId: 'n95c', label: '6.13', hostname: 'six13', online: true, lastSeen: 100,
    // The port a peer's own UI answers on: not derivable, so it travels with the table.
    harnessPort: 0,
  })
})

test('an advertisement is sorted and de-duplicated, so two nodes cannot disagree', () => {
  const state = linkState('a', ['z', 'b', 'z', ''], 3)
  assert.deepEqual(state, { envId: 'a', neighbours: ['b', 'z'], seq: 3 })
})

test('a direct neighbour is its own next hop', () => {
  const v = createTopologyView({ selfId: 'me' })
  v.learn(linkState('me', ['peer'], 1))
  v.learn(linkState('peer', ['me'], 1))
  assert.deepEqual(v.routeTo('peer'), { done: false, next: 'peer' })
})

test('a two-hop node is reached through the neighbour that leads there', () => {
  const v = createTopologyView({ selfId: 'me' })
  v.learn(linkState('me', ['mid'], 1))
  v.learn(linkState('mid', ['me', 'far'], 1))
  v.learn(linkState('far', ['mid'], 1))
  assert.deepEqual(v.routeTo('far'), { done: false, next: 'mid' })
  assert.equal(v.reaches('far'), true)
})

test('a route that crossed a dead link disappears, and another is found if one exists', () => {
  // The case the previous design could not express: two paths to the same node. It
  // broadcast one answer, so when that answer's link died the node stayed listed as
  // reachable and every stream failed on a hop that was no longer there.
  const v = createTopologyView({ selfId: 'me' })
  v.learn(linkState('me', ['a'], 1))
  v.learn(linkState('a', ['me', 'far'], 1))
  v.learn(linkState('far', ['a', 'b'], 1))
  v.learn(linkState('b', ['far', 'me'], 1))
  assert.equal(v.reaches('far'), true)

  v.forget('a')
  v.learn(linkState('me', ['b'], 2))
  // `b` still lists `far`, so the destination survives — on the other path.
  assert.equal(v.reaches('far'), true)
})

test('losing the only path makes a node unreachable, without a special case', () => {
  const v = createTopologyView({ selfId: 'me' })
  v.learn(linkState('me', ['a'], 1))
  v.learn(linkState('a', ['me', 'far'], 1))
  v.learn(linkState('far', ['a'], 1))
  assert.equal(v.reaches('far'), true)
  v.forget('a')
  assert.equal(v.reaches('far'), false)
  assert.equal(v.routeTo('far'), undefined)
})

test('forgetting a node also removes it from every neighbour list', () => {
  // A departed node left inside another node's adjacency keeps a path alive through a
  // machine that is not there.
  const v = createTopologyView({ selfId: 'me' })
  v.learn(linkState('me', ['gone', 'kept'], 1))
  v.learn(linkState('kept', ['me', 'gone'], 1))
  v.forget('gone')
  assert.equal(v.reaches('gone'), false)
  assert.deepEqual(v.advertisements().find((s) => s.envId === 'kept').neighbours, ['me'])
})

test('newer wins and an older copy cannot overtake it', () => {
  // Two paths carry the same node's advertisement with different counters. Accepting
  // anything that merely differed let the stale copy keep overwriting the fresh one, and
  // the node oscillated between its real neighbour list and an empty one.
  const v = createTopologyView({ selfId: 'me' })
  assert.equal(v.learn(linkState('peer', ['me', 'far'], 9)), true)
  assert.equal(v.learn(linkState('peer', [], 3)), false, 'older copy is a duplicate')
  assert.deepEqual(v.advertisements()[0].neighbours, ['far', 'me'])
  assert.equal(v.learn(linkState('peer', ['me', 'far'], 9)), false, 'same message twice')
  assert.equal(v.learn(linkState('peer', ['me'], 10)), true, 'newer wins')
})

test('two upstreams reporting different parts of the graph both count', () => {
  const v = createTopologyView({ selfId: 'me' })
  v.learn(linkState('me', ['up1', 'up2'], 1))
  v.learn(linkState('up1', ['me', 'only1'], 1))
  v.learn(linkState('up2', ['me', 'only2'], 1))
  assert.deepEqual(v.routeTo('only1'), { done: false, next: 'up1' })
  assert.deepEqual(v.routeTo('only2'), { done: false, next: 'up2' })
})

test('a cycle terminates instead of looping', () => {
  const v = createTopologyView({ selfId: 'me' })
  v.learn(linkState('me', ['a', 'c'], 1))
  v.learn(linkState('a', ['me', 'b'], 1))
  v.learn(linkState('b', ['a', 'c'], 1))
  v.learn(linkState('c', ['b', 'me'], 1))
  assert.equal(v.reaches('x'), false)
  assert.equal(v.reaches('b'), true)
})

test('metadata survives without any advertisement', () => {
  const v = createTopologyView({ selfId: 'me' })
  v.describe(nodeRow(edgeB, { online: true }))
  assert.equal(v.get('dev2')?.label, 'dev')
  assert.equal(v.reaches('dev2'), false, 'described but not connected')
})

test('outbound withholds the peer being told, and always names itself', () => {
  const v = createTopologyView({ selfId: 'me' })
  v.learn(linkState('me', ['them', 'other'], 1))
  v.learn(linkState('other', ['me'], 1))
  const table = v.outbound({ exclude: 'them', self: v.selfAdvertisement(['them', 'other']) })
  const mine = table.states.find((s) => s.envId === 'me')
  assert.ok(mine !== undefined, 'the sender is always in its own message')
  assert.deepEqual(mine.neighbours, ['other', 'them'], 'a neighbour list is a fact, not a route')
  assert.equal(table.states.some((s) => s.envId === 'them'), false)
})

test('the frame tag is stable: it is part of the wire format', () => {
  assert.equal(TOPOLOGY_FRAME, 4)
})

test('a view built before its id is known says so, and routes nothing', () => {
  // The hub and the agent both construct a view before the id is read from disk. Every
  // method used to check `me === ''` separately, and the one that forgot produced a graph
  // with no origin — which reads exactly like "no route" and cost a long time to find.
  const v = createTopologyView({ selfId: '' })
  assert.equal(v.named, false)
  v.learn(linkState('peer', ['me'], 1))
  assert.equal(v.reaches('peer'), false, 'no origin means no route')

  v.setSelfId('me')
  assert.equal(v.named, true)
  assert.equal(v.reaches('peer'), true, 'the same table routes once the id is known')
})

test('an empty id does not name the view', () => {
  const v = createTopologyView({ selfId: '' })
  v.setSelfId('')
  assert.equal(v.named, false, 'an empty id is not an identity')
})
