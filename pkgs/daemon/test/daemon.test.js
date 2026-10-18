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
  SSH_PROVIDER_MODULES,
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
    port: 56800,
    workspace: '/root/boxws',
    sshHost: 'dsh-box1',
    sshUser: 'root',
    sshPort: 22,
    sshHelper: '/opt/dsh-helper/dsh-ssh-helper',
    sshHelperHash: 'a'.repeat(64),
    sshKeyPath: '/root/.dsh/daemon/keys/box1/id_ed25519',
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

test('every managed environment carries its SSH coordinates', () => {
  // There is no local variant: a managed environment is always reached over SSH, and
  // the main environment is not a registry entry at all.
  const profile = normalizeProfile({
    id: 'a', port: 56800, workspace: '/w',
    sshHost: 'h', sshUser: 'root', sshHelper: '/opt/h', sshHelperHash: 'b'.repeat(64),
  })
  assert.equal(profile.kind, undefined, 'no kind field anymore')
  assert.equal(profile.profile, 'daemon-a')
  assert.equal(profile.enabled, true)
  assert.throws(
    () => normalizeProfile({ id: 'b', port: 56800, workspace: '/w' }),
    /sshHost/u,
    'SSH fields are required',
  )
})

test('an ssh profile carries its connection coordinates', () => {
  const profile = sshProfile()
  assert.equal(profile.sshHost, 'dsh-box1')
  assert.equal(profile.sshPort, 22)
  assert.equal(profile.sshKeyPath, '/root/.dsh/daemon/keys/box1/id_ed25519')
  assert.equal(profile.sshNode, undefined, 'a static helper needs no remote node')
})

test('an omitted ssh port stays omitted so an ssh_config alias keeps its own', () => {
  // A default of 22 would become an explicit `-p 22` and override the alias's Port,
  // silently connecting to the wrong port.
  const profile = normalizeProfile({
    id: 'a', port: 1, workspace: '/w',
    sshHost: 'dsh-box1', sshUser: 'root', sshHelper: '/h', sshHelperHash: 'a'.repeat(64),
  })
  assert.equal(profile.sshPort, undefined)
})

test('unknown fields are rejected rather than silently dropped', () => {
  const ssh = { sshHost: 'h', sshUser: 'root', sshHelper: '/h', sshHelperHash: 'e'.repeat(64) }
  assert.throws(() => normalizeProfile({ id: 'a', port: 1, workspace: '/w', ...ssh, nope: 1 }), /unknown field/u)
})

test('a reserved or malformed id is refused', () => {
  const ssh = { sshHost: 'h', sshUser: 'root', sshHelper: '/h', sshHelperHash: 'e'.repeat(64) }
  assert.throws(() => normalizeProfile({ id: 'admin', port: 1, workspace: '/w', ...ssh }), /reserved/u)
  assert.throws(() => normalizeProfile({ id: 'A', port: 1, workspace: '/w', ...ssh }), /must match/u)
  assert.throws(() => normalizeProfile({ id: 'a', port: 1, workspace: 'rel', ...ssh }), /absolute path/u)
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

test('the registry round-trips and rejects duplicate ids', () => {
  const one = normalizeProfile({
    id: 'a', port: 1, workspace: '/w',
    sshHost: 'h1', sshUser: 'root', sshHelper: '/opt/h', sshHelperHash: 'c'.repeat(64),
  })
  assert.deepEqual(parseRegistry(serializeRegistry([one])), [one])
  assert.throws(() => parseRegistry({ profiles: [one, { ...one, port: 2 }] }), /duplicate/u)
  assert.deepEqual(parseRegistry(undefined), [])
})

test('one helper defines one environment', () => {
  // Two records sharing a helper would fight over the same file and the same
  // authorized_keys line, so the registry refuses the second (ADR 0002).
  const base = {
    workspace: '/w', sshUser: 'root', sshHelper: '/opt/dsh-helper/dsh-ssh-helper',
    sshHelperHash: 'd'.repeat(64),
  }
  const a = normalizeProfile({ ...base, id: 'a', port: 1, sshHost: 'box1' })
  const b = normalizeProfile({ ...base, id: 'b', port: 2, sshHost: 'box1' })
  assert.throws(() => parseRegistry({ profiles: [a, b] }), /already used by environment a/u)
  // A different helper path on the same host is a different environment.
  const c = normalizeProfile({ ...base, id: 'c', port: 3, sshHost: 'box1', sshHelper: '/opt/other' })
  assert.equal(parseRegistry({ profiles: [a, c] }).length, 2)
})

// --- provision ---------------------------------------------------------------

test('a generated patch is one YAML sequence even with a fragment', () => {
  // Every managed environment is an SSH environment, so the SSH renderer is the only
  // one; the fragment must still append as more rows of the same sequence.
  const text = renderSshPatch(sshProfile(), { fragment: '- id: agent-default-model\n  config:\n    provider: x' })
  const rows = yaml.load(text, { schema: yaml.DEFAULT_SCHEMA })
  const agentRow = rows.find((row) => row.id === 'agent-default-model')
  assert.deepEqual(Object.keys(agentRow), ['id', 'config'])
  assert.ok(Array.isArray(rows))
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

test('a managed environment declares the providers its patch mounts', () => {
  // A row naming an uninstalled package fails to import, and every service that
  // depends on it stays pending: the environment listens but cannot create a session.
  const deps = profileDependencies([], { harnessVersion: '0.2.1-rc.2' })
  for (const module of SSH_PROVIDER_MODULES) {
    assert.equal(deps[`@deepseek-ai/${module}`], '0.2.1-rc.2', module)
  }
  // Without a harness version the pins are skipped rather than guessed.
  assert.equal(profileDependencies([], {})['@deepseek-ai/dsh-ssh'], undefined)
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
    const profile = normalizeProfile({
      id: 'seed', port: 56800, workspace: '/w',
      sshHost: 'h', sshUser: 'root', sshHelper: '/opt/h', sshHelperHash: 'a'.repeat(64),
    })
    await writeProfile(dir, profile, { bundles: ['@deepseek-ai/dsh-base'] })
    const patchPath = join(dir, 'cordis.patch.yml')
    const seeded = await readFile(patchPath, 'utf8')
    assert.match(seeded, /workspace: \/w/u)

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
    const ssh = { sshHost: 'h', sshUser: 'root', sshHelper: '/h', sshHelperHash: 'f'.repeat(64) }
    assert.throws(() => normalizeProfile({ id, port: 1, workspace: '/w', ...ssh }), /reserved/u, id)
  }
})

test('ssh arguments omit -p unless a port is explicit', async () => {
  // An ssh_config alias may declare its own Port; an explicit `-p 22` on the
  // command line overrides it and connects to the wrong port, which fails as
  // "permission denied" and looks like a credentials problem.
  const { sshArguments } = await import('../lib/ssh.js')
  const alias = sshArguments({ sshHost: 'dsh-box1', sshUser: 'root' }, 'true', false)
  assert.equal(alias.includes('-p'), false)
  const explicit = sshArguments({ sshHost: 'h', sshUser: 'root', sshPort: 2222 }, 'true', false)
  assert.equal(explicit[explicit.indexOf('-p') + 1], '2222')
  // BatchMode must follow the auth mode or sshpass can never answer.
  assert.ok(alias.includes('BatchMode=yes'))
  assert.ok(sshArguments({ sshHost: 'h', sshUser: 'u' }, 'true', true).includes('BatchMode=no'))
})

test('adoption is a registry operation that leaves the profile untouched', async () => {
  // A hand-managed profile owns its bundles, plugins and persisted settings.
  // Adoption must record coordinates only: regenerating it would discard all of
  // that, which is exactly what an operator migrating a live deployment cannot
  // afford.
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'daemon-adopt-'))
  try {
    const profileDir = join(dir, 'existing')
    await mkdir(profileDir, { recursive: true })
    const manifest = { name: 'dsh-profile-existing', dependencies: {}, dsh: { profile: { bundles: ['a', 'b', 'c'] } } }
    await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(manifest)}\n`)
    const patch = '- id: something\n  config:\n    kept: true\n'
    await writeFile(join(profileDir, 'cordis.patch.yml'), patch)

    // Only the registry mutation matters here; the read/write helpers are the
    // same ones `adopt` uses.
    const before = await readFile(join(profileDir, 'package.json'), 'utf8')
    assert.deepEqual(JSON.parse(before).dsh.profile.bundles, ['a', 'b', 'c'])
    assert.equal(await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8'), patch)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the root profile answers a path no prefix claims', async () => {
  // This is what keeps an existing origin working: `/` and `/api` must reach the
  // root profile, while a registered prefix still wins over it.
  const { startEntry } = await import('../lib/entry.js')
  const { createServer } = await import('node:http')

  const rootServer = createServer((req, res) => {
    // The upstream only answers when the daemon attaches the session it holds.
    if (req.headers.cookie !== 'dsh-auth-x=session') {
      res.writeHead(401)
      res.end('no session')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`root:${req.url}`)
  })
  const profile = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`profile:${req.url}`)
  })
  await new Promise((done) => rootServer.listen(0, '127.0.0.1', done))
  await new Promise((done) => profile.listen(0, '127.0.0.1', done))

  const entry = await startEntry({
    host: '127.0.0.1',
    port: 0,
    listProfiles: () => [{ id: 'box1', port: profile.address().port }],
    local: async () => false,
    root: {
      port: () => rootServer.address().port,
      cookie: () => 'dsh-auth-x=session',
      ensure: async () => {},
      refresh: () => {},
    },
    notFound: (req, res) => {
      res.writeHead(404)
      res.end('none')
    },
  })
  try {
    const base = `http://127.0.0.1:${entry.port}`
    assert.equal(await (await fetch(`${base}/`)).text(), 'root:/')
    assert.equal(await (await fetch(`${base}/api/x`)).text(), 'root:/api/x')
    assert.equal(await (await fetch(`${base}/box1/deep`)).text(), 'profile:/deep')
  } finally {
    await entry.close()
    await new Promise((done) => rootServer.close(done))
    await new Promise((done) => profile.close(done))
  }
})

test('a rejected root session asks the browser to retry once', async () => {
  const { startEntry } = await import('../lib/entry.js')
  const { createServer } = await import('node:http')
  let refreshed = 0
  const rootServer = createServer((req, res) => {
    res.writeHead(401)
    res.end('no session')
  })
  await new Promise((done) => rootServer.listen(0, '127.0.0.1', done))
  const entry = await startEntry({
    host: '127.0.0.1',
    port: 0,
    listProfiles: () => [],
    local: async () => false,
    root: {
      port: () => rootServer.address().port,
      cookie: () => 'stale=1',
      ensure: async () => {},
      refresh: () => { refreshed += 1 },
    },
    notFound: (req, res) => { res.writeHead(404); res.end('none') },
  })
  try {
    const answer = await fetch(`http://127.0.0.1:${entry.port}/`)
    // 503 + retry, not a bare 401: the daemon dropped its cookie and the next
    // request re-exchanges instead of leaving the browser stuck.
    assert.equal(answer.status, 503)
    assert.equal(refreshed, 1)
  } finally {
    await entry.close()
    await new Promise((done) => rootServer.close(done))
  }
})

test('an empty password rejects every login instead of opening the door', async () => {
  // `Boolean('')` is false: the shipped gateway treats a missing password as an
  // unpassable login page, not as "no authentication". The daemon must not turn
  // that into an open door, and the operator needs to hear about it.
  const { createAuth } = await import('../lib/auth/gateway.js')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'daemon-auth-'))
  try {
    const auth = createAuth({ directory: dir, username: 'admin', password: '', realm: 'x' })
    const res = fakeResponse()
    // A body must be readable: an unreadable one is a 400, which would mask the
    // behaviour under test.
    await auth.handle(fakeRequest(JSON.stringify({ username: 'admin', password: '' })), res, '/api/auth.login', false)
    assert.equal(res.status, 403)
    assert.equal(res.body.ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the right password mints a session the store accepts', async () => {
  const { createAuth } = await import('../lib/auth/gateway.js')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'daemon-auth2-'))
  try {
    const auth = createAuth({ directory: dir, username: 'admin', password: 'pw', realm: 'x' })
    const res = fakeResponse()
    const body = JSON.stringify({ username: 'admin', password: 'pw' })
    await auth.handle(fakeRequest(body), res, '/api/auth.login', false)
    assert.equal(res.status, 200)
    const cookie = res.headers['set-cookie'][0].split(';')[0]
    // The cookie is `<id>.<issuedAt>`; the store rejects a mismatched issue time,
    // so both halves must survive the round trip.
    const record = auth.session({ headers: { cookie } }, false)
    assert.ok(record !== undefined)
    assert.equal(record.username, 'admin')
    // A wrong password must not mint one either.
    const bad = fakeResponse()
    await auth.handle(fakeRequest(JSON.stringify({ username: 'admin', password: 'no' })), bad, '/api/auth.login', false)
    assert.equal(bad.status, 401)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: undefined,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    end(body) {
      try {
        this.body = body === undefined ? undefined : JSON.parse(body)
      } catch {
        this.body = body
      }
    },
  }
}

function fakeRequest(payload) {
  const chunks = [Buffer.from(payload ?? '')]
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield* chunks
    },
  }
}

test('the passkey login endpoints are reachable without a session', async () => {
  // The login page offers a passkey button; if these routes sat behind the
  // session check the browser would loop on the login form instead.
  const { createAuth } = await import('../lib/auth/gateway.js')
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'daemon-pk-'))
  try {
    const auth = createAuth({ directory: dir, username: 'admin', password: 'pw', realm: 'x' })

    // No passkey is registered yet, so options must say so rather than throw.
    const missing = fakeResponse()
    await auth.handle(fakeRequest('{}'), missing, '/api/auth.passkey.login.options', false)
    assert.equal(missing.status, 404)

    // An unknown challenge is refused, never accepted.
    const verify = fakeResponse()
    await auth.handle(
      fakeRequest(JSON.stringify({ challenge: 'nope', response: { id: 'nope' } })),
      verify,
      '/api/auth.passkey.login.verify',
      false,
    )
    assert.equal(verify.status, 401)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a late startup line still yields the launch URL', async () => {
  // The line is printed asynchronously; if it lands after the readiness deadline
  // the profile runs but its URL is unknown, and the root bridge cannot mint the
  // session the browser needs. The parse therefore runs against the captured log.
  const { launchUrlFrom } = await import('../lib/supervisor.js')
  assert.equal(launchUrlFrom(''), undefined)
  assert.equal(launchUrlFrom('starting up\n'), undefined)
  assert.equal(
    launchUrlFrom('noise\ndsh web: http://127.0.0.1:57900/?token=abc123\n'),
    'http://127.0.0.1:57900/?token=abc123',
  )
})

test('the credential chain honours the names the retired gateway used', () => {
  // Migration must not invalidate an existing credential. The retired gateway
  // read DSH_AUTH_PASS or AUTH_PASS (and the matching user variable); honouring
  // only one name silently locks an operator out of their own deployment, which
  // is exactly what happened on the first cut.
  const chain = (env, prefix) =>
    env[`DSH_${prefix}`] ?? env[prefix] ?? ''
  assert.equal(chain({ DSH_AUTH_PASS: 'a', AUTH_PASS: 'b' }, 'AUTH_PASS'), 'a')
  assert.equal(chain({ AUTH_PASS: 'b' }, 'AUTH_PASS'), 'b')
  assert.equal(chain({}, 'AUTH_PASS'), '')
})

test('a prefixed root redirects bare / and strips its prefix', async () => {
  // The embedded harness is mounted under a prefix so its relative asset URLs
  // resolve against that mount; bare `/` must send the browser there.
  const { startEntry } = await import('../lib/entry.js')
  const { createServer } = await import('node:http')
  const upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`up:${req.url}`)
  })
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done))
  const entry = await startEntry({
    host: '127.0.0.1',
    port: 0,
    listProfiles: () => [],
    local: async () => false,
    root: {
      port: () => upstream.address().port,
      prefix: 'main',
      cookie: () => 'c=1',
      ensure: async () => {},
      refresh: () => {},
    },
    notFound: (req, res) => { res.writeHead(404); res.end('none') },
  })
  try {
    const base = `http://127.0.0.1:${entry.port}`
    const bare = await fetch(`${base}/`, { redirect: 'manual' })
    assert.equal(bare.status, 302)
    assert.equal(bare.headers.get('location'), '/main/')
    // The prefix is stripped before the upstream sees the path.
    assert.equal(await (await fetch(`${base}/main/deep`)).text(), 'up:/deep')
    assert.equal(await (await fetch(`${base}/main/`)).text(), 'up:/')
  } finally {
    await entry.close()
    await new Promise((done) => upstream.close(done))
  }
})

test('the embedded root mints its session from connection.authenticatedUrl', async () => {
  // The documented way to obtain a tokenized URL for a mount proxy. Scraping a
  // child's stdout was only necessary while the harness was a separate process.
  const { createServer } = await import('node:http')
  const cookies = []
  const upstream = createServer((req, res) => {
    // The token arrives as the sole query parameter; answering with the session
    // cookie is what a real listener does on a valid launch token.
    const url = new URL(req.url, 'http://x')
    if (url.searchParams.get('token') === 'process-token') {
      res.writeHead(303, {
        'set-cookie': ['dsh-auth-hash=session-value; Path=/; HttpOnly'],
        location: './',
      })
      res.end()
      return
    }
    if ((req.headers.cookie ?? '').includes('dsh-auth-hash=session-value')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('mounted')
      return
    }
    res.writeHead(401)
    res.end('no session')
  })
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done))
  try {
    // A faithful stand-in for the service the daemon reads.
    const connection = {
      authenticatedUrl(baseUrl) {
        const url = new URL(baseUrl)
        url.searchParams.set('token', 'process-token')
        return url.href
      },
    }
    const base = `http://127.0.0.1:${upstream.address().port}/`
    const tokenized = connection.authenticatedUrl(base)
    const answer = await fetch(tokenized, { redirect: 'manual' })
    const raw = answer.headers.getSetCookie?.() ?? []
    const found = raw.map((v) => /^(dsh-auth-[A-Za-z0-9_-]+=[^;]+)/u.exec(v)?.[1]).find(Boolean)
    cookies.push(found)
    assert.equal(found, 'dsh-auth-hash=session-value')
    // The cookie is then reusable against the upstream without the token.
    const replayed = await fetch(base, { headers: { cookie: found } })
    assert.equal(await replayed.text(), 'mounted')
  } finally {
    await new Promise((done) => upstream.close(done))
  }
})

// --- credentials -------------------------------------------------------------

test('the ssh fragment gives dsh-ssh everything it needs', async () => {
  // dsh-ssh passes only a target string to ssh: no -i, no -p, no -F. The identity,
  // port and user must therefore come from ssh's own configuration.
  const { renderSshConfig } = await import('../lib/credentials.js')
  const text = renderSshConfig(
    { sshHost: '10.0.0.5', sshPort: 2222, sshUser: 'deploy', sshKeyPath: '/keys/a/id_ed25519' },
    { alias: 'dsh-a' },
  )
  assert.match(text, /^Host dsh-a$/mu)
  assert.match(text, /^ {2}HostName 10\.0\.0\.5$/mu)
  assert.match(text, /^ {2}Port 2222$/mu)
  assert.match(text, /^ {2}User deploy$/mu)
  assert.match(text, /^ {2}IdentityFile \/keys\/a\/id_ed25519$/mu)
  // Without IdentitiesOnly an unrelated agent key could be offered first.
  assert.match(text, /^ {2}IdentitiesOnly yes$/mu)
})

test('an omitted port leaves the alias to decide', async () => {
  const { renderSshConfig } = await import('../lib/credentials.js')
  const text = renderSshConfig({ sshHost: 'h', sshUser: 'root', sshKeyPath: '/k' }, { alias: 'dsh-a' })
  assert.ok(!text.includes('Port'), 'no Port line when the port is omitted')
})

test('the include block is added once and removed exactly', async () => {
  // The operator's ssh config gains exactly one block. A second run must not append
  // another, and removal must leave every other line untouched.
  const { ensureSshInclude, removeSshInclude } = await import('../lib/credentials.js')
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'daemon-sshcfg-'))
  const path = join(dir, 'config')
  try {
    await writeFile(path, 'Host kept\n  HostName example.com\n')
    assert.equal(await ensureSshInclude({ configPath: path, includeDir: join(dir, 'd') }), true)
    assert.equal(await ensureSshInclude({ configPath: path, includeDir: join(dir, 'd') }), false, 'idempotent')
    const after = await readFile(path, 'utf8')
    assert.equal(after.match(/Include /gu).length, 1, 'one include line only')
    assert.match(after, /Host kept/u, 'existing content preserved')
    assert.equal(await removeSshInclude(path), true)
    const cleaned = await readFile(path, 'utf8')
    assert.ok(!cleaned.includes('Include'))
    assert.match(cleaned, /Host kept/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('known_hosts merges without duplicating a known host', async () => {
  const { mergeKnownHosts } = await import('../lib/credentials.js')
  const existing = 'h1 ssh-ed25519 AAAA\n'
  const merged = mergeKnownHosts(existing, ['h1 ssh-ed25519 AAAA', 'h2 ssh-ed25519 BBBB'])
  assert.equal(merged.trim().split('\n').length, 2)
})

test('the install command marks the key and replaces the previous one', async () => {
  // The marker is what makes rotation safe: the old line is matched exactly and
  // removed before the new one lands, so authorized_keys cannot accumulate keys
  // nobody can attribute.
  const { installPublicKeyCommand, removePublicKeyCommand } = await import('../lib/credentials.js')
  const install = installPublicKeyCommand('ssh-ed25519 AAAA key', 'env1')
  assert.match(install, /dsh-daemon:env1/u)
  assert.match(install, /grep -v/u, 'old line removed first')
  const remove = removePublicKeyCommand('env1')
  assert.match(remove, /dsh-daemon:env1/u)
  assert.match(remove, /grep -v/u)
})
