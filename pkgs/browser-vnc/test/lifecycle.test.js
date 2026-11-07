/**
 * The browser-instance lifecycle.
 *
 * These assert the table rather than a boot: the states used to be implied by assignments
 * spread across `boot` and `close`, and the one that mattered most — closing an instance
 * wrote `failed` — could only be observed by driving a real browser stack to completion.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createInstanceRegistry } from '../instances.js'

/** A registry with nothing configured: enough to reach the exported table. */
const registry = () => createInstanceRegistry({ log: () => {} })

/** Apply a sequence of events to a fresh entry in `state`. */
const run = (state, events) => {
  const { advance } = registry()
  const entry = { state }
  for (const event of events) advance(entry, event)
  return entry.state
}

test('closing is its own state, not a kind of failure', () => {
  // A window the user dismissed must not be counted, retried, or explained as broken.
  assert.equal(run('starting', ['close']), 'closed')
  assert.equal(run('ready', ['close']), 'closed')
  assert.equal(run('failed', ['close']), 'closed')
})

test('a boot that finishes after a close cannot revive the instance', () => {
  // The boot callback runs from an await, so it can land after the user closed the window.
  assert.equal(run('starting', ['close', 'booted']), 'closed')
})

test('a failed boot stays failed until it is closed', () => {
  assert.equal(run('starting', ['failed']), 'failed')
  assert.equal(run('failed', ['booted']), 'failed', 'a late success does not clear a failure')
})

test('closed is terminal', () => {
  for (const event of ['booted', 'failed', 'close']) {
    assert.equal(run('closed', [event]), 'closed', `closed is unchanged by ${event}`)
  }
})

test('the table names every state a row can report', () => {
  // The client validates a row's state against its own list; a state missing here would
  // reach the UI as "unknown".
  assert.deepEqual(Object.keys(registry().INSTANCE_TRANSITIONS).sort(), ['closed', 'failed', 'ready', 'starting'])
})

test('an unknown state is inert rather than throwing', () => {
  assert.equal(run('not-a-state', ['close']), 'not-a-state')
})
