/**
 * A tunnel has to notice when it dies silently.
 *
 * These tests cover the failure that left a healthy edge unreachable for 49 hours: the
 * link went away, no FIN or RST arrived, `close` never fired on the edge, and because the
 * reconnect lives on `close` the edge never came back. Anything that pings — even an
 * application heartbeat — would have caught it; nothing did.
 *
 * The timings here are shortened, so every case is a fraction of a second. The shipped
 * interval and timeout live in `keepalive.js`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { keepAlive, HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } from '../lib/federation/keepalive.js'

/** A logger that records warnings instead of printing them. */
const recorder = () => {
  const warnings = []
  return { warnings, logger: { info() {}, warn: (line) => warnings.push(line) } }
}

/**
 * A socket double that reports whatever the test tells it to.
 *
 * Only the members `keepAlive` touches are here: `ping`, `terminate`, and the two
 * events it listens on.
 */
const fakeSocket = ({ answersPings = true } = {}) => {
  const handlers = new Map()
  const state = { pings: 0, terminated: false }
  const socket = {
    ping() {
      state.pings += 1
      // A live peer answers with a pong; a dead one never does. Answering synchronously
      // is not how a network behaves, but it is what makes the assertion deterministic:
      // what matters is that any inbound frame counts as proof of life.
      if (answersPings) socket.emit('pong')
    },
    terminate() {
      state.terminated = true
      socket.emit('close')
    },
    on(event, handler) {
      const existing = handlers.get(event) ?? []
      existing.push(handler)
      handlers.set(event, existing)
      return socket
    },
    emit(event, ...args) {
      for (const handler of handlers.get(event) ?? []) handler(...args)
    },
  }
  return { socket, state }
}

test('a quiet socket is pinged, which keeps a live peer alive', async () => {
  const { socket, state } = fakeSocket()
  const { warnings, logger } = recorder()
  const watcher = keepAlive(socket, { label: 'env-a', logger, intervalMs: 10, timeoutMs: 1000 })
  await new Promise((done) => setTimeout(done, 55))
  watcher.stop()

  assert.ok(state.pings >= 3, `a live socket must keep being pinged, saw ${state.pings}`)
  assert.equal(state.terminated, false, 'a peer that answers must never be dropped')
  assert.deepEqual(warnings, [])
})

test('a peer that stops answering is terminated, so its reconnect can run', async () => {
  // The peer is gone: no pong ever comes back. Without the watcher nothing would happen,
  // because the socket is still open from this process's point of view.
  const { socket, state } = fakeSocket({ answersPings: false })
  const { warnings, logger } = recorder()
  keepAlive(socket, { label: 'env-a', logger, intervalMs: 5, timeoutMs: 30 })

  // `terminate()` is what fires `close`, and `close` is what the edge reconnects on.
  for (let i = 0; i < 100 && !state.terminated; i += 1) {
    await new Promise((done) => setTimeout(done, 5))
  }

  assert.equal(state.terminated, true, 'a silent socket must be terminated, not left open')
  assert.ok(warnings.some((line) => line.includes('silent')), `expected a warning naming the silence, got ${JSON.stringify(warnings)}`)
})

test('any inbound traffic counts as proof of life, not only a pong', async () => {
  // A busy tunnel sends request frames constantly and must never be pinged into a
  // timeout just because pongs are rare.
  const { socket, state } = fakeSocket({ answersPings: false })
  const { logger } = recorder()
  keepAlive(socket, { label: 'env-a', logger, intervalMs: 5, timeoutMs: 40 })

  for (let i = 0; i < 12; i += 1) {
    socket.emit('message', Buffer.from('anything'))
    await new Promise((done) => setTimeout(done, 5))
  }

  assert.equal(state.terminated, false, 'a socket carrying traffic is alive even with no pong')
})

test('stopping the watcher leaves the socket alone', async () => {
  const { socket, state } = fakeSocket({ answersPings: false })
  const { logger } = recorder()
  const watcher = keepAlive(socket, { label: 'env-a', logger, intervalMs: 5, timeoutMs: 20 })
  watcher.stop()
  await new Promise((done) => setTimeout(done, 60))

  assert.equal(state.terminated, false, 'a stopped watcher must not touch its socket')
  assert.equal(state.pings, 0, 'a stopped watcher must not ping')
})

test('the shipped timeout is several heartbeat intervals, not one', () => {
  // One missed ping is a dropped packet, not a dead machine. If these ever collapse to
  // the same value, every transient stall on a real network becomes a reconnect storm.
  assert.ok(
    HEARTBEAT_TIMEOUT_MS >= HEARTBEAT_INTERVAL_MS * 3,
    `timeout ${HEARTBEAT_TIMEOUT_MS}ms must allow at least three ${HEARTBEAT_INTERVAL_MS}ms intervals`,
  )
  // A dead edge has to be replaced in minutes, not in days. The bug this fixes lasted 49
  // hours precisely because nothing bounded it.
  assert.ok(HEARTBEAT_TIMEOUT_MS <= 300_000, `timeout ${HEARTBEAT_TIMEOUT_MS}ms is too long to call it a recovery interval`)
})
