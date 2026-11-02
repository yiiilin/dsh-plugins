import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ID_PATTERN,
  PROFILE_PATTERN,
  RESERVED_IDS,
  normalizeEnvironment,
  parseRegistry,
} from '../lib/registry.js'

/** A remote record as written before local profiles existed: no `kind`. */
const LEGACY_REMOTE = {
  id: 'n95c61f9e1d551ce1',
  label: '6.13',
  token: '4m3MmboN1qJknqwru_C1NGpCdXdIRLEMlWRLsLIwdkg',
  enabled: true,
}

/** A local record: a profile this node runs itself. */
const LOCAL = { id: 'review', kind: 'local', profile: 'review', port: 57001 }

test('a record without kind reads as a remote edge', () => {
  const environment = normalizeEnvironment(LEGACY_REMOTE)
  assert.equal(environment.kind, 'remote')
  assert.equal(environment.token, LEGACY_REMOTE.token)
  assert.equal(environment.profile, undefined)
  assert.equal(environment.port, undefined)
})

test('an explicit remote record keeps its token', () => {
  const environment = normalizeEnvironment({ ...LEGACY_REMOTE, kind: 'remote' })
  assert.equal(environment.kind, 'remote')
  assert.equal(environment.token, LEGACY_REMOTE.token)
})

test('a local record carries a profile and a port, and no token', () => {
  const environment = normalizeEnvironment(LOCAL)
  assert.deepEqual(environment, {
    id: 'review',
    kind: 'local',
    label: 'review',
    enabled: true,
    profile: 'review',
    port: 57001,
  })
  assert.equal(environment.token, undefined, 'a local hop crosses no tunnel to authenticate')
})

test('a local record without a profile or port is refused', () => {
  assert.throws(() => normalizeEnvironment({ id: 'x', kind: 'local', port: 57001 }), /needs a profile/)
  assert.throws(() => normalizeEnvironment({ id: 'x', kind: 'local', profile: 'p' }), /needs a port/)
})

test('a local port outside 1-65535 is refused', () => {
  for (const port of [0, -1, 65_536, 1.5, '57001']) {
    assert.throws(
      () => normalizeEnvironment({ id: 'x', kind: 'local', profile: 'p', port }),
      /needs a port/,
      `port ${String(port)} must be refused`,
    )
  }
})

test('a local record must not carry a token', () => {
  assert.throws(
    () => normalizeEnvironment({ ...LOCAL, token: 'a'.repeat(40) }),
    /must not carry a token/,
  )
})

test('a remote record must not carry a profile or port', () => {
  assert.throws(() => normalizeEnvironment({ ...LEGACY_REMOTE, profile: 'p' }), /must not carry a profile or port/)
  assert.throws(() => normalizeEnvironment({ ...LEGACY_REMOTE, port: 57001 }), /must not carry a profile or port/)
})

test('an unknown kind is refused by name', () => {
  assert.throws(() => normalizeEnvironment({ id: 'x', kind: 'weird' }), /kind must be one of local, remote/)
})

test('two local environments may not share a port', () => {
  assert.throws(
    () =>
      parseRegistry({
        environments: [
          { id: 'a', kind: 'local', profile: 'p', port: 57001 },
          { id: 'b', kind: 'local', profile: 'q', port: 57001 },
        ],
      }),
    /share port 57001/,
  )
})

test('two local environments may not run the same profile', () => {
  assert.throws(
    () =>
      parseRegistry({
        environments: [
          { id: 'a', kind: 'local', profile: 'p', port: 57001 },
          { id: 'b', kind: 'local', profile: 'p', port: 57002 },
        ],
      }),
    /both run profile "p"/,
  )
})

test('remote tokens stay unique and local records do not join that check', () => {
  // A local record has no token, so it cannot collide with a remote one.
  const environments = parseRegistry({ environments: [LEGACY_REMOTE, LOCAL] })
  assert.equal(environments.length, 2)

  assert.throws(
    () => parseRegistry({ environments: [LEGACY_REMOTE, { ...LEGACY_REMOTE, id: 'other' }] }),
    /share a token/,
  )
})

test('a local environment id still obeys the URL-safe pattern and reserved set', () => {
  assert.throws(() => normalizeEnvironment({ ...LOCAL, id: 'bad/id' }), /must match/)
  assert.throws(() => normalizeEnvironment({ ...LOCAL, id: 'main' }), /is reserved/)
})

test('a profile name that would escape its directory is refused', () => {
  for (const profile of ['../escape', 'a/b', '', '.hidden', 'a b']) {
    assert.throws(
      () => normalizeEnvironment({ ...LOCAL, profile }),
      /needs a profile/,
      `profile ${JSON.stringify(profile)} must be refused`,
    )
  }
})

test('the patterns themselves admit the ordinary cases', () => {
  assert.ok(PROFILE_PATTERN.test('review'))
  assert.ok(PROFILE_PATTERN.test('work-2'))
  assert.ok(PROFILE_PATTERN.test('a.b_c'))
  assert.ok(ID_PATTERN.test('review'))
  assert.ok(!RESERVED_IDS.has('review'))
})
