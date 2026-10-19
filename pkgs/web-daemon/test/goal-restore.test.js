/**
 * Re-arming a goal after a restart.
 *
 * A restart drops the goal's continuation authority on purpose: the goal service sets
 * every freshly created agent to `disarmed`, so an autonomous loop cannot silently
 * continue after a crash. The cost is that an operator finds a long task stopped, so the
 * supervisor re-arms it — but only when the goal was still `active`, never when it was
 * paused on purpose.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { __test } from '../index.js'

const { restoreGoal } = __test

/** A context whose `goals` service behaves as told. */
function contextWith(goals) {
  return { get: (name) => (name === 'goals' ? goals : undefined) }
}

test('an active goal that a restart disarmed is re-armed', () => {
  const calls = []
  const goals = {
    get: () => ({ id: 'g1', revision: 3, phase: 'active', activation: 'disarmed' }),
    resume: (agent, ref) => { calls.push({ agent, ref }) },
  }
  const agent = { id: 'a1' }
  const result = restoreGoal(contextWith(goals), agent)
  assert.equal(result.decision, 're-armed')
  assert.equal(result.goalId, 'g1')
  assert.deepEqual(calls, [{ agent, ref: { id: 'g1', revision: 3 } }])
})

test('a paused goal is left alone', () => {
  // `pause()` writes the phase, so a paused goal was stopped on purpose. Resuming it here
  // would undo an operator's decision at every restart.
  let resumed = false
  const goals = {
    get: () => ({ id: 'g1', revision: 3, phase: 'paused', activation: 'disarmed' }),
    resume: () => { resumed = true },
  }
  const result = restoreGoal(contextWith(goals), { id: 'a1' })
  assert.equal(result.decision, 'left-alone')
  assert.equal(result.phase, 'paused')
  assert.equal(resumed, false)
})

test('blocked and complete goals are left alone', () => {
  for (const phase of ['blocked', 'complete']) {
    let resumed = false
    const goals = {
      get: () => ({ id: 'g1', revision: 1, phase, activation: 'disarmed' }),
      resume: () => { resumed = true },
    }
    assert.equal(restoreGoal(contextWith(goals), { id: 'a' }).decision, 'left-alone')
    assert.equal(resumed, false, phase)
  }
})

test('an already armed goal is not touched', () => {
  let resumed = false
  const goals = {
    get: () => ({ id: 'g1', revision: 1, phase: 'active', activation: 'armed' }),
    resume: () => { resumed = true },
  }
  assert.equal(restoreGoal(contextWith(goals), { id: 'a' }).decision, 'already-armed')
  assert.equal(resumed, false)
})

test('a refusal from the service is reported, not thrown', () => {
  // The round budget is the bound on this whole feature. A resume past it must not take
  // session recovery down with it.
  const goals = {
    get: () => ({ id: 'g1', revision: 1, phase: 'active', activation: 'disarmed' }),
    resume: () => { throw new Error('goal "g1" exhausted 3 goal rounds') },
  }
  const result = restoreGoal(contextWith(goals), { id: 'a' })
  assert.equal(result.decision, 'resume-refused')
  assert.match(result.error, /exhausted/u)
})

test('a deployment without the goal service still recovers sessions', () => {
  assert.equal(restoreGoal(contextWith(undefined), { id: 'a' }).decision, 'no-goal-service')
})

test('a session with no goal is not an error', () => {
  const goals = { get: () => undefined, resume: () => { throw new Error('should not run') } }
  assert.equal(restoreGoal(contextWith(goals), { id: 'a' }).decision, 'no-goal')
})

test('a failing read does not stop recovery', () => {
  const goals = { get: () => { throw new Error('agent is not live') }, resume: () => {} }
  const result = restoreGoal(contextWith(goals), { id: 'a' })
  assert.equal(result.decision, 'read-failed')
  assert.match(result.error, /not live/u)
})
