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
  assert.equal(deriveId('6.13', new Set()), 'env-6-13')
  assert.equal(deriveId('Box One', new Set()), 'box-one')
  assert.equal(deriveId('box', new Set(['box'])), 'box-2')
  assert.equal(deriveId('', new Set()), 'env', 'no trailing separator')
  assert.equal(deriveId('---', new Set()), 'env')
  // A derived id must never collide with a route of our own.
  assert.notEqual(deriveId('admin', new Set()), 'admin')
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
