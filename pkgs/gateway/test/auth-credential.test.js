/**
 * The pairing credential: one password, hashed at rest, exchanged for a session.
 *
 * Everything here is observed from outside the module — the bytes of the file it
 * writes, the permissions those bytes carry, the answer a real login request gets
 * over a socket, and the time a refusal takes. Nothing asserts the shape of the
 * source: a refactor that keeps the behaviour must keep these tests green.
 *
 * The production work factor is deliberately expensive, so most tests write a
 * cheap record straight into the file: the scrypt parameters travel with the
 * record, which is also what the "an old file keeps working" test relies on.
 */

import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { PAIRING_CREDENTIAL_FILE, PairingCredential } from '../lib/auth/pairing-credential.js'
import { createAuth } from '../lib/auth/session.js'
import { createTunnelHub } from '../lib/federation/hub.js'

/** A password distinctive enough that its absence from the file means something. */
const CREDENTIAL = 'correct horse battery staple 9f3a'

/** A cheap work factor: fast enough for tests, and far below the production default. */
const CHEAP = Object.freeze({ N: 1024, r: 8, p: 1, keylen: 32 })

/** A temporary auth directory; the production path is never touched. */
async function temporaryDirectory() {
  return await mkdtemp(join(tmpdir(), 'dsh-gateway-pairing-'))
}

/** The credential file's path inside a store directory. */
function credentialPath(directory) {
  return join(directory, PAIRING_CREDENTIAL_FILE)
}

/**
 * The on-disk record for one credential, written by the test rather than the module.
 *
 * It is the documented format, and a test may choose the parameters because a
 * stored record carries them.
 */
function credentialRecord(credential, { N, r, p, keylen } = CHEAP) {
  const salt = randomBytes(16)
  const hash = scryptSync(credential, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 })
  return {
    version: 1,
    credential: {
      kdf: 'scrypt',
      salt: salt.toString('base64url'),
      hash: hash.toString('base64url'),
      N,
      r,
      p,
      keylen,
      createdAt: 1_600_000_000_000,
    },
  }
}

/** Seed a directory with the record for `credential`, so a test need not hash. */
async function writeCredential(directory, credential, parameters) {
  await writeFile(credentialPath(directory), `${JSON.stringify(credentialRecord(credential, parameters))}\n`, { mode: 0o600 })
}

/**
 * A temporary DSH home and the context `apply` needs, so the plugin can be mounted.
 *
 * Mounting is where a credential file's fate is decided — it is read (or written)
 * inside `apply`, before the listener exists — so a test about startup has to mount
 * rather than construct one store by hand.
 */
async function temporaryHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-gateway-home-'))
  return { home, authDirectory: join(home, 'daemon', 'auth') }
}

/** Mount the plugin against a temporary home with `config` overrides. */
function mount(home, config = {}) {
  const ctx = {
    // Returning a value rather than undefined keeps the daemon's own logger shim
    // from echoing startup lines into the test output; nothing asserts on it.
    logger: { info: () => true, warn: () => true },
    get: () => undefined,
    effect: () => () => {},
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
    role: 'main',
    profile: '',
    password: '',
    ...config,
  })
}

/** Run `body` with `DSH_AUTH_PASS`/`AUTH_PASS` set, restoring both afterwards. */
async function withEnvironmentPassword(value, body) {
  const saved = { DSH_AUTH_PASS: process.env.DSH_AUTH_PASS, AUTH_PASS: process.env.AUTH_PASS }
  process.env.DSH_AUTH_PASS = value
  delete process.env.AUTH_PASS
  try {
    return await body()
  } finally {
    for (const [name, previous] of Object.entries(saved)) {
      if (previous === undefined) delete process.env[name]
      else process.env[name] = previous
    }
  }
}

/**
 * Answer every request with the authentication layer.
 *
 * A real socket, because the cookie is the artefact a browser carries and the one
 * worth asserting on.
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

/** Post a login attempt and return the raw response. */
async function attemptLogin(origin, body, headers = {}) {
  return await fetch(`${origin}/api/auth.login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** The session cookie values a response set. */
function cookies(response) {
  return response.headers.getSetCookie()
}

/** What the layer says about the session a cookie stands for. */
async function authState(origin, cookieValue) {
  const response = await fetch(`${origin}/api/auth.state`, {
    headers: cookieValue === undefined ? {} : { cookie: `dsh_daemon_session=${cookieValue}` },
  })
  assert.equal(response.status, 200)
  return response.json()
}

// --- writing the credential --------------------------------------------------

test('the first start hashes the configured password into pairing.json', async () => {
  // The ticket's central promise: the credential itself never lands on disk. The
  // only witness of the password is a scrypt hash with its own salt.
  const directory = await temporaryDirectory()
  try {
    new PairingCredential({ directory, password: CREDENTIAL })

    const text = await readFile(credentialPath(directory), 'utf8')
    assert.equal(text.includes(CREDENTIAL), false, 'the plaintext credential is not in the file')

    const parsed = JSON.parse(text)
    assert.equal(parsed.version, 1, 'the file is versioned, like the other stores')
    assert.equal(parsed.credential.kdf, 'scrypt')
    assert.equal(typeof parsed.credential.salt, 'string')
    assert.equal(typeof parsed.credential.hash, 'string')
    assert.equal(parsed.password, undefined, 'no member of the record carries a password')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the credential file is 0600 and its directory is 0700', async () => {
  // A hash is still a credential: another account on the machine must not be able
  // to read it, copy it, and grind it offline.
  const directory = await temporaryDirectory()
  try {
    new PairingCredential({ directory, password: CREDENTIAL })
    const file = await stat(credentialPath(directory))
    const root = await stat(directory)
    assert.equal(file.mode & 0o777, 0o600, 'the credential file is owner-only')
    assert.equal(root.mode & 0o777, 0o700, 'the auth directory is owner-only')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a restart reads the credential from the file and needs no configured password', async () => {
  // Bootstrap once, then read the file only: the environment variable is not a
  // live credential any more, which is what lets the operator unset it.
  const directory = await temporaryDirectory()
  try {
    new PairingCredential({ directory, password: CREDENTIAL })
    const restarted = new PairingCredential({ directory })
    assert.equal(await restarted.verify(CREDENTIAL), true, 'the file alone authenticates the credential')
    assert.equal(await restarted.verify('not the credential'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('once the file exists, the configured password is only a seed and not a second credential', async () => {
  // A seed that kept working would be a live fallback: changing the launch
  // environment would silently change who can log in, while the file said otherwise.
  const directory = await temporaryDirectory()
  try {
    new PairingCredential({ directory, password: CREDENTIAL })
    const seededAgain = new PairingCredential({ directory, password: 'a different configured password' })
    assert.equal(await seededAgain.verify(CREDENTIAL), true, 'the file still names the original credential')
    assert.equal(await seededAgain.verify('a different configured password'), false, 'the seed did not replace it')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('verification uses the parameters stored in the file, not the defaults in the code', async () => {
  // An old record must keep working after the defaults change. This record's
  // r/p/keylen all differ from the production defaults, so a verifier that used
  // those defaults could not reproduce its hash.
  const directory = await temporaryDirectory()
  try {
    await writeCredential(directory, CREDENTIAL, { N: 1024, r: 4, p: 2, keylen: 32 })
    const store = new PairingCredential({ directory })
    assert.equal(await store.verify(CREDENTIAL), true, 'the record authenticates with its own parameters')
    assert.equal(await store.verify('not the credential'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a file found with looser permissions is tightened on load', async () => {
  // The other stores do this too: a file that was copied in or restored from a
  // backup arrives readable, and the next start has to fix it rather than trust it.
  const directory = await temporaryDirectory()
  try {
    await writeCredential(directory, CREDENTIAL)
    await chmod(credentialPath(directory), 0o644)
    await chmod(directory, 0o755)

    new PairingCredential({ directory })

    assert.equal((await stat(credentialPath(directory))).mode & 0o777, 0o600)
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// --- startup failures --------------------------------------------------------

test('a corrupt credential file stops the startup and names the path', async () => {
  // Failing at mount time is the point: a gateway that starts with an unusable
  // credential serves a login page nobody can pass, and the operator finds out
  // from a browser instead of from the log.
  const directory = await temporaryDirectory()
  try {
    const path = credentialPath(directory)
    const broken = [
      ['not json at all', 'not json at all\n'],
      ['another version', `${JSON.stringify({ version: 99, credential: {} })}\n`],
      ['no scrypt record', `${JSON.stringify({ version: 1 })}\n`],
      ['a record scrypt cannot run', `${JSON.stringify({ version: 1, credential: { kdf: 'scrypt', salt: 'AAAA', hash: 'AAAA', N: 1, r: 8, p: 1, keylen: 32 } })}\n`],
      ['a hash that is not the stored length', `${JSON.stringify({
        version: 1,
        credential: { kdf: 'scrypt', salt: 'AAAAAAAAAAAAAAAAAAAAAA', hash: 'AAAA', N: 1024, r: 8, p: 1, keylen: 32 },
      })}\n`],
    ]
    for (const [description, text] of broken) {
      await writeFile(path, text, { mode: 0o600 })
      assert.throws(
        () => new PairingCredential({ directory }),
        (error) => error instanceof Error && error.message.includes(path),
        `${description} must fail the startup and name ${path}`,
      )
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a missing file with no configured password stops the startup and names the path', async () => {
  // Neither a credential nor a seed: there is no honest way to serve a login page,
  // and inventing one would silently lock the operator out.
  const directory = await temporaryDirectory()
  try {
    const path = credentialPath(directory)
    assert.throws(
      () => new PairingCredential({ directory }),
      (error) => error instanceof Error && error.message.includes(path),
      `the error must name the missing path ${path}`,
    )
    assert.equal(await readFile(path, 'utf8').catch(() => undefined), undefined, 'nothing was invented')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// --- mounting the plugin (the startup path) ---------------------------------

test('mounting with DSH_AUTH_PASS hashes it once; a later mount needs no environment at all', async () => {
  // The environment variable seeds the file on the first start and then stops
  // mattering. That is the whole reason it can be removed from `$DSH_HOME/.env`
  // afterwards: a plaintext left there would contradict "the credential never
  // lands on disk".
  const { home, authDirectory } = await temporaryHome()
  try {
    await withEnvironmentPassword(CREDENTIAL, async () => {
      mount(home)
    })
    const file = credentialPath(authDirectory)
    const text = await readFile(file, 'utf8')
    assert.equal(text.includes(CREDENTIAL), false, 'the environment value went in hashed, not verbatim')
    assert.equal((await stat(file)).mode & 0o777, 0o600)

    // Second start: no config password, no environment variable, only the file.
    delete process.env.DSH_AUTH_PASS
    assert.doesNotThrow(() => mount(home), 'the file alone is enough to mount')
    assert.equal(await new PairingCredential({ directory: authDirectory }).verify(CREDENTIAL), true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('mounting refuses a corrupt credential file instead of waiting for the first request', async () => {
  // The mount is the only place the operator finds out before a browser does. The
  // probe here is `apply` itself, so this also covers the seam the entry router
  // depends on: an exception there is a plugin that fails to mount.
  const { home, authDirectory } = await temporaryHome()
  try {
    await mkdir(authDirectory, { recursive: true })
    await writeFile(credentialPath(authDirectory), '{"version":1,"credential":{}}\n', { mode: 0o600 })
    assert.throws(
      () => mount(home),
      (error) => error instanceof Error && error.message.includes(credentialPath(authDirectory)),
      'the mount fails and names the file',
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// --- the login exchange ------------------------------------------------------

test('the correct pairing credential buys a session and the wrong one does not', async () => {
  const directory = await temporaryDirectory()
  await writeCredential(directory, CREDENTIAL)
  const auth = createAuth({ directory, password: '', sessionMaxAgeSeconds: 3600, sessionIdleSeconds: 60 })
  const { server, origin } = await startAuthServer(auth)
  try {
    const accepted = await attemptLogin(origin, { password: CREDENTIAL })
    assert.equal(accepted.status, 200, 'the pairing credential was accepted')
    const [cookie] = cookies(accepted)
    assert.ok(cookie?.startsWith('dsh_daemon_session='), `expected a session cookie, got ${JSON.stringify(cookies(accepted))}`)
    const value = cookie.slice('dsh_daemon_session='.length).split(';')[0]
    assert.equal((await authState(origin, value)).authenticated, true, 'the issued cookie stands for a live session')

    const refused = await attemptLogin(origin, { password: 'not the credential' })
    assert.equal(refused.status, 401, 'the wrong credential was refused')
    assert.deepEqual(cookies(refused), [], 'a refusal hands out no session')

    const empty = await attemptLogin(origin, { password: '' })
    assert.equal(empty.status, 401, 'an empty credential is refused like any other')
    assert.deepEqual(cookies(empty), [])
  } finally {
    await stopAuthServer(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a submitted credential is hashed even when it is empty', async () => {
  // An early return on the empty value would make it measurably cheaper than a
  // near miss, and that difference is an oracle. The floor is generous: any real
  // scrypt of the production work factor is tens of milliseconds, an early return
  // is microseconds.
  const directory = await temporaryDirectory()
  try {
    const store = new PairingCredential({ directory, password: CREDENTIAL })

    /** Fastest of a few runs, so scheduler noise cannot inflate one sample. */
    const fastest = async (submitted) => {
      let best = Number.POSITIVE_INFINITY
      for (let run = 0; run < 3; run += 1) {
        const started = process.hrtime.bigint()
        await store.verify(submitted)
        best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6)
      }
      return best
    }

    const emptyMs = await fastest('')
    const wrongMs = await fastest('not the credential')
    assert.ok(emptyMs > 1, `an empty credential must still be hashed (it took ${emptyMs.toFixed(3)} ms)`)
    assert.ok(
      emptyMs > wrongMs * 0.5,
      `an empty credential must cost about as much as a wrong one (${emptyMs.toFixed(1)} ms vs ${wrongMs.toFixed(1)} ms)`,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the federation token cannot pair and the pairing credential cannot federate', async () => {
  // Two credentials, two directions, neither interchangeable: the tunnel token is
  // for a machine, the pairing credential is for a person.
  const directory = await temporaryDirectory()
  const environment = { id: 'env-a', token: 'federation-token-1' }
  const hub = createTunnelHub({
    verifyToken: (token) => (token === environment.token ? environment : undefined),
    logger: { info() {}, warn() {} },
  })
  const auth = createAuth({ directory, password: CREDENTIAL, sessionMaxAgeSeconds: 3600, sessionIdleSeconds: 60 })
  const { server, origin } = await startAuthServer(auth)
  try {
    const withToken = await attemptLogin(
      origin,
      { password: environment.token },
      { 'x-dsh-federation': environment.token },
    )
    assert.equal(withToken.status, 401, 'the federation token is not a pairing credential, even in the federation header')
    assert.deepEqual(cookies(withToken), [])

    const headerOnly = await fetch(`${origin}/api/auth.state`, { headers: { 'x-dsh-federation': environment.token } })
    assert.equal(headerOnly.status, 200)
    assert.equal((await headerOnly.json()).authenticated, false, 'the federation header does not stand in for a session')

    assert.equal(hub.verify(CREDENTIAL), undefined, 'the pairing credential is not a tunnel token')
    assert.equal(hub.verify(environment.token), environment, 'the tunnel token still resolves its environment')
  } finally {
    await stopAuthServer(server)
    await rm(directory, { recursive: true, force: true })
  }
})
