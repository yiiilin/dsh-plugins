/**
 * Daemon tests: the wire format, the registry rules, and the routing table.
 *
 * What is tested here is what can be wrong without a live connection: a frame that
 * reassembles across socket messages, a registry that refuses two environments sharing a
 * token, a prefix that must not swallow `/admin`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { request as httpRequest } from 'node:http'
import yaml from 'js-yaml'
import { routeEnvironment, scopeCookiePath, scopeLocation } from '../lib/entry.js'
import {
  FRAME,
  FrameReader,
  MAX_FRAME_BYTES,
  encodeFrame,
  encodeJsonFrame,
  newRequestId,
} from '../lib/federation/frames.js'
import { tokenOf } from '../lib/federation/hub.js'
import {
  RESERVED_IDS,
  deriveId,
  freshToken,
  normalizeEnvironment,
  parseRegistry,
  serializeRegistry,
} from '../lib/registry.js'

/**
 * `!!js` marks a value the loader evaluates at mount time. These tests only read the
 * declarative shape around it, so the tag becomes an inert string.
 */
const JS_TAG = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: (value) => value })
const YAML_SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_TAG])

// --- frames -----------------------------------------------------------------

test('a frame survives being split across messages', () => {
  // WebSocket delivers whatever arrived, not what the protocol wants.
  const id = newRequestId()
  const head = encodeJsonFrame(FRAME.requestHead, id, { method: 'GET', path: '/' })
  const end = encodeFrame(FRAME.requestEnd, id)
  const reader = new FrameReader()
  assert.equal(reader.push(head.subarray(0, 7)).length, 0, 'partial frame yields nothing')
  const frames = reader.push(Buffer.concat([head.subarray(7), end]))
  assert.deepEqual(frames.map((frame) => frame.type), [FRAME.requestHead, FRAME.requestEnd])
  assert.deepEqual(JSON.parse(frames[0].payload.toString()), { method: 'GET', path: '/' })
  assert.ok(frames[0].id.equals(id))
  assert.ok(frames[1].id.equals(id))
})

test('several frames in one message all come out', () => {
  const a = newRequestId()
  const b = newRequestId()
  const blob = Buffer.concat([
    encodeFrame(FRAME.heartbeat, a),
    encodeFrame(FRAME.heartbeat, b),
    encodeFrame(FRAME.cancel, a),
  ])
  const frames = new FrameReader().push(blob)
  assert.equal(frames.length, 3)
  assert.deepEqual(frames.map((frame) => frame.type), [FRAME.heartbeat, FRAME.heartbeat, FRAME.cancel])
})

test('a payload keeps its bytes across the round trip', () => {
  // Binary bodies are the normal case: a compressed response must not be re-encoded.
  const id = newRequestId()
  const payload = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f])
  const frames = new FrameReader().push(encodeFrame(FRAME.responseBody, id, payload))
  assert.deepEqual([...frames[0].payload], [...payload])
})

test('an absurd length is refused rather than buffered', () => {
  // A corrupt prefix must not be allowed to allocate its way to an OOM.
  const id = newRequestId()
  const frame = encodeFrame(FRAME.requestHead, id, Buffer.from('x'))
  frame.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
  assert.throws(() => new FrameReader().push(frame), /exceeds/u)
})

test('an id of the wrong width is refused at encoding time', () => {
  assert.throws(() => encodeFrame(FRAME.requestEnd, Buffer.alloc(8)), /16 bytes/u)
})

// --- token extraction -------------------------------------------------------

test('a token is read from the query first, then the header', () => {
  // A browser's WebSocket API cannot set a header; a scripted client should not have to
  // put a secret in a URL. Both spellings are accepted.
  assert.equal(tokenOf({ url: '/_tunnel?token=abc', headers: {} }), 'abc')
  assert.equal(tokenOf({ url: '/_tunnel', headers: { authorization: 'Bearer xyz' } }), 'xyz')
  assert.equal(tokenOf({ url: '/_tunnel?token=abc', headers: { authorization: 'Bearer xyz' } }), 'abc')
  assert.equal(tokenOf({ url: '/_tunnel', headers: {} }), '')
  assert.equal(tokenOf({ url: '/_tunnel?other=1', headers: { authorization: 'Basic x' } }), '')
})

// --- registry ---------------------------------------------------------------

const sample = () => ({
  id: 'box1',
  label: '6.13',
  token: 'a'.repeat(43),
})

test('a record round-trips and keeps only known fields', () => {
  const environment = normalizeEnvironment({ ...sample(), enabled: false })
  assert.equal(environment.id, 'box1')
  assert.equal(environment.label, '6.13')
  assert.equal(environment.enabled, false)
  assert.deepEqual(parseRegistry({ environments: [environment] }), [environment])
})

test('an unknown field is rejected, not dropped', () => {
  // A silently ignored field is a configuration that looks applied and is not.
  assert.throws(() => normalizeEnvironment({ ...sample(), port: 56800 }), /unknown environment field/u)
})

test('ids must be safe to put in a URL path', () => {
  assert.throws(() => normalizeEnvironment({ ...sample(), id: 'Box 1' }), /must match/u)
  assert.throws(() => normalizeEnvironment({ ...sample(), id: '1box' }), /must match/u)
  for (const reserved of RESERVED_IDS) {
    assert.throws(() => normalizeEnvironment({ ...sample(), id: reserved }), /reserved/u, reserved)
  }
})

test('a short token is refused', () => {
  assert.throws(() => normalizeEnvironment({ ...sample(), token: 'short' }), /at least 32/u)
})

test('two environments cannot share a token', () => {
  // Identity comes from the token: sharing one would make an edge's identity depend on
  // insertion order.
  const one = normalizeEnvironment(sample())
  const two = normalizeEnvironment({ ...one, id: 'box2', label: 'other' })
  assert.throws(() => parseRegistry({ environments: [one, two] }), /share a token/u)
})

test('duplicate ids are refused', () => {
  const one = normalizeEnvironment(sample())
  assert.throws(() => parseRegistry({ environments: [one, one] }), /duplicate environment id/u)
})

test('an absent registry is empty, a malformed one throws', () => {
  assert.deepEqual(parseRegistry(undefined), [])
  assert.throws(() => parseRegistry({ profiles: [] }), /environments/u)
})

test('ids are derived safely and stay unique', () => {
  // The id is a node identifier, never a slug of the label: renaming a machine must not
  // move its URL. It only has to be URL-safe, unique, and not a route of our own.
  const generated = new Set()
  for (let i = 0; i < 50; i += 1) {
    const id = deriveId(generated)
    assert.match(id, /^[a-z][a-z0-9-]{0,31}$/u)
    assert.ok(!RESERVED_IDS.has(id), `${id} must not shadow a route`)
    generated.add(id)
  }
  assert.equal(generated.size, 50, 'ids never repeat')
  // Two calls with the same "taken" set still differ: the id is random, not derived.
  assert.notEqual(deriveId(new Set()), deriveId(new Set()))
  // A derived id must never collide with a route of our own.
})

test('a fresh token is long enough to be worth generating', () => {
  const token = freshToken()
  assert.ok(token.length >= 32, token)
  assert.notEqual(freshToken(), token)
})

test('the registry file is written readable only by its owner', async () => {
  // Every record carries the token that authenticates that edge.
  const dir = await mkdtemp(join(tmpdir(), 'daemon-reg-'))
  const path = join(dir, 'environments.json')
  try {
    await writeFile(path, serializeRegistry([normalizeEnvironment(sample())]), { mode: 0o600 })
    const mode = (await stat(path)).mode & 0o777
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
    const restored = parseRegistry(JSON.parse(await readFile(path, 'utf8')))
    assert.equal(restored.length, 1)
    assert.equal(restored[0].token, 'a'.repeat(43))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// --- routing ----------------------------------------------------------------

test('an environment path is stripped to what its harness expects', () => {
  assert.deepEqual(routeEnvironment('/box1', ['box1']), { id: 'box1', path: '/' })
  assert.deepEqual(routeEnvironment('/box1/', ['box1']), { id: 'box1', path: '/' })
  assert.deepEqual(routeEnvironment('/box1/api/x?y=1', ['box1']), { id: 'box1', path: '/api/x?y=1' })
})

test('a path is not matched by a prefix that only starts the same', () => {
  // `/box10` must not be routed to `box1`.
  assert.equal(routeEnvironment('/box10/x', ['box1']), undefined)
  assert.equal(routeEnvironment('/box1x', ['box1']), undefined)
})

test('the longest matching id wins', () => {
  assert.equal(routeEnvironment('/box-1/x', ['box', 'box-1']).id, 'box-1')
})

test('a cookie is rescoped to the environment path', () => {
  // Two environments answer on one origin, so an unscoped cookie would be sent to both.
  assert.equal(scopeCookiePath('a=b; Path=/', '/box1'), 'a=b; Path=/box1/')
  // Without a Path the browser would default to the request's directory, which for a
  // nested asset is not the environment root.
  assert.equal(scopeCookiePath('a=b', '/box1'), 'a=b; Path=/box1')
  // A cookie the upstream already scoped more tightly is left alone: adding a second
  // Path attribute would make the browser reject the whole Set-Cookie.
  assert.equal(scopeCookiePath('a=b; Path=/api', '/box1'), 'a=b; Path=/api')
})

test('a redirect is kept absolute and inside the environment', () => {
  assert.equal(scopeLocation('/main/', '/box1'), '/box1/main/')
  assert.equal(scopeLocation('https://elsewhere/x', '/box1'), 'https://elsewhere/x')
})

// --- packaging --------------------------------------------------------------

test('the package ships the modules it imports', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(manifest.files.includes('lib'), 'lib must ship')
  assert.ok(manifest.files.includes('client.js'), 'client must ship')
  // The federation modules are reached only at runtime, so a missing one shows up as a
  // failed import rather than a test failure.
  for (const name of ['lib/federation/frames.js', 'lib/federation/hub.js', 'lib/federation/agent.js']) {
    const path = new URL(`../${name}`, import.meta.url)
    await stat(path)
  }
})

test('the patch declares exactly one row naming this package', async () => {
  const text = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const rows = yaml.load(text, { schema: YAML_SCHEMA })
  assert.equal(rows.length, 1)
  const insert = rows[0].insert
  assert.equal(insert.length, 1)
  assert.equal(insert[0].name, '@yiln-dsh/dsh-daemon')
})

test('the patch defaults to the main role with no prefix', async () => {
  // An edge is a deliberate configuration, never a default: a fresh install that
  // silently tried to dial somewhere would be a mystery to debug.
  const rows = yaml.load(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), {
    schema: YAML_SCHEMA,
  })
  const config = rows[0].insert[0].config
  assert.equal(config.role, 'main')
  assert.equal(config.mainUrl, '')
  assert.equal(config.token, '')
  assert.equal(config.rootPrefix, '')
})

// --- end-to-end over a real socket -------------------------------------------

test('a request and its response cross a real tunnel', async () => {
  // The unit tests above cover each half; this one wires two hubs together over a
  // loopback WebSocket, because a frame format that both halves agree on is not the same
  // claim as a request that actually comes back.
  const { createServer } = await import('node:http')
  const { WebSocketServer } = await import('ws')
  const { createTunnelHub, tokenOf, TUNNEL_PATH } = await import('../lib/federation/hub.js')
  const { createTunnelAgent } = await import('../lib/federation/agent.js')

  const token = 'e'.repeat(43)
  const environment = { id: 'edge1', label: 'edge1', token, enabled: true }

  // The edge's "harness": answers everything with a fixed body.
  const harness = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'x-seen-host': String(req.headers.host) })
    res.end(`harness saw ${req.url} cookie=${req.headers.cookie ?? 'none'}`)
  })
  await new Promise((done) => harness.listen(0, '127.0.0.1', done))
  const harnessPort = harness.address().port

  // The main node's listener, which also accepts the tunnel.
  const hub = createTunnelHub({
    logger: { info() {}, warn() {} },
    verifyToken: (value) => (value === token ? environment : undefined),
  })
  const tunnelServer = new WebSocketServer({ noServer: true })
  const main = createServer((req, res) => {
    // `entry.js` strips the prefix before handing the path over; the test does the same
    // rather than expecting the hub to know about routing.
    const routed = routeEnvironment(req.url ?? '/', ['edge1'])
    if (routed === undefined || !hub.proxy(routed.id, req, res, routed.path)) {
      res.writeHead(503)
      res.end('offline')
    }
  })
  main.on('upgrade', (req, socket, head) => {
    if ((req.url ?? '').split('?')[0] !== TUNNEL_PATH) { socket.destroy(); return }
    const found = hub.verify(tokenOf(req))
    if (found === undefined) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return }
    tunnelServer.handleUpgrade(req, socket, head, (ws) => hub.accept(found, ws))
  })
  await new Promise((done) => main.listen(0, '127.0.0.1', done))
  const mainPort = main.address().port

  const agent = createTunnelAgent({
    mainUrl: `http://127.0.0.1:${mainPort}`,
    token,
    harnessPort: () => harnessPort,
    harnessCookie: async () => 'dsh-auth-test=1',
    logger: { info() {}, warn() {} },
  })
  agent.start()

  try {
    // Wait for the tunnel to come up rather than guessing a delay.
    for (let i = 0; i < 100 && !hub.isOnline('edge1'); i += 1) {
      await new Promise((done) => setTimeout(done, 50))
    }
    assert.ok(hub.isOnline('edge1'), 'the edge should be online')

    const answer = await new Promise((done, fail) => {
      const req = httpRequest({ host: '127.0.0.1', port: mainPort, path: '/edge1/api/x', method: 'GET' }, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => done({ status: res.statusCode, headers: res.headers, body }))
      })
      req.on('error', fail)
      req.end()
    })

    assert.equal(answer.status, 200)
    // The harness must see its own authority and the daemon's cookie, not the browser's.
    assert.match(answer.body, /harness saw \/api\/x/u)
    assert.match(answer.body, /cookie=dsh-auth-test=1/u)
    assert.match(String(answer.headers['x-seen-host']), /^127\.0\.0\.1:\d+$/u)
  } finally {
    agent.stop()
    hub.close()
    await new Promise((done) => main.close(done))
    await new Promise((done) => harness.close(done))
    tunnelServer.close()
  }
})

// --- inventory ---------------------------------------------------------------

test('a skill description comes out of the frontmatter', async () => {
  const { frontmatterDescription } = await import('../lib/inventory.js')
  assert.equal(frontmatterDescription('---\ndescription: does a thing\n---\nbody'), 'does a thing')
  assert.equal(frontmatterDescription('---\ndescription: "quoted"\n---\n'), 'quoted')
  // No frontmatter, or no description in it, is not an error — the skill simply has none.
  assert.equal(frontmatterDescription('# heading\n'), '')
  assert.equal(frontmatterDescription('---\nname: x\n---\n'), '')
})

test('inventory reads a profile and its skills from disk', async () => {
  // The edge answers this over the tunnel, so the shape has to be right before it is
  // ever sent.
  const { readInventory } = await import('../lib/inventory.js')
  const home = await mkdtemp(join(tmpdir(), 'daemon-inv-'))
  try {
    const profileDir = join(home, 'profiles', 'demo')
    await rm(profileDir, { recursive: true, force: true })
    await (await import('node:fs/promises')).mkdir(profileDir, { recursive: true })
    await writeFile(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { '@deepseek-ai/dsh-base': '1.0.0', 'ws': '8.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
    }))
    const skills = join(home, 'skills')
    await (await import('node:fs/promises')).mkdir(join(skills, 'alpha'), { recursive: true })
    await writeFile(join(skills, 'alpha', 'SKILL.md'), '---\ndescription: first\n---\n')
    // A directory with no SKILL.md is not a skill and must not be listed.
    await (await import('node:fs/promises')).mkdir(join(skills, 'notaskill'), { recursive: true })

    const inventory = await readInventory({ homeDir: home, profile: 'demo', skillsRoot: skills, plugins: ['p1'] })
    assert.equal(inventory.profile, 'demo')
    assert.deepEqual(inventory.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    assert.deepEqual(inventory.packages, ['@deepseek-ai/dsh-base', 'ws'])
    assert.deepEqual(inventory.skills, [{ name: 'alpha', description: 'first' }])
    assert.deepEqual(inventory.plugins, ['p1'])
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a missing profile reports empty lists rather than throwing', async () => {
  // An inventory request must always answer: the caller is a remote node that cannot
  // inspect this filesystem to find out why.
  const { readInventory } = await import('../lib/inventory.js')
  const inventory = await readInventory({
    homeDir: '/nonexistent-daemon-test',
    profile: 'absent',
    skillsRoot: '/nonexistent-daemon-test/skills',
    plugins: [],
  })
  assert.deepEqual(inventory.bundles, [])
  assert.deepEqual(inventory.packages, [])
  assert.deepEqual(inventory.skills, [])
})

// --- model configuration -----------------------------------------------------

test('model rows are extracted without YAML round-tripping', async () => {
  // The reason this is line-based: a YAML round trip rewrites the key `off` to `false`,
  // and `reasoningEfforts` uses `off` as a key, so the config is then rejected.
  const { extractModelRows } = await import('../lib/model-config.js')
  const patch = [
    '- id: something-else',
    '  config:',
    '    a: 1',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    '    provider: p',
    '    model: m',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      p:',
    '        reasoningEfforts:',
    '          off: null',
    '- id: after',
  ].join('\n')
  const rows = extractModelRows(patch)
  assert.match(rows, /agent-default-model/u)
  assert.match(rows, /llm-pi-ai/u)
  assert.match(rows, /off: null/u, 'the key off survives')
  assert.ok(!rows.includes('after'), 'unrelated rows are not included')
  assert.ok(!rows.includes('something-else'))
})

test('replacing model rows leaves every other row alone', async () => {
  const { extractModelRows, replaceModelRows } = await import('../lib/model-config.js')
  const patch = [
    '- id: keep-before',
    '  config:',
    '    x: 1',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      old:',
    '        k: v',
    '- id: keep-after',
    '  config:',
    '    y: 2',
  ].join('\n')
  const rows = [
    '- id: agent-default-model',
    '  config:',
    '    provider: new',
  ].join('\n')
  const result = replaceModelRows(patch, rows)
  assert.match(result, /keep-before/u)
  assert.match(result, /keep-after/u)
  assert.ok(!result.includes('old:'), 'the previous model row is gone')
  assert.equal(extractModelRows(result), rows.trim())
})

test('a summary reports whether a key exists without exposing it', async () => {
  const { summarizeModelRows } = await import('../lib/model-config.js')
  const rows = [
    '- id: agent-default-model',
    '  config:',
    '    provider: p',
    '    model: m',
    '    reasoningEffort: high',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      p:',
    '        apiKeyEnv: SOME_KEY',
    '        baseURL: https://example.test/v1',
  ].join('\n')
  const withKey = summarizeModelRows(rows, true)
  assert.equal(withKey.provider, 'p')
  assert.equal(withKey.model, 'm')
  assert.equal(withKey.reasoningEffort, 'high')
  assert.equal(withKey.apiKeyEnv, 'SOME_KEY')
  assert.equal(withKey.hasApiKey, true)
  assert.equal(withKey.configured, true)
  // The summary names the variable and nothing more.
  assert.ok(!JSON.stringify(withKey).includes('secret'))
  assert.equal(summarizeModelRows(rows, false).hasApiKey, false)
  // A node with no model config says so rather than reporting half a config.
  assert.equal(summarizeModelRows('', false).configured, false)
})

// --- systemd -----------------------------------------------------------------

test('a unit reproduces how the process was started', async () => {
  const { renderUnit } = await import('../lib/systemd.js')
  const text = renderUnit({
    name: 'dsh-test',
    argv: ['node', '/usr/local/bin/dsh', '--profile', 'main', '--no-open'],
    execPath: '/usr/local/bin/node',
    port: 56789,
    env: { DSH_HOME: '/root/.dsh', HOME: '/root', PATH: '/usr/local/bin:/usr/bin' },
  })
  assert.match(text, /^ExecStart=\/usr\/local\/bin\/node \/usr\/local\/bin\/dsh --profile main --port 56789$/mu)
  // `--no-open` would try to launch a browser on every boot.
  assert.ok(!text.includes('--no-open'))
  assert.match(text, /^Restart=always$/mu)
  assert.match(text, /^Environment=DSH_HOME=\/root\/\.dsh$/mu)
  assert.match(text, /^WantedBy=multi-user\.target$/mu)
})

test('a unit refuses to guess when it cannot describe the process', async () => {
  // Writing a unit that starts something else is worse than writing none.
  const { renderUnit } = await import('../lib/systemd.js')
  assert.throws(() => renderUnit({ name: 'x', argv: ['node'], execPath: '/n', env: {} }), /script to run/u)
})

test('systemd quoting survives spaces and quotes', async () => {
  const { systemdQuote } = await import('../lib/systemd.js')
  assert.equal(systemdQuote('/plain/path'), '/plain/path')
  assert.equal(systemdQuote('/with space/x'), '"/with space/x"')
  assert.equal(systemdQuote(''), '""')
  // A quote inside a value has to be escaped, or systemd ends the value early.
  assert.match(systemdQuote('a"b'), /^".*\\".*"$/u)
})

test('the unit name is fixed, on every machine', async () => {
  // Deriving it from role or port would make the name depend on configuration, so
  // changing a port would leave a stale unit behind that still starts on boot.
  const { UNIT_NAME, unitNameFor } = await import('../lib/systemd.js')
  assert.equal(UNIT_NAME, 'dsh-daemon')
  assert.equal(unitNameFor(), 'dsh-daemon')
})

test('being under systemd is read from the environment systemd sets', async () => {
  const { underSystemd } = await import('../lib/systemd.js')
  assert.equal(underSystemd({ INVOCATION_ID: 'abc' }), true)
  assert.equal(underSystemd({}), false)
  assert.equal(underSystemd({ INVOCATION_ID: '' }), false)
})
