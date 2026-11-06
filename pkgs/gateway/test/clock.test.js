/**
 * Clocks across machines that do not share one.
 *
 * The estimate only has to be good enough to say "last seen a few minutes ago" honestly.
 * Ordering must never depend on it: an NTP correction can move a wall clock backwards,
 * and `seq` is what decides which snapshot wins.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createClockSync, MAX_SAMPLES, measure, monotonicNow } from '../lib/federation/clock.js'

test('a peer whose clock is ahead is measured as ahead', () => {
  // A sends at 1000; B is 30 s ahead, so it stamps 31000 and replies at 31010;
  // A receives at 1010.
  const { offset, rtt, valid } = measure(1000, 31000, 31010, 1010)
  assert.equal(valid, true)
  assert.equal(offset, 30000)
  assert.equal(rtt, 0, 'an ideal link with no delay')
})

test('symmetric network delay is halved out of the offset', () => {
  // 5 ms each way: A sends at 1000, the request lands 5 ms later, B replies 5 ms after
  // that (two stamps 5 ms apart would make the reply slower than the request), and A
  // receives 10 ms after sending.
  const { offset, rtt } = measure(1000, 31005, 31013, 1018)
  assert.ok(Math.abs(offset - 30000) < 0.01, `expected ~30000, got ${offset}`)
  assert.equal(rtt, 10)
})

test('a peer whose clock is behind is measured as behind', () => {
  const { offset } = measure(500000, 1000, 1010, 500020)
  assert.ok(offset < 0, 'a negative offset means the peer is behind')
})

test('an inconsistent exchange is refused rather than used', () => {
  // t3 before t2 is impossible; a sample like this must not poison the estimate.
  const { valid } = measure(1000, 5000, 4000, 1100)
  assert.equal(valid, false)
})

test('the sample with the smallest round trip wins, not the newest', () => {
  // A busy link gives a worse estimate than an idle one; keeping the newest would mean
  // the estimate degrades exactly when the machine is loaded.
  const sync = createClockSync()
  sync.add(measure(1000, 31000, 31010, 1200))   // rtt 190, offset 29905
  sync.add(measure(1000, 31000, 31010, 1010))   // rtt 0,   offset 30000
  assert.equal(sync.estimate().offset, 30000)
  assert.equal(sync.estimate().rtt, 0)
})

test('invalid samples are ignored', () => {
  const sync = createClockSync()
  sync.add(measure(1000, 31000, 31010, 1010))
  const before = sync.estimate()
  sync.add({ valid: false, offset: 999999, rtt: 1 })
  assert.deepEqual(sync.estimate(), before)
})

test('an unknown offset stays unknown instead of assuming the clocks agree', () => {
  // Showing "last seen 0 ms ago" for a peer whose clock is an hour off would be worse
  // than admitting the age is unknown.
  const sync = createClockSync()
  assert.equal(sync.estimate(), undefined)
  assert.equal(sync.peerNow(1234), undefined)
})

test("peerNow converts this node's clock into the peer's", () => {
  const sync = createClockSync()
  sync.add(measure(1000, 61000, 61010, 1010))   // peer 60 s ahead
  assert.equal(sync.peerNow(5000), 65000)
})

test('samples are bounded', () => {
  const sync = createClockSync({ maxSamples: 3 })
  for (let i = 0; i < 10; i += 1) sync.add(measure(1000, 31000, 31010, 1010 + i))
  assert.equal(sync.estimate().samples, 3)
  assert.ok(MAX_SAMPLES >= 3)
})

test('the monotonic clock does not go backwards', async () => {
  const first = monotonicNow()
  await new Promise((done) => setTimeout(done, 5))
  assert.ok(monotonicNow() > first)
})
