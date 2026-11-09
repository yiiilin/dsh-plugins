/**
 * The session overview: every node's live sessions, grouped by the node they are on.
 *
 * Two harnesses, for two different questions.
 *
 * The real mount answers "is this wired up": the same pairing credential, the same
 * session gate, the same registry and the same admin router the panel talks to. A
 * request that skips the gate, or a route that only works when nothing is registered,
 * shows up here and nowhere else.
 *
 * The fake hub answers "what does it say when a node misbehaves". The tunnel hub offers
 * three things the aggregation uses — send a request, ask whether a node is online, list
 * the connected ids — so a stand-in is enough, and it is the only way to make a timeout
 * and a broken node deterministic. A second real daemon would be slow, flaky, and unable
 * to fail on cue.
 *
 * What is asserted is what a caller sees: the response body and the fact that a request
 * was or was not made. Never the shape of the source that produced it.
 */

import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { createAdmin } from '../lib/admin.js'
import { PAIRING_CREDENTIAL_FILE } from '../lib/auth/pairing-credential.js'

/** A cheap work factor: one record per mount, fast enough for a test. */
const CHEAP = Object.freeze({ N: 1024, r: 8, p: 1, keylen: 32 })

/** The credential the seeded record stands for. */
const CREDENTIAL = 'pairing credential 7b31'

/** Long enough for a token, and a legal environment id. */
const TOKEN = 't'.repeat(48)

/** The two environments the fake-hub harness knows about. */
const ALPHA = { id: 'nalpha', label: 'alpha', token: TOKEN, enabled: true }
const BETA = { id: 'nbeta', label: 'beta', token: `${TOKEN}b`, enabled: true }

/** A temporary DSH home; the production path is never touched. */
async function temporaryHome() {
  return await mkdtemp(join(tmpdir(), 'dsh-gateway-sessions-'))
}

/** Seed `daemon/auth/pairing.json`, the only source of the credential. */
async function seedCredential(home) {
  const directory = join(home, 'daemon', 'auth')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const salt = randomBytes(16)
  const hash = scryptSync(CREDENTIAL, salt, CHEAP.keylen, { ...CHEAP, maxmem: 64 * 1024 * 1024 })
  await writeFile(join(directory, PAIRING_CREDENTIAL_FILE), `${JSON.stringify({
    version: 1,
    credential: {
      kdf: 'scrypt',
      salt: salt.toString('base64url'),
      hash: hash.toString('base64url'),
      ...CHEAP,
      createdAt: 1_600_000_000_000,
    },
  })}\n`, { mode: 0o600 })
}

/** Seed `daemon/environments.json` so the mounted daemon has a registry to aggregate. */
async function seedRegistry(home, environments) {
  await mkdir(join(home, 'daemon'), { recursive: true, mode: 0o700 })
  await writeFile(join(home, 'daemon', 'environments.json'), `${JSON.stringify({ environments }, null, 2)}\n`, {
    mode: 0o600,
  })
}

/**
 * Mount the daemon and wait until it is listening.
 *
 * The listener is started by the plugin's own effect, so the bound port is only known
 * from the daemon's startup line.
 */
async function startDaemon(home, config = {}) {
  let announce
  const listening = new Promise((done) => { announce = done })
  const disposers = []
  const ctx = {
    logger: {
      info: (message) => {
        const match = /listening on .*:(\d+)$/u.exec(message)
        if (match !== null) announce(Number(match[1]))
        return true
      },
      warn: () => true,
    },
    get: () => undefined,
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    on: () => () => {},
  }
  apply(ctx, {
    homeDir: home,
    registryPath: join(home, 'daemon', 'environments.json'),
    cacheDir: join(home, 'daemon', 'cache'),
    host: '127.0.0.1',
    port: 0,
    rootEmbedded: false,
    systemdUnit: '',
    accept: true,
    profile: '',
    ...config,
  })
  const port = await listening
  return {
    origin: `http://127.0.0.1:${port}`,
    async close() {
      for (const dispose of disposers) await dispose()
    },
  }
}

/** Run `body` against a freshly mounted daemon and always tear it down. */
async function withDaemon(config, body) {
  const home = await temporaryHome()
  await seedCredential(home)
  const daemon = await startDaemon(home, config)
  try {
    return await body(daemon)
  } finally {
    await daemon.close()
    await rm(home, { recursive: true, force: true })
  }
}

/** Pair this browser and return the `Cookie` header value it should send. */
async function pair(origin) {
  const response = await fetch(`${origin}/api/auth.login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: CREDENTIAL }),
  })
  assert.equal(response.status, 200, 'the pairing credential was accepted')
  const cookies = response.headers.getSetCookie()
  assert.ok(cookies.length > 0, 'pairing set a session cookie')
  return cookies.map((value) => value.split(';')[0]).join('; ')
}

/**
 * A stand-in for the tunnel hub.
 *
 * Only the three things the aggregation uses are implemented. Each online node's answer
 * is scripted, which is what makes an unreachable, a slow and a broken node testable
 * without a second process and without waiting for anything real.
 *
 * @param options.online - ids the hub reports a live tunnel for.
 * @param options.replies - id -> one of
 *   `{ kind: 'sessions', sessions }`, `{ kind: 'envelope', nodes }`,
 *   `{ kind: 'error', message }`, `{ kind: 'hang' }`, `{ kind: 'barrier', sessions }`.
 *   A `barrier` answer is held until every online node has been asked, so a fan-out
 *   that asks one node at a time deadlocks instead of quietly passing.
 */
function fakeHub({ online, replies }) {
  const sent = []
  const held = []
  let barriers = 0
  const hub = {
    sent,
    ids: () => [...online],
    isOnline: (id) => online.includes(id),
    request(envId, request, handlers) {
      if (!online.includes(envId)) return false
      sent.push({ envId, method: request.method, path: request.path })
      const reply = replies[envId] ?? { kind: 'hang' }
      const answer = (value) => {
        handlers.onBody(Buffer.from(JSON.stringify(value), 'utf8'))
        handlers.onEnd()
      }
      if (reply.kind === 'hang') return true
      if (reply.kind === 'error') {
        handlers.onError(new Error(reply.message))
        return true
      }
      // The shape an edge's own daemon answers with: one `self` envelope.
      const envelope = reply.kind === 'envelope'
        ? reply.nodes
        : [{ id: FAKE_SELF, state: 'ok', sessions: reply.sessions ?? [] }]
      if (reply.kind === 'barrier') {
        barriers += 1
        held.push(() => answer({ ok: true, partial: false, nodes: envelope }))
        if (barriers >= online.length) {
          for (const release of held.splice(0)) release()
        }
        return true
      }
      answer({ ok: true, partial: false, nodes: envelope })
      return true
    },
  }
  return hub
}

/** A registry over a fixed list. The overview only ever reads it. */
function fakeRegistry(environments) {
  return {
    list: () => environments,
    find: (id) => environments.find((environment) => environment.id === id),
  }
}

/** A session as the auth layer projects it, for a node that is not this one. */
function session(id, overrides = {}) {
  return {
    id,
    address: '10.0.0.9',
    userAgent: 'Mozilla/5.0 (test)',
    issuedAt: 1_700_000_000_000,
    lastSeenAt: 1_700_000_060_000,
    expiresAt: 1_700_600_000_000,
    current: false,
    ...overrides,
  }
}

/**
 * Serve the admin router over a real socket, with a fake hub behind it.
 *
 * The router is the same function the mounted daemon calls; only the tunnel hub is
 * replaced, so what is asserted here is the endpoint's own behaviour rather than the
 * daemon's wiring (which the mounted tests cover).
 */
async function withFakeHub({
  online = [], replies = {}, keepsRegistry = true, sessions = () => [], environments = [ALPHA, BETA], relayTimeoutMs,
}, body) {
  const hub = fakeHub({ online, replies })
  // The admin reaches other nodes through the peer accessor. This stub drives the fake
  // hub's request simulation and honours `relayTimeoutMs`, which is what the `hang`
  // replies exercise — without it a hanging node would wait for ever.
  const getPeer = () => ({
    json: (envId, request) => new Promise((resolve) => {
      let body = ''
      let done = false
      const finish = (value) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(
        () => finish({ ok: false, error: 'the environment did not answer in time' }),
        relayTimeoutMs ?? 50,
      )
      const sent = hub.request(envId, request, {
        onBody(chunk) { body += chunk },
        onEnd() {
          try {
            finish({ ok: true, body: JSON.parse(body === '' ? '{}' : body) })
          } catch {
            finish({ ok: false, error: 'not json' })
          }
        },
        onError(error) { finish({ ok: false, error: String(error?.message ?? error) }) },
        onClose() { finish({ ok: false, error: 'closed' }) },
      })
      if (sent === false) finish({ ok: false, error: `environment "${envId}" is offline` })
    }),
  })
  const admin = createAdmin({
    registry: fakeRegistry(environments),
    hub,
    config: { accept: keepsRegistry },
    nodeId: () => FAKE_SELF,
    sessions,
    relayTimeoutMs,
    getPeer,
    logger: { info: () => true, warn: () => true },
  })
  const server = createServer((req, res) => {
    void admin(req, res, req.url).then((handled) => {
      if (handled === true) return
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not handled\n')
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`
  try {
    return await body({ origin, hub })
  } finally {
    await new Promise((done) => {
      server.close(() => done())
      server.closeAllConnections?.()
    })
  }
}

/** Read the overview over HTTP, as the panel does. */
async function overview(origin, path = '/admin/sessions', cookie) {
  const response = await fetch(`${origin}${path}`, cookie === undefined ? {} : { headers: { cookie } })
  const body = await response.json()
  return { response, body }
}

/** The id the fake-hub router is told to use. */
const FAKE_SELF = 'nselftest0000001'

/**
 * The id this node calls itself, read from the daemon that is running.
 *
 * There is no `'self'` alias any more, and the id is generated per profile, so a test that
 * hardcodes one is asserting against a value the code never produces.
 */
async function ownIdOf(origin, cookie) {
  // Asked of the node itself: there is no `'self'` row to look for any more, and the id is
  // generated per profile, so a test cannot name it in advance.
  const answer = await fetch(`${origin}/admin/state`, { headers: { cookie } })
  const body = await answer.json()
  const own = body?.self?.envId
  assert.match(String(own), /^n[0-9a-f]+$/u, `this node reports an id, not an alias (got ${JSON.stringify(body).slice(0, 200)})`)
  return own
}

/** The node envelope for one id, or a failure naming what came back instead. */
function node(body, id) {
  const found = body.nodes.find((entry) => entry.id === id)
  assert.ok(found !== undefined, `expected a node envelope for ${id}, got ${JSON.stringify(body.nodes)}`)
  return found
}

// --- the real mount ---------------------------------------------------------

test('the overview includes this node\'s own sessions, marked with the one asking', async () => {
  // The main node takes its own sessions directly: no relay, no tunnel, and the session
  // that made the request is the one the panel needs marked.
  await withDaemon({}, async ({ origin }) => {
    const cookie = await pair(origin)

    const response = await fetch(`${origin}/admin/sessions`, { headers: { cookie } })
    assert.equal(response.status, 200)
    assert.match(String(response.headers.get('content-type')), /^application\/json/u)
    const body = await response.json()

    assert.equal(body.ok, true)
    assert.equal(body.partial, false, 'nothing failed, so the answer is whole')
    assert.equal(body.nodes.length, 1, 'no environments are registered, so there is one node')
    // The row this node contributes is the only one, so its id is the answer's own. There
    // is no `'self'` alias to look for and the id is generated per profile.
    const self = body.nodes[0]
    assert.match(self.id, /^n[0-9a-f]+$/u, 'this node reports an id, not an alias')
    assert.equal(self.state, 'ok', 'the node the panel is read on reports its own health')
    assert.equal(self.sessions.length, 1, 'the pairing session is live')
    const [only] = self.sessions
    assert.equal(only.current, true, 'the session that asked is the current one')
    assert.equal(typeof only.id, 'string')
    assert.equal(typeof only.address, 'string')
    assert.equal(typeof only.userAgent, 'string')
    assert.equal(typeof only.issuedAt, 'number')
    assert.equal(typeof only.lastSeenAt, 'number')
    assert.equal(typeof only.expiresAt, 'number')
  })
})

test('the overview sits behind the same session gate as the rest of the admin API', async () => {
  // Read-only is not the same as public: the table names every client address that is
  // signed in anywhere in the federation.
  await withDaemon({}, async ({ origin }) => {
    const response = await fetch(`${origin}/admin/sessions`)
    assert.equal(response.status, 200)
    assert.match(String(response.headers.get('content-type')), /^text\/html/u, 'a visitor without a session gets the page')
    const html = await response.text()
    assert.doesNotMatch(html, /"sessions":/u, 'no session table leaked into the login page')
  })
})

test('a registered environment with no tunnel is offline, and not an empty node', async () => {
  // The whole point of the per-node envelope: a machine that cannot be reached must not
  // read as a machine nobody is signed in on.
  const home = await temporaryHome()
  await seedCredential(home)
  await seedRegistry(home, [ALPHA])
  const daemon = await startDaemon(home)
  try {
    const cookie = await pair(daemon.origin)
    const paired = await fetch(`${daemon.origin}/admin/sessions`, { headers: { cookie } }).then((r) => r.json())

    assert.equal(paired.ok, true)
    // The row this node contributes is the one the registry does not name.
    const self = node(paired, paired.nodes.find((one) => one.id !== ALPHA.id).id)
    assert.equal(self.state, 'ok')
    assert.equal(self.sessions.length, 1, 'this node answered for itself')

    const alpha = node(paired, ALPHA.id)
    assert.equal(alpha.state, 'offline', 'an environment with no tunnel is marked offline')
    assert.equal(alpha.label, ALPHA.label, 'the node is named the way the environment list names it')
    assert.equal(Object.hasOwn(alpha, 'sessions'), false, 'an offline node carries no session list at all')
    assert.match(alpha.error, /offline/u, 'and says why there is nothing to show')
    assert.equal(paired.partial, true, 'one unreachable node makes the answer partial, not a failure')
  } finally {
    await daemon.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('the overview offers no way to change a session', async () => {
  // The list is the last place an operator could sign themselves out by accident, and
  // withdrawing someone else's session needs a write across nodes this surface does not
  // have. So anything but a read is refused, and the session survives the attempt.
  await withDaemon({}, async ({ origin }) => {
    const cookie = await pair(origin)

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(`${origin}/admin/sessions`, { method, headers: { cookie } })
      assert.equal(response.status, 405, `${method} is refused`)
      assert.equal(response.headers.get('allow'), 'GET', `${method} is told what is allowed`)
      const body = await response.json()
      assert.equal(body.ok, false)
      assert.match(body.error, /read-only/u)
    }

    // And the browser that tried is still signed in: no attempt was silently a logout.
    const after = await fetch(`${origin}/admin/sessions`, { headers: { cookie } })
    assert.equal(after.status, 200)
    const body = await after.json()
    assert.equal(node(body, await ownIdOf(origin, cookie)).sessions.length, 1, 'the session is untouched')
  })
})

test('the overview is answered under the mount the panel is served from', async () => {
  // The panel lives inside the harness, so its requests resolve against that mount. A
  // route that only answers at the origin root is a table that never loads.
  await withDaemon({ rootPrefix: '/main' }, async ({ origin }) => {
    const cookie = await pair(origin)
    const { response, body } = await overview(origin, '/main/admin/sessions', cookie)
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(node(body, await ownIdOf(origin, cookie)).sessions.length, 1)
  })
})

// --- the fan-out, against a fake hub ----------------------------------------

test('an edge\'s sessions appear, tagged with the node they are on', async () => {
  // The edge answers the same route for itself and tags the envelope `self`, which is
  // only meaningful on that edge. The main node re-tags it with the id and label its own
  // registry knows, because that is the name the panel and the environment list use.
  const alphaSessions = [session('a1'), session('a2')]
  await withFakeHub({
    online: [ALPHA.id],
    replies: { [ALPHA.id]: { kind: 'sessions', sessions: alphaSessions } },
    environments: [ALPHA],
    sessions: () => [session('s1', { current: true })],
  }, async ({ origin, hub }) => {
    const { response, body } = await overview(origin)
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)
    assert.equal(body.partial, false)

    assert.deepEqual(node(body, FAKE_SELF).sessions.map((one) => one.id), ['s1'], 'this node\'s own sessions are still there')
    const alpha = node(body, ALPHA.id)
    assert.equal(alpha.label, ALPHA.label)
    assert.equal(alpha.state, 'ok')
    assert.deepEqual(alpha.sessions, alphaSessions, 'every field the auth layer projects travels unchanged')
    assert.equal(hub.sent.length, 1, 'each online node is asked exactly once')
    assert.equal(hub.sent[0].path, '/admin/sessions', 'and is asked the same read-only route')
    assert.equal(hub.sent[0].method, 'GET')
  })
})

test('an offline node is distinguishable from a node with no sessions', async () => {
  // Both look like "nothing to show" in a flat list. Here one carries an empty list and
  // the other carries no list at all, so the two cannot be read as the same thing.
  await withFakeHub({
    online: [ALPHA.id],
    replies: { [ALPHA.id]: { kind: 'sessions', sessions: [] } },
  }, async ({ origin, hub }) => {
    const { body } = await overview(origin)

    const empty = node(body, ALPHA.id)
    assert.equal(empty.state, 'ok')
    assert.deepEqual(empty.sessions, [], 'a node that answered with nothing is a node with no sessions')

    const offline = node(body, BETA.id)
    assert.equal(offline.state, 'offline')
    assert.equal(Object.hasOwn(offline, 'sessions'), false, 'a node nobody could reach has no list to misread')
    assert.ok(typeof offline.error === 'string' && offline.error.length > 0, 'and says why')

    assert.equal(hub.sent.length, 1, 'the offline node is not asked at all: there is no tunnel to ask through')
    assert.equal(body.partial, true)
  })
})

test('a node that never answers is marked timed out, and the rest of the table still returns', async () => {
  // A hung node must not hold the table: the timeout is per node, and the other nodes'
  // rows arrive whole. This is the case a flat list would turn into an empty table.
  await withFakeHub({
    online: [ALPHA.id, BETA.id],
    replies: {
      [ALPHA.id]: { kind: 'hang' },
      [BETA.id]: { kind: 'sessions', sessions: [session('b1')] },
    },
    sessions: () => [session('s1', { current: true })],
    relayTimeoutMs: 60,
  }, async ({ origin }) => {
    const { body } = await overview(origin)

    const alpha = node(body, ALPHA.id)
    assert.equal(alpha.state, 'timeout', 'a silent node is marked timed out')
    assert.equal(Object.hasOwn(alpha, 'sessions'), false, 'and offers no list')
    assert.match(alpha.error, /in time/u, 'the reason says the answer never came')

    assert.deepEqual(node(body, BETA.id).sessions.map((one) => one.id), ['b1'], 'the other node still answers')
    assert.deepEqual(node(body, FAKE_SELF).sessions.map((one) => one.id), ['s1'], 'and so does this node')
    assert.equal(body.partial, true)
  })
})

test('a node that errors carries its error, and the rest of the table still returns', async () => {
  // A tunnel that drops mid-request, or an edge whose daemon is broken, is a different
  // state from a slow one: the error travels instead of being flattened into "no rows".
  await withFakeHub({
    online: [ALPHA.id, BETA.id],
    replies: {
      [ALPHA.id]: { kind: 'error', message: 'the tunnel closed before the environment answered' },
      [BETA.id]: { kind: 'sessions', sessions: [session('b1')] },
    },
    sessions: () => [session('s1', { current: true })],
  }, async ({ origin }) => {
    const { response, body } = await overview(origin)

    // A node failing is not the endpoint failing: the answer is still a 200 with rows.
    assert.equal(response.status, 200)
    assert.equal(body.ok, true)

    const alpha = node(body, ALPHA.id)
    assert.equal(alpha.state, 'error')
    assert.match(alpha.error, /tunnel closed/u, 'the node\'s own words reach the caller')
    assert.equal(Object.hasOwn(alpha, 'sessions'), false)

    assert.deepEqual(node(body, BETA.id).sessions.map((one) => one.id), ['b1'])
    assert.equal(body.partial, true)
  })
})

test('an edge that answers something other than its own sessions is reported as an error', async () => {
  // The relay parses whatever the edge sent. An edge running an older build, or a
  // misrouted request, must not be presented as a node with no sessions.
  await withFakeHub({
    online: [ALPHA.id],
    replies: { [ALPHA.id]: { kind: 'envelope', nodes: [{ id: 'somebody-else', state: 'ok', sessions: [] }] } },
  }, async ({ origin }) => {
    const { body } = await overview(origin)
    const alpha = node(body, ALPHA.id)
    assert.equal(alpha.state, 'error')
    assert.match(alpha.error, /without its own sessions/u)
    assert.equal(Object.hasOwn(alpha, 'sessions'), false)
  })
})

test('the nodes are asked in parallel, so one slow node does not queue the others', async () => {
  // Every node's answer is withheld until every node has been asked. A fan-out that
  // waited for one node before asking the next would deadlock here and time out, so
  // this fails on the thing that matters — the order of the requests — instead of on a
  // wall-clock threshold that would go flaky under load.
  await withFakeHub({
    online: [ALPHA.id, BETA.id],
    replies: {
      [ALPHA.id]: { kind: 'barrier', sessions: [session('a1')] },
      [BETA.id]: { kind: 'barrier', sessions: [session('b1')] },
    },
    sessions: () => [],
    relayTimeoutMs: 1_000,
  }, async ({ origin, hub }) => {
    const { body } = await overview(origin)

    assert.deepEqual(hub.sent.map((entry) => entry.envId), [ALPHA.id, BETA.id], 'both nodes are asked')
    assert.equal(node(body, ALPHA.id).state, 'ok', 'the first node was answered before it timed out')
    assert.deepEqual(node(body, ALPHA.id).sessions.map((one) => one.id), ['a1'])
    assert.equal(node(body, BETA.id).state, 'ok', 'and so was the second')
    assert.deepEqual(node(body, BETA.id).sessions.map((one) => one.id), ['b1'])
    assert.equal(body.partial, false)
  })
})

test('an edge reports only itself, which is what the main node relays', async () => {
  // The edge answers the same route, and its answer is the envelope the main node picks
  // its own sessions out of. An edge that listed environments too would make the main
  // node's table depend on a registry the edge does not have.
  await withFakeHub({
    keepsRegistry: false,
    online: [ALPHA.id],
    sessions: () => [session('e1', { current: true })],
  }, async ({ origin, hub }) => {
    const { body } = await overview(origin)

    assert.equal(body.ok, true)
    assert.equal(body.partial, false)
    assert.equal(body.nodes.length, 1, 'an edge aggregates nothing: it has no environments')
    const self = node(body, FAKE_SELF)
    assert.equal(self.state, 'ok')
    assert.deepEqual(self.sessions.map((one) => one.id), ['e1'])
    assert.equal(hub.sent.length, 0, 'and asks nobody over a tunnel')
  })
})

test('the state route echoes this node\'s own switcher setting', async () => {
  // The setting is about the person sitting here, not about who may reach this node: it
  // only decides whether a control for leaving is drawn on this node's own pages.
  await withFakeHub({ keepsRegistry: true, environments: [] }, async ({ origin }) => {
    const answer = await fetch(`${origin}/admin/state`)
    const body = await answer.json()
    assert.equal(body.switcher, 'auto', 'the default is to show it when there is somewhere to go')
    assert.equal(body.manages, true)
  })
})
