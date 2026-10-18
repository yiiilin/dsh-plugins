import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  allocatePort,
  normalizeBox,
  parseRegistry,
  serializeRegistry,
} from '../lib/boxes.js'
import {
  routeRequest,
  scopeCookiePath,
  scopeLocation,
} from '../lib/gateway.js'
import { COPY, renderPortal, selectCopy } from '../lib/portal.js'
import { DEFAULT_PROFILE_BUNDLES, readProfilePatch, renderLocalPatch, renderSshPatch, writeProfile } from '../lib/profiles.js'
import { trustedArgs } from '../lib/supervisor.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HASH = 'a'.repeat(64)

const sshBox = () => ({
  id: 'box1',
  kind: 'ssh',
  port: 3101,
  workspace: '/srv/app',
  sshHost: 'box1-alias',
  sshNode: '/usr/bin/node',
  sshHelper: '/opt/h/helper.js',
  sshHelperHash: HASH,
})

test('normalizeBox fills defaults for a local box', () => {
  const box = normalizeBox({ id: 'box0', port: 3100, workspace: '/srv/app' })
  assert.equal(box.kind, 'local')
  assert.equal(box.profile, 'fleet-box0')
  assert.equal(box.label, 'box0')
  assert.equal(box.enabled, true)
  assert.equal(box.sshHost, undefined)
})

test('normalizeBox rejects an unknown field rather than dropping it', () => {
  assert.throws(
    () => normalizeBox({ id: 'box0', port: 3100, workspace: '/srv', sshhost: 'typo' }),
    /unknown field "sshhost"/u,
  )
})

test('normalizeBox rejects a non-absolute workspace', () => {
  assert.throws(
    () => normalizeBox({ id: 'box0', port: 3100, workspace: 'relative/path' }),
    /must be an absolute path/u,
  )
})

test('normalizeBox requires the SSH fields for an ssh box', () => {
  assert.throws(
    () => normalizeBox({ id: 'box1', kind: 'ssh', port: 3101, workspace: '/srv' }),
    /sshHost/u,
  )
})

test('normalizeBox rejects an id that cannot address a URL prefix', () => {
  assert.throws(() => normalizeBox({ id: 'Box_1', port: 3100, workspace: '/srv' }), /must match/u)
})

test('normalizeBox rejects a malformed helper digest', () => {
  assert.throws(
    () => normalizeBox({ ...sshBox(), sshHelperHash: 'not-a-hash' }),
    /lowercase SHA-256/u,
  )
})

test('parseRegistry rejects duplicate ids and duplicate ports', () => {
  const local = (id, port) => ({ id, port, workspace: '/srv' })
  assert.deepEqual(parseRegistry({ version: 1, boxes: [local('a', 3100), local('b', 3101)] }).length, 2)
  assert.throws(() => parseRegistry({ version: 1, boxes: [local('a', 3100), local('a', 3101)] }), /duplicate box id/u)
  assert.throws(() => parseRegistry({ version: 1, boxes: [local('a', 3100), local('b', 3100)] }), /duplicate box port/u)
})

test('parseRegistry rejects a wrong version or unknown top-level field', () => {
  assert.throws(() => parseRegistry({ version: 2, boxes: [] }), /version must be 1/u)
  assert.throws(() => parseRegistry({ version: 1, boxes: [], extra: true }), /unknown field "extra"/u)
})

test('serializeRegistry round-trips through parseRegistry', () => {
  const boxes = [normalizeBox({ id: 'box0', port: 3100, workspace: '/srv' })]
  assert.deepEqual(parseRegistry(serializeRegistry(boxes)), boxes)
})

test('allocatePort skips taken ports and rejects an exhausted range', () => {
  assert.equal(allocatePort([], 3101), 3101)
  assert.equal(allocatePort([3101, 3102], 3101), 3103)
  assert.throws(() => allocatePort([3101, 3102], 3101, 2), /no free port/u)
})

test('routeRequest matches only whole segments of a prefix', () => {
  const ids = ['box1', 'box2']
  assert.deepEqual(routeRequest('/box1/', ids), { id: 'box1', path: '/' })
  assert.deepEqual(routeRequest('/box1/api/x?y=1', ids), { id: 'box1', path: '/api/x?y=1' })
  assert.deepEqual(routeRequest('/box1', ids), { id: 'box1', path: '/' })
  // A longer sibling segment is not the box, and neither is an unrelated path.
  assert.equal(routeRequest('/box10/', ids), undefined)
  assert.equal(routeRequest('/portal', ids), undefined)
})

test('scopeCookiePath narrows only an exact root path', () => {
  assert.equal(
    scopeCookiePath('dsh-auth-x=v1.sig; Max-Age=60; Path=/; HttpOnly', '/box1'),
    'dsh-auth-x=v1.sig; Max-Age=60; Path=/box1/; HttpOnly',
  )
  // A cookie already scoped narrower keeps its own scope.
  assert.equal(
    scopeCookiePath('a=b; Path=/deep/', '/box1'),
    'a=b; Path=/deep/',
  )
})

test('scopeLocation keeps relative, already-scoped and foreign targets', () => {
  assert.equal(scopeLocation('./', '/box1'), './')
  assert.equal(scopeLocation('/api/x', '/box1'), '/box1/api/x')
  assert.equal(scopeLocation('/box1/api/x', '/box1'), '/box1/api/x')
  assert.equal(scopeLocation('https://other.example/x', '/box1'), 'https://other.example/x')
})

test('renderSshPatch disables local providers instead of renaming them', () => {
  const patch = renderSshPatch(sshBox())
  // Renaming an id-targeted row is refused by the Loader and silently skipped,
  // so each local provider must be disabled and its remote twin inserted.
  for (const row of ['fs-sandbox', 'subprocess', 'sandbox']) {
    assert.match(patch, new RegExp(`- id: ${row}\\n  disabled: true`, 'u'))
  }
  for (const row of ['fs-ssh', 'subprocess-ssh', 'sandbox-ssh']) {
    assert.match(patch, new RegExp(`- id: ${row}\\n      name:`, 'u'))
  }
  assert.match(patch, /host: "box1-alias"/u)
  assert.match(patch, /helperHash: "a{64}"/u)
  assert.match(patch, /workspaceRoot: "\/srv\/app"/u)
})

test('renderLocalPatch is an empty override list', () => {
  assert.match(renderLocalPatch(), /^# Generated by[^\n]*\n(#.*\n)*\[\]\n$/u)
})

test('writeProfile materializes files a dsh launch can read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-profile-'))
  try {
    const box = normalizeBox({ id: 'probe', port: 3199, workspace: '/srv/app' })
    await writeProfile(dir, box)
    const manifest = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(join(dir, 'package.json'), 'utf8')))
    assert.equal(manifest.name, 'dsh-profile-fleet-probe')
    assert.deepEqual(manifest.dsh.profile.bundles, DEFAULT_PROFILE_BUNDLES)
    assert.equal(manifest.dsh.profile.patchReload, 'startup')
    assert.equal(await import('node:fs/promises').then((m) => m.readFile(join(dir, 'cordis.yml'), 'utf8')), '[]\n')
    assert.match(await readProfilePatch(dir), /^# Generated/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readProfilePatch returns undefined for a missing profile', async () => {
  assert.equal(await readProfilePatch(join(tmpdir(), 'fleet-absent-profile-xyz')), undefined)
})

test('portal renders running and stopped boxes with escaped text', () => {
  const html = renderPortal({
    boxes: [
      { id: 'box0', label: 'box0', kind: 'local', workspace: '/srv/one', enabled: true },
      { id: 'box1', label: '<script>x</script>', kind: 'ssh', workspace: '/srv/two', enabled: true },
    ],
    running: new Set(['box0']),
    gatewayPort: 8090,
    acceptLanguage: 'zh-CN,zh;q=0.9',
  })
  assert.match(html, /lang="zh-CN"/u)
  assert.match(html, /href="\/box0\/"/u)
  // An escaped label must not inject an element.
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/u)
  assert.doesNotMatch(html, /<script>x<\/script>/u)
  // A stopped box offers no link.
  assert.doesNotMatch(html, /href="\/box1\/"/u)
})

test('portal reports an empty fleet without a table', () => {
  const html = renderPortal({ boxes: [], running: new Set(), gatewayPort: 8090 })
  assert.match(html, new RegExp(COPY.en.empty.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  assert.doesNotMatch(html, /<table>/u)
})

test('selectCopy defaults to English off a non-string header', () => {
  assert.equal(selectCopy(undefined), COPY.en)
  assert.equal(selectCopy('fr'), COPY.en)
  assert.equal(selectCopy('zh'), COPY.zh)
})

test('portal copy carries both languages for every key', () => {
  assert.deepEqual(Object.keys(COPY.en).sort(), Object.keys(COPY.zh).sort())
})

test('writeProfile accepts a replacement bundle list', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-bundles-'))
  try {
    const box = normalizeBox({ id: 'swapped', port: 3198, workspace: '/srv' })
    const bundles = ['@deepseek-ai/dsh-base', '@example/custom-web']
    await writeProfile(dir, box, bundles)
    const manifest = JSON.parse(
      await import('node:fs/promises').then((m) => m.readFile(join(dir, 'package.json'), 'utf8')),
    )
    // A deployment that swaps its web plugin changes config, not this module.
    assert.deepEqual(manifest.dsh.profile.bundles, bundles)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('trustedArgs is empty without an external authority', () => {
  // Boxes on a loopback authority must keep the stock fence.
  assert.deepEqual(trustedArgs({ id: 'b' }, ''), [])
  assert.deepEqual(trustedArgs({ id: 'b' }, undefined), [])
})

test('trustedArgs grants the external authority and advertises the prefix', () => {
  // Without --trusted-host a gateway-forwarded Host answers 403 on every /api.
  assert.deepEqual(trustedArgs({ id: 'box1' }, 'gw.example.com', '/box1'), [
    '--trusted-host',
    'gw.example.com',
    '--public-url',
    'http://gw.example.com/box1/',
  ])
})

test('fleet declares no required service so a swapped web plugin cannot block it', async () => {
  const module = await import('../index.js')
  assert.deepEqual(module.inject, [])
  assert.equal(typeof module.Config, 'function')
})

test('renderSshPatch pairs danger-full-access with approval never', () => {
  // A box left on the shipped `ask` default matches no permission preset, so the
  // permission plugin refuses to activate and the box still serves HTTP while
  // every agent turn is dead. Caught by booting a real SSH box.
  const patch = renderSshPatch(sshBox())
  assert.match(patch, /mode: danger-full-access/u)
  assert.match(patch, /- id: approval\n  config:\n    policy: never/u)
})
