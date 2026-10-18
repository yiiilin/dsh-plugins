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
import {
  BOX_HARNESS_MODULES,
  boxDependencies,
  mergeFragment,
  DEFAULT_BOX_BUNDLES,
  DEFAULT_PROFILE_BUNDLES,
  readProfilePatch,
  renderLocalPatch,
  renderSshPatch,
  writeProfile,
} from '../lib/profiles.js'
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

test('a box bundles the deployment preset, not only the bare harness', () => {
  // A box with only dsh-base + dsh-web-app has no preset roster, which is the
  // difference between "the same environment elsewhere" and a bare harness.
  assert.ok(DEFAULT_BOX_BUNDLES.includes('@deepseek-ai/dsh-base'))
  assert.ok(DEFAULT_BOX_BUNDLES.includes('@deepseek-ai/dsh-web-app'))
  assert.ok(DEFAULT_BOX_BUNDLES.includes('@local/yiln-agent-preset'))
})

test('boxDependencies links the preset and pins the harness modules', () => {
  const deps = boxDependencies(DEFAULT_BOX_BUNDLES, {
    agentPresetsDir: '/root/.dsh/.agent-presets',
    harnessVersion: '0.2.1-rc.2',
  })
  // A link keeps the box on the deployment's live preset rather than a copy.
  assert.equal(deps['@local/yiln-agent-preset'], 'link:/root/.dsh/.agent-presets/yiln/bundle')
  for (const module of BOX_HARNESS_MODULES) {
    assert.equal(deps[`@deepseek-ai/${module}`], '0.2.1-rc.2')
  }
})

test('boxDependencies omits what the manifest cannot resolve', () => {
  // Without an agent-presets directory the link would be dangling.
  const noPresets = boxDependencies(DEFAULT_BOX_BUNDLES, { harnessVersion: '0.2.1-rc.2' })
  assert.equal(noPresets['@local/yiln-agent-preset'], undefined)
  // Without a version the pins are skipped rather than guessed.
  const noVersion = boxDependencies(DEFAULT_BOX_BUNDLES, { agentPresetsDir: '/a/.agent-presets' })
  assert.equal(noVersion['@deepseek-ai/dsh-tool-schedule'], undefined)
})

test('the preset link is skipped when the bundle list omits the preset', () => {
  const deps = boxDependencies(DEFAULT_PROFILE_BUNDLES, {
    agentPresetsDir: '/a/.agent-presets',
    harnessVersion: '0.2.1-rc.2',
  })
  assert.equal(deps['@local/yiln-agent-preset'], undefined)
})

test('writeProfile records dependencies and a self-contained workspace file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-deps-'))
  try {
    const box = normalizeBox({ id: 'dep', port: 3196, workspace: '/srv' })
    const deps = { '@local/yiln-agent-preset': 'link:/a/.agent-presets/yiln/bundle' }
    await writeProfile(dir, box, DEFAULT_BOX_BUNDLES, deps)
    const fs = await import('node:fs/promises')
    const manifest = JSON.parse(await fs.readFile(join(dir, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dependencies, deps)
    assert.deepEqual(manifest.dsh.profile.bundles, DEFAULT_BOX_BUNDLES)
    // pnpm would otherwise treat the profile as part of a parent workspace.
    assert.match(await fs.readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8'), /packages:/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeProfile appends the operator fragment verbatim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-extra-'))
  try {
    const box = normalizeBox({ id: 'ex', port: 3197, workspace: '/srv' })
    const fragment = `- id: agent-default-model\n  config:\n    provider: example\n`
    await writeProfile(dir, box, DEFAULT_BOX_BUNDLES, {}, fragment)
    const fs = await import('node:fs/promises')
    const patch = await fs.readFile(join(dir, 'cordis.patch.yml'), 'utf8')
    // The box's own rows stay first; the deployment fragment is appended, so a
    // box never has to know which provider its host uses.
    assert.ok(patch.indexOf('operator patch fragment') < patch.indexOf('agent-default-model'))
    assert.ok(patch.includes('provider: example'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeProfile omits the fragment marker when there is no fragment', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-nofrag-'))
  try {
    const box = normalizeBox({ id: 'nf', port: 3198, workspace: '/srv' })
    await writeProfile(dir, box, DEFAULT_BOX_BUNDLES, {}, '   ')
    const fs = await import('node:fs/promises')
    const patch = await fs.readFile(join(dir, 'cordis.patch.yml'), 'utf8')
    assert.ok(!patch.includes('operator patch fragment'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('mergeFragment keeps the patch a single YAML sequence', async () => {
  // A patch file is one top-level sequence: appending `- id:` after an empty
  // `[]` document is a parse error, and a broken patch kills the box on boot.
  const yaml = (await import('js-yaml')).default
  const fragment = '- id: llm-pi-ai\n  name: "@deepseek-ai/dsh-llm-pi-ai"'
  const merged = mergeFragment(renderLocalPatch(), fragment)
  const rows = yaml.load(merged, { schema: yaml.DEFAULT_SCHEMA })
  assert.deepEqual(rows.map((row) => row.id), ['llm-pi-ai'])
})

test('mergeFragment preserves a populated patch and appends the fragment', async () => {
  const yaml = (await import('js-yaml')).default
  const base = renderLocalPatch().replace('[]', '- id: approval\n  config:\n    policy: never')
  const merged = mergeFragment(base, '- id: agent-default-model\n  name: x')
  const rows = yaml.load(merged, { schema: yaml.DEFAULT_SCHEMA })
  assert.deepEqual(rows.map((row) => row.id), ['approval', 'agent-default-model'])
})

test('mergeFragment leaves an empty fragment out entirely', () => {
  const merged = mergeFragment(renderLocalPatch(), '   ')
  assert.ok(!merged.includes('operator patch fragment'))
  assert.ok(merged.trimEnd().endsWith('[]') || merged.includes('- id:'))
})

test('the portal links a running box with its launch token', () => {
  const html = renderPortal({
    boxes: [{ id: 'box1', kind: 'local', workspace: '/w' }],
    running: new Set(['box1']),
    urls: new Map([['box1', 'http://127.0.0.1:3101/?token=abc123']]),
    gatewayPort: 8090,
    acceptLanguage: 'en',
  })
  // `/box1/` alone lands on the box's auth challenge; the token opens it.
  assert.ok(html.includes('href="/box1/?token=abc123"'))
})

test('the portal falls back to a bare prefix without a launch URL', () => {
  const html = renderPortal({
    boxes: [{ id: 'box1', kind: 'local', workspace: '/w' }],
    running: new Set(['box1']),
    urls: new Map(),
    gatewayPort: 8090,
    acceptLanguage: 'en',
  })
  assert.ok(html.includes('href="/box1/"'))
})

test('a stopped box offers no link', () => {
  const html = renderPortal({
    boxes: [{ id: 'box1', kind: 'local', workspace: '/w' }],
    running: new Set(),
    urls: new Map(),
    gatewayPort: 8090,
    acceptLanguage: 'en',
  })
  assert.ok(!html.includes('href="/box1/"'))
})
