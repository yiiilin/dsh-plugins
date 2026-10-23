/**
 * Unit tests for the per-instance temp directory identity and the startup sweep.
 *
 * Both exist for one reason: a crash leaves a Chromium profile and an Xauthority
 * cookie behind in `/tmp`, and the *next* process must neither reuse that
 * directory (old `SingletonLock`, stale cookie) nor delete one a live dsh is
 * still using. Every filesystem call and the liveness probe are injected, so
 * nothing here touches the real `/tmp` or signals a real pid.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { tmpdir } from 'node:os'

import {
  INSTANCE_DIR_PREFIX,
  cleanStaleInstanceDirs,
  instanceDirName,
  newInstanceKeyer,
  parseInstanceDirName,
} from '../instance-dirs.js'

/** A fake scan/remove pair over an in-memory set of directory names. */
function fakeTree(names) {
  const present = new Set(names)
  const tree = {
    present,
    removed: [],
    /** readdir over dirents, so a plain file can be told apart from a directory. */
    scan: async () => [...present].map((name) => ({ name, isDirectory: () => !name.endsWith('.txt') })),
    remove: async (path) => {
      const name = path.split('/').pop()
      present.delete(name)
      tree.removed.push(name)
    },
  }
  return tree
}

test('an instance key names a directory no other process boot can produce', () => {
  // The whole point: sequence numbers alone restart at 1 in every process, so a
  // crashed `dsh-desktop-vnc-1` was reused by the next first instance, taking its
  // stale SingletonLock and Xauthority with it.
  const firstBoot = newInstanceKeyer({ pid: 4242, bootId: 1_700_000_000_000 })
  const secondBoot = newInstanceKeyer({ pid: 4242, bootId: 1_700_000_000_001 })

  const firstKeys = [firstBoot(), firstBoot()]
  const secondKeys = [secondBoot(), secondBoot()]

  assert.notEqual(firstKeys[0], firstKeys[1], 'two instances never share a directory')
  assert.notEqual(secondKeys[0], secondKeys[1])
  for (const key of firstKeys) {
    assert.ok(!secondKeys.includes(key), `key ${key} must not be reused by a later boot`)
  }
  // The boot stamp is what a restarted process cannot reproduce; the sequence is
  // the part that restarts with it.
  assert.match(firstKeys[0], /^4242-1700000000000-\d+$/u)
  assert.match(secondKeys[0], /^4242-1700000000001-\d+$/u)
  // No separator ambiguity: the three parts survive a round trip.
  assert.deepEqual(parseInstanceDirName(`${INSTANCE_DIR_PREFIX}${firstKeys[0]}`), {
    pid: 4242,
    bootId: 1_700_000_000_000,
    sequence: Number(firstKeys[0].split('-')[2]),
  })
})

test('two registry mounts inside one process still mint different directories', () => {
  // The browser stack builds its directory from this key, and two instances in one
  // directory share a Chromium SingletonLock. A per-keyer counter would restart at
  // 1 for a second mount of the plugin in the same process; the sequence therefore
  // belongs to the process, while the boot stamp identifies the process.
  const mountA = newInstanceKeyer({ pid: 77, bootId: 5_000 })
  const mountB = newInstanceKeyer({ pid: 77, bootId: 5_000 })

  const keys = [mountA(), mountB(), mountA(), mountB()]

  assert.equal(new Set(keys).size, keys.length, `two mounts collided: ${keys.join(', ')}`)
})

test('the directory name is the plugin prefix plus the instance key', () => {
  assert.equal(instanceDirName({ pid: 7, bootId: 9, sequence: 3 }), 'dsh-desktop-vnc-7-9-3')
  assert.ok(instanceDirName({ pid: 7, bootId: 9, sequence: 3 }).startsWith(INSTANCE_DIR_PREFIX))
})

test('only a name this plugin minted is recognised', () => {
  // Anything else in /tmp is somebody else's: a legacy single-number directory
  // from an older version cannot prove a dead owner, so it is left alone.
  const rejected = [
    'dsh-desktop-vnc-1',
    'dsh-desktop-vnc-',
    'dsh-desktop-vnc',
    'dsh-desktop-vnc-1-2',
    'dsh-desktop-vnc-1-2-3-4',
    'dsh-desktop-vnc-a-b-c',
    'other-dsh-desktop-vnc-1-2-3',
    'dsh-desktop-vnc-1-2-3-suffix',
    '',
  ]
  for (const name of rejected) {
    assert.equal(parseInstanceDirName(name), null, `${JSON.stringify(name)} must not be recognised`)
  }
})

test('the sweep removes only directories whose owning process is gone', async () => {
  const tree = fakeTree([
    'dsh-desktop-vnc-1000-111-1', // owner 1000 is dead → stale
    'dsh-desktop-vnc-2000-222-1', // owner 2000 is alive → in use, keep
    'dsh-desktop-vnc-3000-333-1', // our own pid → keep
    'dsh-desktop-vnc-1', // legacy name, unprovable owner → keep
    'somebody-elses-scratch', // not ours → keep
    'dsh-desktop-vnc-4000-444-1.txt', // not a directory → keep
  ])
  const logged = []

  const removed = await cleanStaleInstanceDirs({
    tmpDir: '/tmp',
    ownPid: 3000,
    isAlive: (pid) => pid === 2000,
    scan: tree.scan,
    remove: tree.remove,
    log: (level, message) => logged.push([level, message]),
  })

  assert.deepEqual(removed, ['dsh-desktop-vnc-1000-111-1'])
  assert.deepEqual([...tree.present].sort(), [
    'dsh-desktop-vnc-1',
    'dsh-desktop-vnc-2000-222-1',
    'dsh-desktop-vnc-3000-333-1',
    'dsh-desktop-vnc-4000-444-1.txt',
    'somebody-elses-scratch',
  ])
  assert.equal(logged.length, 1, 'the sweep reports what it removed')
  assert.match(logged[0][1], /dsh-desktop-vnc-1000-111-1/u)
})

test('a failed removal is reported and never stops the sweep or the plugin', async () => {
  const removed = []
  const logged = []

  const result = await cleanStaleInstanceDirs({
    tmpDir: '/tmp',
    ownPid: 1,
    isAlive: () => false,
    scan: async () => [
      { name: 'dsh-desktop-vnc-2-20-1', isDirectory: () => true },
      { name: 'dsh-desktop-vnc-3-30-1', isDirectory: () => true },
    ],
    remove: async (path) => {
      const name = path.split('/').pop()
      if (name === 'dsh-desktop-vnc-2-20-1') throw new Error('EBUSY')
      removed.push(name)
    },
    log: (level, message) => logged.push([level, message]),
  })

  assert.deepEqual(removed, ['dsh-desktop-vnc-3-30-1'], 'one failure must not abort the rest')
  assert.deepEqual(result, ['dsh-desktop-vnc-3-30-1'])
  assert.equal(logged[0][0], 'warn')
  assert.match(logged[0][1], /EBUSY/u)
})

test('an unreadable tmpdir is silent, not fatal', async () => {
  // Cleanup is best-effort by spec: a machine where /tmp cannot be listed must
  // still mount the plugin.
  const removed = await cleanStaleInstanceDirs({
    tmpDir: '/tmp',
    ownPid: 1,
    scan: async () => {
      throw new Error('EACCES')
    },
    log: () => {},
  })
  assert.deepEqual(removed, [])
})

test('an omitted tmpDir defaults to this machine\'s temp directory', async () => {
  // The plugin passes tmpDir explicitly, but the function's own default must not
  // be a broken `readdir(undefined)`: that silently turns the sweep into a no-op.
  const scanned = []
  const removed = await cleanStaleInstanceDirs({
    ownPid: 1,
    isAlive: () => false,
    scan: async (path) => {
      scanned.push(path)
      return [{ name: 'dsh-desktop-vnc-2-20-1', isDirectory: () => true }]
    },
    remove: async () => {},
    log: () => {},
  })

  assert.deepEqual(scanned, [tmpdir()])
  assert.deepEqual(removed, ['dsh-desktop-vnc-2-20-1'])
})

test('a liveness probe that throws is treated as "in use", never as "dead"', async () => {
  // Deleting another process's live profile breaks its browser; leaking a stale
  // directory costs nothing. The failure therefore falls to the safe side.
  const tree = fakeTree(['dsh-desktop-vnc-1000-111-1'])

  const removed = await cleanStaleInstanceDirs({
    tmpDir: '/tmp',
    ownPid: 1,
    isAlive: () => {
      throw new Error('EPERM')
    },
    scan: tree.scan,
    remove: tree.remove,
    log: () => {},
  })

  assert.deepEqual(removed, [])
  assert.equal(tree.present.size, 1)
})
