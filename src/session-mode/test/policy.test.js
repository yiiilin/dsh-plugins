import assert from 'node:assert/strict'
import test from 'node:test'

const policy = () => import('../policy.js')
const main = { options: {}, session: { header: {} } }
const child = { options: {}, session: { header: { origin: 'subagent', delegationDepth: 1, parentSession: 'parent' } } }

test('delegate-writes denies unaudited main tools including shell, PTC and runtime writes', async () => {
  const { toolDenial, DEFAULT_ALLOWED_TOOLS } = await policy()
  for (const name of ['write', 'edit', 'bash', 'pwsh', 'run_code', 'workflow', 'ralph', 'cordis_mount', 'new_write_tool']) {
    assert.equal(typeof toolDenial({ mode: 'delegate-writes' }, main, name, DEFAULT_ALLOWED_TOOLS), 'string', name)
  }
  for (const name of ['read', 'grep', 'subagent', 'subagent_fork', 'send_message', 'job_output']) {
    assert.equal(toolDenial({ mode: 'delegate-writes' }, main, name, DEFAULT_ALLOWED_TOOLS), undefined, name)
  }
})

test('delegate-writes workers and normal main retain tools; missing identity or policy fails closed', async () => {
  const { toolDenial, DEFAULT_ALLOWED_TOOLS } = await policy()
  assert.equal(toolDenial({ mode: 'delegate-writes' }, child, 'write', DEFAULT_ALLOWED_TOOLS), undefined)
  assert.equal(toolDenial({ mode: 'normal' }, main, 'bash', DEFAULT_ALLOWED_TOOLS), undefined)
  assert.equal(typeof toolDenial(undefined, main, 'write', DEFAULT_ALLOWED_TOOLS), 'string')
  assert.equal(typeof toolDenial({ mode: 'normal' }, undefined, 'write', DEFAULT_ALLOWED_TOOLS), 'string')
})

test('cold workers cannot lower persisted depth; ordinary forks are still main agents', async () => {
  const { isWorker } = await policy()
  assert.equal(isWorker(child), true)
  assert.equal(isWorker({ ...child, options: { subagentDepth: 0 } }), true)
  assert.equal(isWorker({ options: {}, session: { header: { parentSession: 'parent', isSeeded: true } } }), false)
  assert.throws(() => isWorker({ options: { subagentDepth: -1 }, session: { header: {} } }))
})

test('mode prompts differ and workers do not inherit the coordinator instruction', async () => {
  const { promptFor } = await policy()
  const config = { delegateWritesPrompt: 'Coordinator', normalPrompt: 'Executor' }
  assert.equal(promptFor({ mode: 'delegate-writes' }, main, config), 'Coordinator')
  assert.equal(promptFor({ mode: 'normal' }, main, config), 'Executor')
  const workerPrompt = promptFor({ mode: 'delegate-writes' }, child, config)
  assert.ok(workerPrompt.includes('Executor'))
  assert.ok(!workerPrompt.includes('Coordinator'))
})

test('live prompt config wrappers are sampled on assembly and missing policy fails closed', async () => {
  const { promptFor } = await policy()
  let value = 'first'
  const config = { normalPrompt: { get: () => value } }
  assert.equal(promptFor({ mode: 'normal' }, main, config), 'first')
  value = 'second'
  assert.equal(promptFor({ mode: 'normal' }, main, config), 'second')
  assert.throws(() => promptFor(undefined, main, config))
  assert.ok(promptFor({ mode: 'normal' }, main, {}).includes('normal mode'))
})

test('policy records validate mode, identity, version and revision', async () => {
  const { validatePolicy } = await policy()
  const valid = { version: 1, sessionId: 's', mode: 'delegate-writes', revision: 2 }
  assert.deepEqual(validatePolicy(valid, 's'), valid)
  for (const bad of [{ ...valid, mode: 'other' }, { ...valid, sessionId: 'other' }, { ...valid, version: 2 }, { ...valid, revision: -1 }, null]) {
    assert.throws(() => validatePolicy(bad, 's'))
  }
})
