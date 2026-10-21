/**
 * The authentication layer's clock seam.
 *
 * A caller that injects a clock must be able to see that clock in the sessions
 * the layer hands out. The assertions here are about observable behaviour — the
 * timestamp a session carries and the moment it stops being accepted — so they
 * survive a refactor of how the value is threaded through the code.
 */

import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PAIRING_CREDENTIAL_FILE } from '../lib/auth/pairing-credential.js'
import { createAuth } from '../lib/auth/session.js'

/** A fixed instant in the past, so the system clock can never be mistaken for it. */
const FIXED_NOW = 1_600_000_000_000

/** The credential the seeded record stands for. */
const CREDENTIAL = 'pairing credential 8d1f'

/** A cheap work factor, so writing a record per test stays fast. */
const CHEAP = Object.freeze({ N: 1024, r: 8, p: 1, keylen: 32 })

/**
 * Answer every request with the authentication layer.
 *
 * The layer is exercised over a real socket rather than through hand-built
 * request objects: the session cookie it sets is the thing a browser carries,
 * so that is the thing worth asserting on.
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
  return { id: value.slice(0, at), issuedAt: Number(value.slice(at + 1)) }
}

/** What the layer says about the session the cookie stands for. */
async function authState(origin, value) {
  const response = await fetch(`${origin}/api/auth.state`, {
    headers: { cookie: `dsh_daemon_session=${value}` },
  })
  assert.equal(response.status, 200)
  return response.json()
}

/** A temporary store directory; the production path is never touched. */
async function temporaryDirectory() {
  return await mkdtemp(join(tmpdir(), 'dsh-gateway-clock-'))
}

/**
 * Seed the auth directory with the record for {@link CREDENTIAL}.
 *
 * The credential comes from the file alone, so every test that signs in has to
 * write one; the record carries its own cheap scrypt parameters.
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

// --- the injected clock ------------------------------------------------------

test('a session carries the timestamp of the injected clock', async () => {
  // The clock is what makes "when does this session expire" a question a test can
  // answer. If it never reaches the store, every deadline falls back to the wall
  // clock and the test has to sleep instead.
  const directory = await temporaryDirectory()
  await writeCredential(directory)
  const auth = createAuth({
    directory,
    sessionMaxAgeSeconds: 3600,
    sessionIdleSeconds: 60,
    now: () => FIXED_NOW,
  })
  const { server, origin } = await startAuthServer(auth)
  try {
    const { issuedAt } = sessionValue(await login(origin, CREDENTIAL))
    assert.equal(issuedAt, FIXED_NOW, 'the session is stamped with the injected clock')
    assert.ok(
      Math.abs(Date.now() - issuedAt) > 60_000,
      `the system clock did not stamp the session (system time is ${Date.now()})`,
    )
  } finally {
    await stopAuthServer(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a session stops being accepted once the injected clock passes its idle timeout', async () => {
  // The deadline is what the clock drives, not just the stamp on the record: a
  // session that outlives its idle timeout is refused even though the wall clock
  // has barely moved.
  const directory = await temporaryDirectory()
  await writeCredential(directory)
  let now = FIXED_NOW
  const auth = createAuth({
    directory,
    sessionMaxAgeSeconds: 3600,
    sessionIdleSeconds: 60,
    now: () => now,
  })
  const { server, origin } = await startAuthServer(auth)
  try {
    const value = sessionValue(await login(origin, CREDENTIAL))
    const fresh = await authState(origin, `${value.id}.${value.issuedAt}`)
    assert.equal(fresh.authenticated, true, 'the fresh session is accepted')

    now = FIXED_NOW + 120_000
    const stale = await authState(origin, `${value.id}.${value.issuedAt}`)
    assert.equal(stale.authenticated, false, 'the expired session is refused')
  } finally {
    await stopAuthServer(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('without an injected clock a session is stamped with the system time', async () => {
  // The default has to stay what it always was: a deployment that says nothing
  // about time gets the wall clock.
  const directory = await temporaryDirectory()
  await writeCredential(directory)
  const auth = createAuth({ directory })
  const { server, origin } = await startAuthServer(auth)
  try {
    const before = Date.now()
    const { issuedAt } = sessionValue(await login(origin, CREDENTIAL))
    const after = Date.now()
    assert.ok(
      issuedAt >= before && issuedAt <= after,
      `expected a system timestamp between ${before} and ${after}, got ${issuedAt}`,
    )
  } finally {
    await stopAuthServer(server)
    await rm(directory, { recursive: true, force: true })
  }
})
