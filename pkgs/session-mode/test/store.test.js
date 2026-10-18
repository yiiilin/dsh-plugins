import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const store = () => import('../store.js')

test('host profileContext, not stale shell environment, owns the policy namespace', async () => {
  const { defaultStateDir } = await store()
  const first = defaultStateDir({ home: '/tmp/dsh-host-home', dir: '/tmp/profile-one', name: 'one' })
  const second = defaultStateDir({ home: '/tmp/dsh-host-home', dir: '/tmp/profile-two', name: 'two' })
  assert.ok(first.startsWith('/tmp/dsh-host-home/session-modes/'))
  assert.notEqual(first, second)
})

test('default policy directories are profile-scoped and require absolute overrides', async () => {
  const { defaultStateDir, createPolicyStore } = await store()
  const keys = ['DSH_HOME', 'DSH_PROFILE_DIR', 'DSH_PROFILE']
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  try {
    process.env.DSH_HOME = '/tmp/dsh-mode-home'
    process.env.DSH_PROFILE_DIR = '/tmp/dsh-mode-profile-one'
    const first = defaultStateDir()
    assert.ok(first.startsWith('/tmp/dsh-mode-home/session-modes/'))
    process.env.DSH_PROFILE_DIR = '/tmp/dsh-mode-profile-two'
    assert.notEqual(defaultStateDir(), first)
    delete process.env.DSH_PROFILE_DIR
    process.env.DSH_PROFILE = 'test-profile'
    assert.ok(defaultStateDir().startsWith('/tmp/dsh-mode-home/'))
    delete process.env.DSH_HOME
    delete process.env.DSH_PROFILE
    assert.ok(defaultStateDir().includes('.dsh/session-modes/'))
    assert.throws(() => createPolicyStore('relative'))
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-session-mode-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { createPolicyStore } = await store()
  return { dir, runtime: createPolicyStore(dir), createPolicyStore }
}

test('mode survives store reconstruction and session IDs cannot traverse storage', async (t) => {
  const { dir, runtime, createPolicyStore } = await fixture(t)
  const initial = await runtime.ensure('main', 'normal')
  const saved = await runtime.set('main', 'delegate-writes', initial.revision)
  assert.equal(saved.revision, initial.revision + 1)
  assert.deepEqual(await createPolicyStore(dir).read('main'), saved)
  assert.throws(() => runtime.pathFor('../outside'))
  await assert.rejects(() => runtime.ensure('../outside', 'normal'))
})

test('concurrent stale saves conflict instead of overwriting a mode change', async (t) => {
  const { dir, runtime, createPolicyStore } = await fixture(t)
  const initial = await runtime.ensure('s', 'normal')
  const results = await Promise.allSettled([
    runtime.set('s', 'delegate-writes', initial.revision),
    createPolicyStore(dir).set('s', 'delegate-writes', initial.revision),
  ])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'conflict')
})

test('corrupt storage does not silently reset a restricted session', async (t) => {
  const { runtime } = await fixture(t)
  await runtime.ensure('s', 'delegate-writes')
  await writeFile(runtime.pathFor('s'), '{broken')
  await assert.rejects(() => runtime.ensure('s', 'normal'))
  assert.equal(await readFile(runtime.pathFor('s'), 'utf8'), '{broken')
})

test('write failure leaves the old persisted mode intact', async (t) => {
  const { dir, runtime, createPolicyStore } = await fixture(t)
  const initial = await runtime.ensure('s', 'delegate-writes')
  const broken = createPolicyStore(dir, { write: async () => { throw new Error('disk full') } })
  await assert.rejects(() => broken.set('s', 'normal', initial.revision), /disk full/)
  assert.equal((await runtime.read('s')).mode, 'delegate-writes')
})
