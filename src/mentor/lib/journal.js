import { createHash } from 'node:crypto'
import { copyCanonicalResult } from './protocol.js'

export const JOURNAL_EVENT = 'mentor/journal'
const JOURNAL_VERSION = 1

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function makeJournalEvent(seq, kind, data, time = Date.now()) {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new TypeError('journal seq must be a non-negative integer')
  if (typeof kind !== 'string' || kind.trim() === '') throw new TypeError('journal kind is required')
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('journal data must be an object')
  if (!Number.isSafeInteger(time) || time < 0) throw new TypeError('journal time must be a non-negative integer')
  return {
    type: JOURNAL_EVENT,
    seq,
    time,
    data: { version: JOURNAL_VERSION, kind, ...data },
    ignorable: true,
  }
}

export function projectJournal(events) {
  const state = {
    epoch: 0,
    activeThread: null,
    retiredThreads: new Set(),
    calls: new Map(),
  }
  for (const event of events) {
    if (event?.type !== JOURNAL_EVENT || event.ignorable !== true) continue
    const data = event.data
    if (data?.version !== JOURNAL_VERSION || typeof data.kind !== 'string') continue
    if (data.kind === 'thread-bound' && typeof data.threadId === 'string') {
      state.activeThread = {
        threadId: data.threadId,
        configFingerprint: data.configFingerprint,
        epoch: Number.isSafeInteger(data.epoch) ? data.epoch : state.epoch,
      }
      state.epoch = state.activeThread.epoch
    } else if (data.kind === 'thread-retired' && typeof data.threadId === 'string') {
      state.retiredThreads.add(data.threadId)
      if (state.activeThread?.threadId === data.threadId) state.activeThread = null
    } else if (data.kind === 'thread-reset') {
      if (typeof data.threadId === 'string') {
        state.retiredThreads.add(data.threadId)
        if (state.activeThread?.threadId === data.threadId) state.activeThread = null
      }
      if (Number.isSafeInteger(data.epoch) && data.epoch > state.epoch) state.epoch = data.epoch
    } else if (data.kind === 'consultation-accepted' && typeof data.hostCallId === 'string') {
      state.calls.set(data.hostCallId, { ...data, status: 'accepted', generationSent: true })
    } else if (data.kind === 'consultation-replayed' && typeof data.hostCallId === 'string') {
      const source = typeof data.replayedFrom === 'string' ? state.calls.get(data.replayedFrom) : undefined
      const result = copyCanonicalResult(source?.result ?? data.result)
      if (result !== undefined) {
        state.calls.set(data.hostCallId, {
          ...data,
          result,
          revision: source?.revision ?? data.revision ?? result.context_revision,
          usage: source?.usage ?? data.usage ?? result.usage,
          status: 'settled',
          generationSent: false,
          deliveryStatus: 'pending',
        })
      }
    } else if (data.kind === 'consultation-dispatched') {
      const call = state.calls.get(data.hostCallId)
      if (call !== undefined) {
        call.status = 'dispatched'
        // Recorded measurements only: nothing here is enforced as a budget.
        if (Number.isSafeInteger(data.contextUpperBoundBytes)) call.contextUpperBoundBytes = data.contextUpperBoundBytes
        if (Number.isSafeInteger(data.requestMaxTokens)) call.requestMaxTokens = data.requestMaxTokens
      }
    } else if (data.kind === 'consultation-settled') {
      const call = state.calls.get(data.hostCallId)
      if (call !== undefined) {
        call.status = 'settled'
        call.revision = data.revision
        call.usage = data.usage
        if (Number.isSafeInteger(data.replyUtf8Bytes)) call.replyUtf8Bytes = data.replyUtf8Bytes
        call.result = copyCanonicalResult(data.result)
        call.deliveryStatus = data.deliveryStatus ?? 'pending'
        call.deliveryReason = data.deliveryReason
      }
    } else if (data.kind === 'consultation-delivered') {
      const call = state.calls.get(data.hostCallId)
      if (call !== undefined) {
        call.deliveryStatus = 'delivered'
        for (const related of state.calls.values()) {
          if (related.consultationId === call.consultationId) related.deliveryStatus = 'delivered'
        }
      }
    } else if (data.kind === 'consultation-undelivered') {
      const call = state.calls.get(data.hostCallId)
      if (call !== undefined) {
        call.deliveryStatus = 'undelivered'
        call.deliveryReason = data.reason
      }
    } else if (data.kind === 'consultation-aborted') {
      const call = state.calls.get(data.hostCallId)
      if (call !== undefined) {
        call.status = 'aborted'
        call.reason = data.reason
      }
    } else if (data.kind === 'consultation-indeterminate') {
      const call = state.calls.get(data.hostCallId)
      if (call !== undefined) {
        call.status = 'indeterminate'
        call.reason = data.reason
        call.usage = data.usage
      }
    }
  }
  return state
}

export function journalIdFor(parentSessionId) {
  if (typeof parentSessionId !== 'string' || parentSessionId === '') throw new TypeError('parent session id is required')
  return `mentor-journal-${digest(parentSessionId).slice(0, 40)}`
}

export function consultationIdFor(threadId, hostCallId) {
  if (typeof threadId !== 'string' || typeof hostCallId !== 'string' || hostCallId === '') {
    throw new TypeError('thread id and host call id are required')
  }
  return `mc_${digest(`${threadId}\0${hostCallId}`).slice(0, 32)}`
}

export function inputMessageIdFor(threadId, hostCallId) {
  if (typeof threadId !== 'string' || typeof hostCallId !== 'string' || hostCallId === '') {
    throw new TypeError('thread id and host call id are required')
  }
  return `mentor_${digest(`${threadId}\0${hostCallId}`).slice(0, 32)}`
}
