import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import yaml from 'js-yaml'
import { scopeCookiePath, scopeLocation, routeProfile } from '../lib/entry.js'
import { escapeHtml, renderPortal, selectCopy } from '../lib/portal.js'
import {
  compose,
  HARNESS_MODULES,
  profileDependencies,
  renderLocalPatch,
  renderSshPatch,
  writeProfile,
} from '../lib/provision.js'
import {
  allocatePort,
  deriveId,
  normalizeProfile,
  parseRegistry,
  RESERVED_IDS,
  serializeRegistry,
} from '../lib/registry.js'
import { digestOf, patchBundle } from '../lib/helper.js'

const sshProfile = () =>
  normalizeProfile({
    id: 'box1',
    kind: 'ssh',
    port: 56790,
    workspace: '/root/boxws',
    sshHost: 'dsh-box1',
    sshUser: 'root',
    sshPort: 22,
    sshHelper: '/opt/dsh-helper/dsh-ssh-helper',
    sshHelperHash: 'a'.repeat(64),
  })

// --- routing -----------------------------------------------------------------

test('routeProfile matches a whole first segment only', () => {
  assert.equal(routeProfile('/box1/api/x', ['box1']).id, 'box1')
  assert.equal(routeProfile('/box1', ['box1']).path, '/')
  assert.equal(routeProfile('/box1/', ['box1']).path, '/')
  // A longer id must not be claimed by its own prefix.
  assert.equal(routeProfile('/box10/api', ['box1']), undefined)
  assert.equal(routeProfile('/', ['box1']), undefined)
})

test('routeProfile keeps the query string on the upstream path', () => {
  assert.equal(routeProfile('/box1/?token=t', ['box1']).path, '/?token=t')
  assert.equal(routeProfile('/box1/a?x=1', ['box1']).path, '/a?x=1')
})

test('scopeCookiePath narrows only an exact root path', () => {
  assert.equal(scopeCookiePath('a=b; Path=/; HttpOnly', '/box1'), 'a=b; Path=/box1/; HttpOnly')
  // An already-scoped cookie keeps its narrower scope.
  assert.equal(scopeCookiePath('a=b; Path=/box1/x; HttpOnly', '/box1'), 'a=b; Path=/box1/x; HttpOnly')
})

test('scopeLocation keeps a redirect inside its prefix', () => {
  assert.equal(scopeLocation('/api/x', '/box1'), '/box1/api/x')
  assert.equal(scopeLocation('./', '/box1'), './')
  assert.equal(scopeLocation('/box1/api/x', '/box1'), '/box1/api/x')
  assert.equal(scopeLocation('https://other/x', '/box1'), 'https://other/x')
  assert.equal(scopeLocation(undefined, '/box1'), undefined)
})

// --- registry ----------------------------------------------------------------

test('a local profile needs only its own fields', () => {
  const profile = normalizeProfile({ id: 'a', port: 56789, workspace: '/w' })
  assert.equal(profile.kind, 'local')
  assert.equal(profile.profile, 'daemon-a')
  assert.equal(profile.enabled, true)
  assert.equal(profile.sshHost, undefined)
})

test('an ssh profile carries its connection coordinates', () => {
  const profile = sshProfile()
  assert.equal(profile.sshHost, 'dsh-box1')
  assert.equal(profile.sshPort, 22)
  assert.equal(profile.sshNode, undefined, 'a static helper needs no remote node')
})

test('unknown fields are rejected rather than silently dropped', () => {
  assert.throws(() => normalizeProfile({ id: 'a', port: 1, workspace: '/w', nope: 1 }), /unknown field/)
})

test('a reserved or malformed id is refused', () => {
  assert.throws(() => normalizeProfile({ id: 'admin', port: 1, workspace: '/w' }), /reserved/)
  assert.throws(() => normalizeProfile({ id: 'A', port: 1, workspace: '/w' }), /must match/)
  assert.throws(() => normalizeProfile({ id: 'a', port: 1, workspace: 'rel' }), /absolute path/)
})

test('deriveId makes any name usable instead of failing', () => {
  const taken = new Set(['Admin', 'box'])
  assert.equal(deriveId('', taken), 'profile')
  assert.equal(deriveId('BOB', taken), 'bob')
  assert.equal(deriveId('admin', taken), 'admin-2', 'a reserved id is suffixed')
  assert.equal(deriveId('box', taken), 'box-2', 'a taken id is suffixed')
  assert.equal(deriveId('9lives', taken), 'p-9lives', 'a leading digit is prefixed')
})

test('allocatePort skips used ports and reports exhaustion', () => {
  assert.equal(allocatePort(56789, new Set()), 56789)
  assert.equal(allocatePort(56789, new Set([56789])), 56790)
  assert.throws(() => allocatePort(65000, new Set(Array.from({ length: 600 }, (_, i) => 65000 + i))), /no free port/)
})

test('the registry round-trips and rejects duplicates', () => {
  const profiles = [normalizeProfile({ id: 'a', port: 1, workspace: '/w' })]
  assert.deepEqual(parseRegistry(serializeRegistry(profiles)), profiles)
  assert.throws(() => parseRegistry({ profiles: [{ id: 'a', port: 1, workspace: '/w' }, { id: 'a', port: 2, workspace: '/w' }] }), /duplicate/)
  assert.deepEqual(parseRegistry(undefined), [])
})

// --- provision ---------------------------------------------------------------

test('a generated patch is one YAML sequence even with a fragment', () => {
  const text = renderLocalPatch({ workspace: '/w', fragment: '- id: agent-default-model\n  config:\n    provider: x' })
  const rows = yaml.load(text, { schema: yaml.DEFAULT_SCHEMA })
  assert.equal(rows.length, 2)
  assert.deepEqual(Object.keys(rows[1]), ['id', 'config'])
})

test('an ssh patch swaps every provider and pairs permission with approval', () => {
  const rows = yaml.load(renderSshPatch(sshProfile()), { schema: yaml.DEFAULT_SCHEMA })
  const inserted = rows.flatMap((row) => (Array.isArray(row.insert) ? row.insert : []))
  const ids = [...inserted, ...rows].map((row) => row.id).filter(Boolean)
  for (const id of ['ssh', 'fs-ssh', 'subprocess-ssh', 'sandbox-ssh', 'working-directory']) {
    assert.ok(ids.includes(id), `expected ${id}`)
  }
  // `danger-full-access` without `approval: never` matches no permission preset,
  // which refuses activation.
  const policy = rows.find((row) => row.id === 'sandbox-policy')
  assert.equal(policy.config.mode, 'danger-full-access')
  const approval = rows.find((row) => row.id === 'approval')
  assert.equal(approval.config.policy, 'never')
  // The local providers must be switched off, not merely shadowed.
  for (const id of ['fs-sandbox', 'subprocess', 'sandbox']) {
    assert.equal(rows.find((row) => row.id === id)?.disabled, true, `${id} must be disabled`)
  }
})

test('a static helper selects executable launch, a node path selects script', () => {
  const staticRows = yaml.load(renderSshPatch(sshProfile()), { schema: yaml.DEFAULT_SCHEMA })
  const staticSsh = staticRows.flatMap((row) => [row, ...(Array.isArray(row.insert) ? row.insert : [])]).find((row) => row.id === 'ssh')
  assert.deepEqual(staticSsh.config.launch, { kind: 'executable' })

  const scriptRows = yaml.load(
    renderSshPatch({ ...sshProfile(), sshNode: '/usr/bin/node' }),
    { schema: yaml.DEFAULT_SCHEMA },
  )
  const scriptSsh = scriptRows.flatMap((row) => [row, ...(Array.isArray(row.insert) ? row.insert : [])]).find((row) => row.id === 'ssh')
  assert.deepEqual(scriptSsh.config.launch, { kind: 'node-script', node: '/usr/bin/node' })
})

test('profileDependencies links the preset and pins every harness module', () => {
  const deps = profileDependencies(['@local/yiln-agent-preset'], {
    agentPresetsDir: '/root/.dsh/.agent-presets',
    harnessVersion: '0.2.1-rc.2',
  })
  assert.equal(deps['@local/yiln-agent-preset'], 'link:/root/.dsh/.agent-presets/yiln/bundle')
  for (const module of HARNESS_MODULES) assert.equal(deps[`@deepseek-ai/${module}`], '0.2.1-rc.2')
})

test('compose leaves an empty fragment out entirely', () => {
  assert.ok(!compose([{ id: 'a' }], '   ').includes('undefined'))
  assert.equal(yaml.load(compose([{ id: 'a' }]), { schema: yaml.DEFAULT_SCHEMA }).length, 1)
})

test('writeProfile seeds the patch once and never overwrites persisted settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'daemon-provision-'))
  try {
    const profile = normalizeProfile({ id: 'seed', port: 56789, workspace: '/w' })
    await writeProfile(dir, profile, { bundles: ['@deepseek-ai/dsh-base'] })
    const patchPath = join(dir, 'cordis.patch.yml')
    const seeded = await readFile(patchPath, 'utf8')
    assert.match(seeded, /defaultDirectory: \/w/u)

    // The harness persists runtime settings into this same file; a second seed
    // would discard them, so an existing patch must be left alone.
    await writeFile(patchPath, `${seeded}\n- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: 1\n`)
    await writeProfile(dir, profile, { bundles: ['@deepseek-ai/dsh-base'] })
    assert.match(await readFile(patchPath, 'utf8'), /ui-settings-general/u)

    // The manifest is daemon output, so it is always rewritten.
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    assert.deepEqual(manifest.dsh.profile.bundles, ['@deepseek-ai/dsh-base'])
    // pnpm would otherwise treat the profile as part of a parent workspace.
    assert.match(await readFile(join(dir, 'pnpm-workspace.yaml'), 'utf8'), /packages:/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// --- helper build ------------------------------------------------------------

test('patchBundle applies the three edits a static helper needs', () => {
  const source = [
    'var { version: version2 } = createRequire2(import.meta.url)("../package.json");',
    'var import_node_sea = require("node:sea");',
    'const a = import.meta.resolve("tsx/esm");',
    'const b = import_node_url5.fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-sandbox-windows-acl/runner"));',
  ].join('\n')
  const patched = patchBundle(source, '0.2.1-rc.2')
  assert.ok(!patched.includes('import.meta'), 'a CJS bundle has no import.meta')
  assert.ok(!patched.includes('../package.json'), 'the bundle has no package.json beside it')
  assert.match(patched, /var version2 = "0\.2\.1-rc\.2";/u)
  // isSea() must report true so the helper launches as an executable.
  assert.match(patched, /isSea: \(\) => true/u)
})

test('patchBundle refuses a bundle whose shape it no longer recognises', () => {
  assert.throws(() => patchBundle('var x = 1;', '0.0.0'), /no longer reads/)
  assert.throws(
    () => patchBundle('var { version: v } = require("../package.json");', '0.0.0'),
    /no longer reads/,
  )
})

test('digestOf is a stable sha256', () => {
  assert.equal(digestOf(Buffer.from('')), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

// --- portal ------------------------------------------------------------------

test('the portal links a running profile with its launch token', () => {
  const html = renderPortal({
    profiles: [{ id: 'box1', label: 'box1', kind: 'local', workspace: '/w' }],
    running: new Set(['box1']),
    urls: new Map([['box1', 'http://127.0.0.1:56789/?token=abc']]),
    acceptLanguage: 'en',
  })
  // A bare prefix lands on the profile's own auth challenge; the token opens it.
  assert.ok(html.includes('href="/box1/?token=abc"'))
})

test('the portal falls back to a bare prefix without a launch URL', () => {
  const html = renderPortal({ profiles: [{ id: 'a', kind: 'local', workspace: '/w' }], running: new Set(['a']), urls: new Map(), acceptLanguage: 'en' })
  assert.ok(html.includes('href="/a/"'))
})

test('a stopped profile offers no link', () => {
  const html = renderPortal({ profiles: [{ id: 'a', kind: 'local', workspace: '/w' }], running: new Set(), urls: new Map(), acceptLanguage: 'en' })
  assert.ok(!html.includes('href="/a/"'))
})

test('portal copy follows Accept-Language and escapes untrusted text', () => {
  assert.equal(selectCopy('zh-CN,zh;q=0.9'), selectCopy('zh'))
  assert.ok(renderPortal({ profiles: [], running: new Set(), urls: new Map(), acceptLanguage: 'zh' }).includes('开发守护'))
  const html = renderPortal({
    profiles: [{ id: 'a', label: '<script>x</script>', kind: 'local', workspace: '/w' }],
    running: new Set(),
    urls: new Map(),
    acceptLanguage: 'en',
  })
  assert.ok(!html.includes('<script>x</script>'))
  assert.equal(escapeHtml(`<&"'>`), '&lt;&amp;&quot;&#39;&gt;')
})

// --- reserved ids ------------------------------------------------------------

test('every reserved id is refused as a profile id', () => {
  for (const id of RESERVED_IDS) {
    if (!/^[a-z][a-z0-9-]{0,30}$/u.test(id)) continue
    assert.throws(() => normalizeProfile({ id, port: 1, workspace: '/w' }), /reserved/u, id)
  }
})
