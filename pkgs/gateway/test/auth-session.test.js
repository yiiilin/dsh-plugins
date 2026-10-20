/**
 * Session identity: the store that holds sessions, and the layer that recognises
 * the cookie standing for one.
 *
 * The store is driven through its own seam — a directory and a clock — because a
 * session's lifetime lives there. The auth layer is exercised over a real socket,
 * because the cookie a browser carries is the thing being recognised. Nothing
 * here reads the source of either layer: every assertion is a result a caller
 * could observe.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAuth } from '../lib/auth/session.js'
import { SessionStore } from '../lib/auth/session-store.js'

/** A fixed instant in the past, so the system clock can never be mistaken for it. */
const FIXED_NOW = 1_600_000_000_000

/**
 * A clock the test moves by hand.
 *
 * Time-dependent behaviour is the whole point of these tests, and waiting for it
 * would make them slow and flaky. The clock is a value, so an expiry is a
 * question with an exact answer.
 */
function manualClock(start = FIXED_NOW) {
  let current = start
  return {
    now: () => current,
    set(value) {
      current = value
    },
  }
}

/** A temporary store directory; the production path is never touched. */
async function temporaryDirectory() {
  return await mkdtemp(join(tmpdir(), 'dsh-gateway-session-'))
}

/** A store rooted in a temporary directory and reading the test's clock. */
function openStore(directory, clock, options = {}) {
  return new SessionStore({ directory, now: clock.now, ...options })
}

// --- the store: creating a session -------------------------------------------

test('a created session is recognised by its id and issue time', async () => {
  // The pair `<id>.<issuedAt>` is what the browser sends back, and the store
  // refuses any pair it did not issue: that is what stops a stale cookie from
  // reviving a replaced session.
  const directory = await temporaryDirectory()
  try {
    const clock = manualClock()
    const store = openStore(directory, clock, { maxAgeSeconds: 3600, idleTimeoutSeconds: 60 })
    const record = store.create({ username: 'admin', address: '10.0.0.1', userAgent: 'session-test' })

    assert.equal(record.issuedAt, FIXED_NOW, 'the session is stamped with the store clock')
    assert.equal(record.lastSeenAt, FIXED_NOW)
    assert.equal(record.expiresAt, FIXED_NOW + 60_000, 'the earliest configured bound wins')
    assert.equal(record.username, 'admin')
    assert.equal(record.address, '10.0.0.1')
    assert.equal(record.userAgent, 'session-test')

    assert.notEqual(store.touch(record.id, record.issuedAt), null, 'the pair the store issued is accepted')
    assert.equal(store.touch(record.id, record.issuedAt + 1), null, 'the same id with another issue time is not')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('two sessions created for the same user are separate sessions', async () => {
  const directory = await temporaryDirectory()
  try {
    const store = openStore(directory, manualClock(), { maxAgeSeconds: 3600, idleTimeoutSeconds: 60 })
    const first = store.create({ username: 'admin' })
    const second = store.create({ username: 'admin' })

    assert.notEqual(first.id, second.id, 'each session gets its own identity')
    assert.equal(store.list().length, 2, 'both are listed')
    store.revoke(first.id)
    assert.notEqual(store.touch(second.id, second.issuedAt), null, 'revoking one leaves the other alone')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// --- the store: expiry -------------------------------------------------------

test('a session is refused once its absolute lifetime is spent, however recently it was used', async () => {
  // The absolute ceiling is a ceiling: activity slides the idle window but can
  // never buy time past it.
  const directory = await temporaryDirectory()
  try {
    const clock = manualClock()
    const store = openStore(directory, clock, { maxAgeSeconds: 60, idleTimeoutSeconds: 3600 })
    const record = store.create({})

    clock.set(FIXED_NOW + 50_000)
    assert.notEqual(store.touch(record.id, record.issuedAt), null, 'still inside the absolute lifetime')
    clock.set(FIXED_NOW + 59_999)
    assert.notEqual(store.touch(record.id, record.issuedAt), null, 'one millisecond before the deadline')
    clock.set(FIXED_NOW + 60_000)
    assert.equal(store.touch(record.id, record.issuedAt), null, 'the deadline itself is already past')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an idle session expires, and a request inside the window extends it', async () => {
  const directory = await temporaryDirectory()
  try {
    const clock = manualClock()
    const store = openStore(directory, clock, { maxAgeSeconds: 0, idleTimeoutSeconds: 60 })
    const record = store.create({})

    clock.set(FIXED_NOW + 50_000)
    assert.notEqual(store.touch(record.id, record.issuedAt), null, 'the first idle window is still open')
    clock.set(FIXED_NOW + 100_000)
    assert.notEqual(
      store.touch(record.id, record.issuedAt),
      null,
      'the window slid with the last request, so 100s after issue is still inside it',
    )
    clock.set(FIXED_NOW + 160_001)
    assert.equal(store.touch(record.id, record.issuedAt), null, 'more than the idle window after the last request')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a session past its idle timeout is expired even while its absolute deadline is still ahead', async () => {
  // The two bounds are independent: the earlier one decides. A session idle for
  // two minutes is gone even though its hour of absolute lifetime has not run.
  const directory = await temporaryDirectory()
  try {
    const clock = manualClock()
    const store = openStore(directory, clock, { maxAgeSeconds: 3600, idleTimeoutSeconds: 60 })
    const record = store.create({})

    assert.equal(record.expiresAt, FIXED_NOW + 60_000, 'the idle bound is the earlier of the two')
    clock.set(FIXED_NOW + 120_000)
    assert.equal(store.touch(record.id, record.issuedAt), null, 'refused although the hour is not up')
    assert.deepEqual(store.list(), [], 'and the store no longer reports it')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('pruning drops expired sessions and keeps live ones', async () => {
  const directory = await temporaryDirectory()
  try {
    const clock = manualClock()
    const store = openStore(directory, clock, { maxAgeSeconds: 0, idleTimeoutSeconds: 60 })
    const stale = store.create({})
    clock.set(FIXED_NOW + 30_000)
    const live = store.create({})

    clock.set(FIXED_NOW + 60_000)
    assert.equal(store.prune(), true, 'something expired and the removal was reported')
    assert.deepEqual(
      store.list().map((session) => session.id),
      [live.id],
      `only the live session is left (stale ${stale.id} should be gone)`,
    )
    assert.equal(store.prune(), false, 'a second prune has nothing left to remove')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// --- the store: the browser cookie -------------------------------------------

test('the browser cookie is re-issued before the session it stands for would expire', async () => {
  // A cookie outliving its session is a bearer value the server has stopped
  // honouring; one expiring before its session makes the user sign in again for
  // no reason. The store owns both the advertised lifetime and the moment to
  // re-issue.
  const directory = await temporaryDirectory()
  try {
    const clock = manualClock()
    const store = openStore(directory, clock, { maxAgeSeconds: 0, idleTimeoutSeconds: 60 })
    const record = store.create({})

    assert.equal(store.cookieLifetimeSeconds(record), 60, 'the idle window, in seconds')
    assert.equal(store.cookieRenewalDue(record), false, 'a freshly issued cookie is not re-issued at once')

    clock.set(FIXED_NOW + 30_000)
    assert.equal(store.cookieRenewalDue(record), true, 'half the lifetime has passed, so renewal is due')

    store.markCookieRenewed(record)
    assert.equal(store.cookieRenewalDue(record), false, 'a re-issued cookie starts its own window')
    clock.set(FIXED_NOW + 35_000)
    assert.equal(store.cookieRenewalDue(record), false, 'five seconds into the new window is too early')
    assert.equal(store.cookieLifetimeSeconds(record), 25, 'the new lifetime is what is left of the session')

    clock.set(FIXED_NOW + 60_000)
    assert.equal(store.cookieLifetimeSeconds(record), 0, 'an expired session advertises no lifetime')
    assert.equal(store.cookieRenewalDue(record), false, 'and there is nothing left to renew')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an advertised cookie lifetime never reaches past the absolute deadline', async () => {
  const directory = await temporaryDirectory()
  try {
    const clock = manualClock()
    const store = openStore(directory, clock, { maxAgeSeconds: 60, idleTimeoutSeconds: 3600 })
    const record = store.create({})

    clock.set(FIXED_NOW + 50_000)
    assert.equal(
      store.cookieLifetimeSeconds(record),
      10,
      'ten seconds of absolute lifetime remain, so the cookie gets ten, not the hour of idle window',
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// --- the store: revocation ---------------------------------------------------

test('a revoked session is refused at once', async () => {
  const directory = await temporaryDirectory()
  try {
    const clock = manualClock()
    const store = openStore(directory, clock, { maxAgeSeconds: 3600, idleTimeoutSeconds: 60 })
    const record = store.create({})

    assert.equal(store.revoke(record.id), true, 'the session existed and was revoked')
    assert.equal(store.touch(record.id, record.issuedAt), null, 'the cookie no longer stands for anything')
    assert.deepEqual(store.list(), [], 'and it is no longer listed')
    assert.equal(store.revoke(record.id), false, 'revoking it again reports nothing left to revoke')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('revoking every session clears the store for good', async () => {
  // Clearing the store is the mechanism that invalidates every browser at once,
  // and it has to survive a restart: the records must not come back with the
  // process.
  const directory = await temporaryDirectory()
  try {
    const clock = manualClock()
    const store = openStore(directory, clock, { maxAgeSeconds: 3600, idleTimeoutSeconds: 60 })
    const first = store.create({})
    const second = store.create({})

    assert.equal(store.revokeAll(), true, 'the clearing was written to disk')
    assert.deepEqual(store.list(), [])

    const restarted = openStore(directory, clock, { maxAgeSeconds: 3600, idleTimeoutSeconds: 60 })
    assert.deepEqual(restarted.list(), [], 'a restart does not resurrect them')
    assert.equal(restarted.touch(first.id, first.issuedAt), null)
    assert.equal(restarted.touch(second.id, second.issuedAt), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// --- the store: persistence --------------------------------------------------

test('a session survives a restart and is still accepted afterwards', async () => {
  // A gateway restart must not sign every browser out: the record is on disk, and
  // a new store over the same directory reads it back.
  const directory = await temporaryDirectory()
  try {
    const clock = manualClock()
    const store = openStore(directory, clock, { maxAgeSeconds: 3600, idleTimeoutSeconds: 60 })
    const record = store.create({ username: 'admin', address: '10.0.0.1', userAgent: 'restart-test' })

    const restarted = openStore(directory, clock, { maxAgeSeconds: 3600, idleTimeoutSeconds: 60 })
    const [restored] = restarted.list(record.id)
    assert.ok(restored !== undefined, 'the session was read back from disk')
    assert.equal(restored.id, record.id)
    assert.equal(restored.username, 'admin')
    assert.equal(restored.issuedAt, FIXED_NOW)
    assert.equal(restored.lastSeenAt, FIXED_NOW)
    assert.equal(restored.expiresAt, FIXED_NOW + 60_000)
    assert.equal(restored.address, '10.0.0.1')
    assert.equal(restored.userAgent, 'restart-test')
    assert.equal(restored.current, true, 'the listed session is the one the caller asked about')

    assert.notEqual(restarted.touch(record.id, record.issuedAt), null, 'and the cookie is accepted after the restart')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a session that expired while the gateway was down is not revived by the restart', async () => {
  const directory = await temporaryDirectory()
  try {
    const clock = manualClock()
    const store = openStore(directory, clock, { maxAgeSeconds: 3600, idleTimeoutSeconds: 60 })
    const record = store.create({})

    clock.set(FIXED_NOW + 120_000)
    const restarted = openStore(directory, clock, { maxAgeSeconds: 3600, idleTimeoutSeconds: 60 })
    assert.deepEqual(restarted.list(), [], 'the expired record is not listed')
    assert.equal(restarted.touch(record.id, record.issuedAt), null, 'and the cookie is refused')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// --- the auth layer: recognising the cookie ----------------------------------

/**
 * Answer every request with the authentication layer.
 *
 * The layer is exercised over a real socket rather than through hand-built
 * request objects: the session cookie it sets is the thing a browser carries, so
 * that is the thing worth asserting on.
 */
async function startAuthServer(auth) {
  const server = createServer((req, res) => {
    void auth.handle(req, res, req.url ?? '/', false).then((handled) => {
      if (handled !== true) {
        res.writeHead(404)
        res.end()
      }
    }).catch(() => {
      res.writeHead(500)
      res.end()
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

/** Stop the server, dropping the sockets a keep-alive client still holds open. */
async function stopAuthServer(server) {
  await new Promise((done) => {
    server.close(done)
    server.closeAllConnections()
  })
}

/** Sign in and return the response, which carries the session cookie. */
async function login(origin, username, password) {
  const response = await fetch(`${origin}/api/auth.login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  assert.equal(response.status, 200, 'the credentials were accepted')
  return response
}

/** The `<id>.<issuedAt>` pair the browser carries in its session cookie. */
function sessionValue(response) {
  const cookies = response.headers.getSetCookie()
  const session = cookies.find((entry) => entry.startsWith('dsh_daemon_session='))
  assert.ok(session !== undefined, `expected a session cookie, got ${JSON.stringify(cookies)}`)
  const value = session.slice('dsh_daemon_session='.length).split(';')[0]
  const at = value.indexOf('.')
  assert.notEqual(at, -1, `expected "<id>.<issuedAt>", got ${value}`)
  return `${value.slice(0, at)}.${value.slice(at + 1)}`
}

/**
 * What the layer says about the session a cookie stands for.
 *
 * Omitting the value sends no cookie header at all, which is what a browser that
 * has never signed in sends.
 */
async function authState(origin, cookieValue) {
  const response = await fetch(`${origin}/api/auth.state`, {
    headers: cookieValue === undefined ? {} : { cookie: `dsh_daemon_session=${cookieValue}` },
  })
  assert.equal(response.status, 200)
  return response.json()
}

test('a request carrying a valid session cookie is accepted', async () => {
  const directory = await temporaryDirectory()
  const clock = manualClock()
  const auth = createAuth({
    directory,
    username: 'admin',
    password: 'secret',
    sessionMaxAgeSeconds: 3600,
    sessionIdleSeconds: 60,
    now: clock.now,
  })
  const { server, origin } = await startAuthServer(auth)
  try {
    const cookie = sessionValue(await login(origin, 'admin', 'secret'))
    const state = await authState(origin, cookie)
    assert.equal(state.ok, true)
    assert.equal(state.authenticated, true, 'the cookie the layer issued is recognised')
    assert.equal(state.username, 'admin')
  } finally {
    await stopAuthServer(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a request carrying an invalid session cookie is refused', async () => {
  const directory = await temporaryDirectory()
  const clock = manualClock()
  const auth = createAuth({
    directory,
    username: 'admin',
    password: 'secret',
    sessionMaxAgeSeconds: 3600,
    sessionIdleSeconds: 60,
    now: clock.now,
  })
  const { server, origin } = await startAuthServer(auth)
  try {
    const cookie = sessionValue(await login(origin, 'admin', 'secret'))
    const at = cookie.indexOf('.')
    const id = cookie.slice(0, at)
    const issuedAt = Number(cookie.slice(at + 1))

    // Well-formed but never issued: the same shape the layer hands out, so the
    // refusal cannot be the parser's doing.
    const unknown = await authState(origin, `${'A'.repeat(id.length)}.${issuedAt}`)
    assert.equal(unknown.authenticated, false, 'a session id the store never issued is refused')

    // A real id paired with the wrong issue time: the pair, not the id, is the
    // identity, so a cookie whose time has been edited is not this session.
    const tampered = await authState(origin, `${id}.${issuedAt + 1}`)
    assert.equal(tampered.authenticated, false, 'a rewritten issue time is refused')
    assert.equal(tampered.username, undefined, 'and it names no user')
  } finally {
    await stopAuthServer(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a request carrying a malformed session cookie is refused', async () => {
  const directory = await temporaryDirectory()
  const clock = manualClock()
  const auth = createAuth({
    directory,
    username: 'admin',
    password: 'secret',
    sessionMaxAgeSeconds: 3600,
    sessionIdleSeconds: 60,
    now: clock.now,
  })
  const { server, origin } = await startAuthServer(auth)
  try {
    // Signed in, so a real session exists: the refusals below are about the
    // cookie's form, not about the store being empty.
    const cookie = sessionValue(await login(origin, 'admin', 'secret'))
    const id = cookie.slice(0, cookie.indexOf('.'))

    const absent = await authState(origin, undefined)
    assert.equal(absent.authenticated, false, 'a request with no cookie at all is refused')

    for (const value of ['', 'not-a-session', 'no-issue-time.', '.1600000000000', 'id.not-a-number', `${id}.garbage`]) {
      const state = await authState(origin, value)
      assert.equal(state.authenticated, false, `a cookie of "${value}" is refused`)
    }

    // Refusing a junk cookie must not be the same act as revoking the session it
    // names: otherwise anyone who can send a request could log the user out by
    // presenting their id with a broken issue time.
    const stillValid = await authState(origin, cookie)
    assert.equal(stillValid.authenticated, true, 'the junk cookies left the real session alone')
  } finally {
    await stopAuthServer(server)
    await rm(directory, { recursive: true, force: true })
  }
})
