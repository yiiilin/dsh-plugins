import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createIndexStore, defaultIndexDir } from '../lib/store.js'

test('scopes the default index directory by profile and offset', () => {
  const home = '/tmp/dsh-wj-home'
  const first = defaultIndexDir({ home, dir: '/tmp/profile-one' }, 480)
  const second = defaultIndexDir({ home, dir: '/tmp/profile-two' }, 480)
  const shifted = defaultIndexDir({ home, dir: '/tmp/profile-one' }, 0)
  assert.ok(first.startsWith(`${home}/work-journal/`))
  assert.notEqual(first, second)
  // Two deployments in different timezones must not share day buckets.
  assert.notEqual(first, shifted)
})

test('falls back to the environment then to the home directory', () => {
  const keys = ['DSH_HOME', 'DSH_PROFILE_DIR', 'DSH_PROFILE']
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  try {
    process.env.DSH_HOME = '/tmp/dsh-wj-env-home'
    process.env.DSH_PROFILE_DIR = '/tmp/dsh-wj-env-profile'
    assert.ok(defaultIndexDir(undefined, 480).startsWith('/tmp/dsh-wj-env-home/work-journal/'))
    delete process.env.DSH_HOME
    delete process.env.DSH_PROFILE_DIR
    delete process.env.DSH_PROFILE
    assert.ok(defaultIndexDir(undefined, 480).includes('.dsh/work-journal/'))
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('refuses a relative index directory', () => {
  assert.throws(() => createIndexStore('relative/path'), /absolute/u)
  assert.throws(() => createIndexStore(undefined), /absolute/u)
})

test('loads an empty index on first run and round-trips a saved one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-store-'))
  try {
    const store = createIndexStore(directory)
    const fresh = await store.load(480)
    assert.equal(fresh.stats.indexed, 0)
    assert.equal(fresh.tzOffsetMinutes, 480)

    fresh.activities.s1 = { id: 's1', days: ['2026-09-13'] }
    fresh.revisions.s1 = 'r1'
    await store.save(fresh)
    const reloaded = await store.load(480)
    assert.deepEqual(Object.keys(reloaded.activities), ['s1'])
    assert.equal(reloaded.revisions.s1, 'r1')
    // The document is stored whole and human-readable, one line plus newline.
    const raw = await readFile(join(directory, 'index.json'), 'utf8')
    assert.ok(raw.endsWith('\n'))
    assert.equal(JSON.parse(raw).version, fresh.version)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('recovers from a truncated index instead of failing every later query', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-store-'))
  const warnings = []
  try {
    await writeFile(join(directory, 'index.json'), '{"version":2,"activities":{')
    const store = createIndexStore(directory, { onWarning: (message) => warnings.push(message) })
    const recovered = await store.load(480)
    assert.equal(recovered.stats.indexed, 0)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /unreadable index/u)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('replaces the index atomically so a reader never sees a partial document', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wj-store-'))
  const writes = []
  try {
    const store = createIndexStore(directory, {
      write: async (path, content, options) => {
        writes.push({ path, content, options })
      },
    })
    await store.save({ version: 2, activities: {} })
    assert.equal(writes.length, 1)
    assert.equal(writes[0].path, join(directory, 'index.json'))
    // Owner-only: the index quotes the user's own prompts.
    assert.equal(writes[0].options.mode, 0o600)
    assert.equal(writes[0].options.dirMode, 0o700)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
