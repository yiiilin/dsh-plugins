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
import { randomBytes, scryptSync } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PAIRING_CREDENTIAL_FILE } from '../lib/auth/pairing-credential.js'
import { createAuth } from '../lib/auth/session.js'
import { SessionStore } from '../lib/auth/session-store.js'

/** A fixed instant in the past, so the system clock can never be mistaken for it. */
const FIXED_NOW = 1_600_000_000_000

/** The credential the seeded record stands for. */
const CREDENTIAL = 'pairing credential 2e6b'

/** A cheap work factor, so writing a record per test stays fast. */
const CHEAP = Object.freeze({ N: 1024, r: 8, p: 1, keylen: 32 })

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

/**
 * Seed the auth directory with the record for {@link CREDENTIAL}.
 *
 * The credential layer reads the file and nothing else, so a test that signs in
 * has to write one; the record carries its own cheap scrypt parameters.
 */
async function writeCredential(directory) {
  const salt = randomBytes(16)
  const hash = scryptSync(CREDENTIAL, salt, CHEAP.keylen, { ...CHEAP, maxmem: 64 * 1024 * 1024 })
  await writeFile(join(directory, PAIRING_CREDENTIAL_FILE), `${JSON.stringify({
    version: 1,
    credential: {
      kdf: 'scrypt',
      salt: salt.toString('base64url'),
      hash: hash.toString('base64url'),
      ...CHEAP,
      createdAt: FIXED_NOW,
    },
  })}\n`, { mode: 0o600 })
}

/** A store rooted in a temporary directory and reading the test's clock. */
function openStore(directory, clock, options = {}) {
  return new SessionStore({ directory, now: clock.now, ...options })
}

/** Path of the store's file inside a store directory. */
function sessionFilePath(directory) {
  return join(directory, 'sessions.json')
}

/**
 * Rewrite the store's file into the shape the retired credential model left behind.
 *
 * The old model wrote no authentication epoch on the file and stamped every record
 * with epoch 0. Simulating the upgrade at the file — the durable artefact — rather
 * than through a private seam is what makes "the old sessions are gone after a
 * restart" a claim about a real deployment.
 */
async function downgradeToPreviousModel(directory) {
  const parsed = JSON.parse(await readFile(sessionFilePath(directory), 'utf8'))
  delete parsed.epoch
  parsed.sessions = parsed.sessions.map((record) => ({ ...record, authEpoch: 0 }))
  await writeFile(sessionFilePath(directory), `${JSON.stringify(parsed)}\n`, { mode: 0o600 })
}

/** Read the store's file as a plain object. */
async function readSessionFile(directory) {
  return JSON.parse(await readFile(sessionFilePath(directory), 'utf8'))
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

// --- the store: a changed credential model -----------------------------------

test('sessions minted under the previous credential model are revoked by the restart', async () => {
  // A session says "this browser may come back without presenting the credential",
  // so it is only worth something while that credential is the one in force. The
  // model changed; a cookie minted under the old one must not survive the upgrade,
  // and it must not come back when the file is reloaded.
  const directory = await temporaryDirectory()
  try {
    const clock = manualClock()
    const options = { maxAgeSeconds: 3600, idleTimeoutSeconds: 60 }
    const before = openStore(directory, clock, options)
    const old = before.create({ username: 'admin' })
    assert.notEqual(before.touch(old.id, old.issuedAt), null, 'the session works under the model that minted it')

    await downgradeToPreviousModel(directory)

    const after = openStore(directory, clock, options)
    assert.equal(after.touch(old.id, old.issuedAt), null, 'the old cookie is refused after the restart')
    assert.deepEqual(after.list(), [], 'and nothing from the old model is listed')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the revocation is recorded, so a later restart does not sign everyone out again', async () => {
  // The trap: a marker that lives only in memory would revoke every session on
  // every start, and nobody would ever stay logged in. The revocation itself has to
  // be durable — the file it rewrites says which model the remaining records belong
  // to, and a session minted after the upgrade must survive the next restart.
  const directory = await temporaryDirectory()
  try {
    const clock = manualClock()
    const options = { maxAgeSeconds: 3600, idleTimeoutSeconds: 60 }
    const before = openStore(directory, clock, options)
    before.create({})
    await downgradeToPreviousModel(directory)

    const upgraded = openStore(directory, clock, options)
    assert.deepEqual(upgraded.list(), [], 'the old model left nothing behind')
    const fresh = upgraded.create({})

    const restarted = openStore(directory, clock, options)
    assert.notEqual(
      restarted.touch(fresh.id, fresh.issuedAt),
      null,
      'a session minted after the upgrade survives the restart: the marker moved with the revocation',
    )
    assert.deepEqual(restarted.list().map((session) => session.id), [fresh.id])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a record carrying an older epoch is refused even inside a current store file', async () => {
  // The file-level marker is what handles an upgrade at rest; the record-level one
  // is what refuses a stale cookie on the request that presents it, without waiting
  // for a restart. Both are needed: a file whose marker is current can still hold a
  // record that was written under the old model.
  const directory = await temporaryDirectory()
  try {
    const clock = manualClock()
    const options = { maxAgeSeconds: 3600, idleTimeoutSeconds: 60 }
    const store = openStore(directory, clock, options)
    const record = store.create({})

    const parsed = await readSessionFile(directory)
    parsed.sessions = parsed.sessions.map((one) => ({ ...one, authEpoch: 0 }))
    await writeFile(sessionFilePath(directory), `${JSON.stringify(parsed)}\n`, { mode: 0o600 })

    const restarted = openStore(directory, clock, options)
    assert.equal(restarted.touch(record.id, record.issuedAt), null, 'the stale record is not accepted')
    assert.deepEqual(restarted.list(), [], 'and it is dropped rather than reported as live')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a file written before epochs existed counts as the previous model', async () => {
  // The realistic upgrade path: the old process wrote `{version, sessions}` with no
  // epoch at all, and the new one has to treat that as "not mine" rather than
  // guessing the records are current.
  const directory = await temporaryDirectory()
  try {
    const clock = manualClock()
    const options = { maxAgeSeconds: 3600, idleTimeoutSeconds: 60 }
    const before = openStore(directory, clock, options)
    const old = before.create({})
    await downgradeToPreviousModel(directory)
    const parsed = await readSessionFile(directory)
    delete parsed.epoch
    await writeFile(sessionFilePath(directory), `${JSON.stringify(parsed)}\n`, { mode: 0o600 })

    const after = openStore(directory, clock, options)
    assert.equal(after.touch(old.id, old.issuedAt), null)
    assert.deepEqual(after.list(), [])
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
async function login(origin, password) {
  const response = await fetch(`${origin}/api/auth.login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
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
  await writeCredential(directory)
  const clock = manualClock()
  const auth = createAuth({
    directory,
    sessionMaxAgeSeconds: 3600,
    sessionIdleSeconds: 60,
    now: clock.now,
  })
  const { server, origin } = await startAuthServer(auth)
  try {
    const cookie = sessionValue(await login(origin, CREDENTIAL))
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
  await writeCredential(directory)
  const clock = manualClock()
  const auth = createAuth({
    directory,
    sessionMaxAgeSeconds: 3600,
    sessionIdleSeconds: 60,
    now: clock.now,
  })
  const { server, origin } = await startAuthServer(auth)
  try {
    const cookie = sessionValue(await login(origin, CREDENTIAL))
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
  await writeCredential(directory)
  const clock = manualClock()
  const auth = createAuth({
    directory,
    sessionMaxAgeSeconds: 3600,
    sessionIdleSeconds: 60,
    now: clock.now,
  })
  const { server, origin } = await startAuthServer(auth)
  try {
    // Signed in, so a real session exists: the refusals below are about the
    // cookie's form, not about the store being empty.
    const cookie = sessionValue(await login(origin, CREDENTIAL))
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

// --- the auth layer: a changed credential model ------------------------------

test('a cookie minted before the credential model changed is refused on the next request', async () => {
  // The upgrade as a browser experiences it: it holds a cookie from the retired
  // model, the daemon restarts on the pairing credential, and the very next request
  // is unauthenticated. Pairing again is the only way back in, which is the point —
  // a session minted under a credential that no longer exists must not keep it in
  // force.
  const directory = await temporaryDirectory()
  await writeCredential(directory)
  const clock = manualClock()
  const options = {
    directory,
    sessionMaxAgeSeconds: 3600,
    sessionIdleSeconds: 60,
    now: clock.now,
  }
  const first = createAuth(options)
  const started = await startAuthServer(first)
  let cookie
  try {
    cookie = sessionValue(await login(started.origin, CREDENTIAL))
    assert.equal((await authState(started.origin, cookie)).authenticated, true, 'the session works before the upgrade')
  } finally {
    await stopAuthServer(started.server)
  }

  try {
    await downgradeToPreviousModel(directory)

    const upgraded = createAuth(options)
    const restarted = await startAuthServer(upgraded)
    try {
      assert.equal((await authState(restarted.origin, cookie)).authenticated, false, 'the old cookie is refused')
      assert.equal((await authState(restarted.origin, cookie)).username, undefined, 'and it names no user')

      const fresh = sessionValue(await login(restarted.origin, CREDENTIAL))
      assert.notEqual(fresh, cookie, 'the browser had to pair again')
      assert.equal((await authState(restarted.origin, fresh)).authenticated, true, 'and the new session is accepted')
    } finally {
      await stopAuthServer(restarted.server)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a wrong issue time is refused without signing the real browser out', async () => {
  // The pair `<id>.<issuedAt>` is the identity, so a cookie whose time has been
  // edited is not this session and must be refused. But refusing it must not be
  // the same act as revoking it: anyone who learns the id could otherwise end
  // the real session by presenting it with a wrong timestamp — a denial of
  // service that needs no credential at all.
  const directory = await temporaryDirectory()
  await writeCredential(directory)
  const clock = manualClock()
  const auth = createAuth({
    directory,
    sessionMaxAgeSeconds: 3600,
    sessionIdleSeconds: 60,
    now: clock.now,
  })
  const { server, origin } = await startAuthServer(auth)
  try {
    const value = sessionValue(await login(origin, CREDENTIAL))
    const id = value.slice(0, value.indexOf('.'))
    const issuedAt = Number(value.slice(value.indexOf('.') + 1))

    // The genuine cookie works to begin with, so the assertion at the end is
    // about survival and not about a session that never existed.
    assert.equal((await authState(origin, `${id}.${issuedAt}`)).authenticated, true, 'the genuine cookie is accepted')

    const tampered = await authState(origin, `${id}.${issuedAt + 1}`)
    assert.equal(tampered.authenticated, false, 'the edited issue time is refused')

    const survivor = await authState(origin, `${id}.${issuedAt}`)
    assert.equal(survivor.authenticated, true, 'the genuine cookie still works after the edited one was refused')
  } finally {
    await stopAuthServer(server)
    await rm(directory, { recursive: true, force: true })
  }
})

// --- the auth layer: the read-only session view ------------------------------

/** Sign in twice, so there are two live sessions with their own clients. */
async function loginTwice(origin) {
  const first = sessionValue(await login(origin, CREDENTIAL))
  const second = sessionValue(await login(origin, CREDENTIAL))
  return { first, second }
}

/** The id half of a `<id>.<issuedAt>` cookie value. */
function idOf(value) {
  return value.slice(0, value.indexOf('.'))
}

test('the session view reports the fields display needs, and which session is asking', async () => {
  // "Who is signed in" is a question about authentication, so the layer answers it.
  // The field set is the display's: an operator reading the table needs to recognise
  // the client, know when it signed in and when it goes away, and see which row is
  // the browser they are looking at.
  const directory = await temporaryDirectory()
  await writeCredential(directory)
  const clock = manualClock()
  const auth = createAuth({
    directory,
    sessionMaxAgeSeconds: 3600,
    sessionIdleSeconds: 60,
    now: clock.now,
  })
  const { server, origin } = await startAuthServer(auth)
  try {
    const { first } = await loginTwice(origin)
    const asking = idOf(first)

    const list = auth.sessions(asking)
    assert.equal(list.length, 2, 'both live sessions are reported')
    const entry = list.find((session) => session.id === asking)
    assert.ok(entry !== undefined, 'the asking session is one of them')

    assert.deepEqual(
      Object.keys(entry).sort(),
      ['address', 'current', 'expiresAt', 'id', 'issuedAt', 'lastSeenAt', 'userAgent'],
      `the view carries exactly the display fields, got ${Object.keys(entry).join(', ')}`,
    )
    assert.equal(entry.issuedAt, FIXED_NOW, 'the issue time comes from the store record')
    assert.equal(entry.lastSeenAt, FIXED_NOW, 'so does the last-seen time')
    assert.equal(entry.expiresAt, FIXED_NOW + 60_000, 'and the expiry the configured bounds earned')
    assert.equal(typeof entry.address, 'string', 'the client address is readable')
    assert.ok(entry.address.length > 0, 'and it is populated')
    assert.equal(typeof entry.userAgent, 'string', 'the client type is readable')
    assert.equal(entry.current, true, 'the asking session is marked as the current one')

    const other = list.find((session) => session.id !== asking)
    assert.equal(other.current, false, 'every other session is not current')
    assert.equal(
      list.filter((session) => session.current).length,
      1,
      'exactly one session is the one that asked',
    )

    // Asking as something that is not a session marks nothing, rather than guessing.
    assert.equal(
      auth.sessions().filter((session) => session.current).length,
      0,
      'an unidentified caller gets no current session',
    )
  } finally {
    await stopAuthServer(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('the session view holds no store-internal fields', async () => {
  // `authEpoch` is the authentication-epoch marker: a storage detail that means
  // nothing on screen. `username` and `secure` belong to the retired multi-user model
  // and the cookie policy. A view that leaked them would tie the display to the
  // record's shape, which is the coupling the projection exists to avoid.
  const directory = await temporaryDirectory()
  await writeCredential(directory)
  const clock = manualClock()
  const auth = createAuth({
    directory,
    sessionMaxAgeSeconds: 3600,
    sessionIdleSeconds: 60,
    now: clock.now,
  })
  const { server, origin } = await startAuthServer(auth)
  try {
    const { first } = await loginTwice(origin)
    for (const session of auth.sessions(idOf(first))) {
      for (const internal of ['authEpoch', 'username', 'secure', 'renewedAt']) {
        assert.equal(
          Object.hasOwn(session, internal),
          false,
          `the view must not expose the internal field "${internal}"`,
        )
      }
    }
  } finally {
    await stopAuthServer(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('an expired session does not appear in the session view', async () => {
  // A vanished session listed with a deadline in the past is indistinguishable from a
  // live one to a reader, and the point of the view is that what it shows is current.
  const directory = await temporaryDirectory()
  await writeCredential(directory)
  const clock = manualClock()
  const auth = createAuth({
    directory,
    sessionMaxAgeSeconds: 0,
    sessionIdleSeconds: 60,
    now: clock.now,
  })
  const { server, origin } = await startAuthServer(auth)
  try {
    const { first } = await loginTwice(origin)
    assert.equal(auth.sessions(idOf(first)).length, 2, 'both are listed while they are live')

    clock.set(FIXED_NOW + 120_000)
    assert.deepEqual(auth.sessions(idOf(first)), [], 'once the idle window passes, neither is reported')
  } finally {
    await stopAuthServer(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a revoked session disappears from the view without touching the others', async () => {
  const directory = await temporaryDirectory()
  await writeCredential(directory)
  const clock = manualClock()
  const auth = createAuth({
    directory,
    sessionMaxAgeSeconds: 3600,
    sessionIdleSeconds: 60,
    now: clock.now,
  })
  const { server, origin } = await startAuthServer(auth)
  try {
    const { first, second } = await loginTwice(origin)
    assert.equal(auth.sessions(idOf(first)).length, 2)

    // Logging out is the only revocation this layer offers, and it is the layer's own
    // endpoint rather than something the view hands out.
    const response = await fetch(`${origin}/api/auth.logout`, {
      method: 'POST',
      headers: { cookie: `dsh_daemon_session=${second}` },
      redirect: 'manual',
    })
    assert.equal(response.status, 303)

    const remaining = auth.sessions(idOf(first))
    assert.deepEqual(remaining.map((session) => session.id), [idOf(first)], 'only the signed-out session is gone')
    assert.equal(remaining[0].current, true, 'and the survivor is still marked as the caller')
  } finally {
    await stopAuthServer(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('the session view is read-only: what it returns cannot change the store', async () => {
  // A view that handed out live records would be a way to edit or revoke one, which is
  // the write path this round deliberately does not have. Mutating what the view
  // returned must therefore be visible nowhere.
  const directory = await temporaryDirectory()
  await writeCredential(directory)
  const clock = manualClock()
  const auth = createAuth({
    directory,
    sessionMaxAgeSeconds: 3600,
    sessionIdleSeconds: 60,
    now: clock.now,
  })
  const { server, origin } = await startAuthServer(auth)
  try {
    const { first } = await loginTwice(origin)
    const asking = idOf(first)
    const before = auth.sessions(asking)

    const view = auth.sessions(asking)
    view[0].expiresAt = FIXED_NOW - 1
    view[0].address = 'tampered'
    view.push({ id: 'invented', current: true })
    view.length = 1

    assert.deepEqual(auth.sessions(asking), before, 'the store is unchanged by anything done to the returned value')
    const record = auth.session(
      { headers: { cookie: `dsh_daemon_session=${first}` }, socket: {} },
      false,
    )
    assert.notEqual(record, undefined, 'the session still works')
    assert.equal(record.address !== 'tampered', true, 'and no field was overwritten through the view')
  } finally {
    await stopAuthServer(server)
    await rm(directory, { recursive: true, force: true })
  }
})
