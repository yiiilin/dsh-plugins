import assert from 'node:assert/strict'
import test from 'node:test'
import {
  JOURNAL_EVENT,
  consultationIdFor,
  inputMessageIdFor,
  journalIdFor,
  makeJournalEvent,
  projectJournal,
} from '../lib/journal.js'

test('writes forward-compatible journal envelopes as ignorable durable records', () => {
  const event = makeJournalEvent(0, 'thread-bound', { threadId: 'mt_123' }, 42)
  assert.deepEqual(event, {
    type: JOURNAL_EVENT,
    seq: 0,
    time: 42,
    data: { version: 1, kind: 'thread-bound', threadId: 'mt_123' },
    ignorable: true,
  })
})

test('projects reset, active thread, and consultation recovery state from journal events', () => {
  const state = projectJournal([
    makeJournalEvent(0, 'thread-bound', { threadId: 'mt_old', configFingerprint: 'a' }, 1),
    makeJournalEvent(1, 'consultation-accepted', {
      hostCallId: 'call-1',
      inputHash: 'hash-1',
      threadId: 'mt_old',
      consultationId: 'mc_1',
      inputMessageId: 'mentor-message-1',
    }, 2),
    makeJournalEvent(2, 'consultation-dispatched', { hostCallId: 'call-1' }, 3),
    makeJournalEvent(3, 'consultation-settled', { hostCallId: 'call-1', revision: 1 }, 4),
    makeJournalEvent(4, 'thread-reset', { threadId: 'mt_old', epoch: 1 }, 5),
    makeJournalEvent(5, 'thread-bound', { threadId: 'mt_new', configFingerprint: 'a', epoch: 1 }, 6),
  ])
  assert.equal(state.epoch, 1)
  assert.deepEqual(state.activeThread, { threadId: 'mt_new', configFingerprint: 'a', epoch: 1 })
  assert.equal(state.retiredThreads.has('mt_old'), true)
  assert.equal(state.calls.get('call-1').status, 'settled')
  assert.equal(state.calls.get('call-1').revision, 1)
})

test('derives stable non-secret session, thread, consultation, and message identities', () => {
  assert.equal(journalIdFor('parent-a'), journalIdFor('parent-a'))
  assert.notEqual(journalIdFor('parent-a'), journalIdFor('parent-b'))
  assert.match(journalIdFor('parent-a'), /^[A-Za-z0-9_-]+$/u)

  const thread = 'mt_abcdefghijklmnop'
  assert.match(consultationIdFor(thread, 'call-1'), /^mc_[A-Za-z0-9_-]{16,80}$/u)
  assert.match(inputMessageIdFor(thread, 'call-1'), /^[A-Za-z0-9_-]{16,80}$/u)
})
