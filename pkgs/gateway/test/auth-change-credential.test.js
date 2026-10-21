/**
 * Changing the pairing credential from the panel.
 *
 * The daemon used to offer exactly two ways to change it: edit the profile, or log
 * into the machine and delete `pairing.json` and restart — the first needs SSH, the
 * second signs everyone out. An operator who suspects the credential leaked had no
 * safe move. This endpoint is that move, and the properties that make it safe are the
 * ones asserted here.
 *
 * Everything runs against a **really mounted daemon over a real socket**: the session
 * gate, the admin router, the credential store and the listener are all on one request
 * path, and a test that built the router by hand would pass while the mount was
 * unreachable. Every assertion is a result a caller can observe — a status, a body, the
 * bytes of the file, and which cookies are still accepted. Nothing reads the source.
 *
 * The two-session cases are the point of the ticket: one login is not enough to show
 * that a change withdraws *other* sessions while sparing the caller's own.
 */

import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { PAIRING_CREDENTIAL_FILE, PAIRING_CREDENTIAL_MIN_LENGTH } from '../lib/auth/pairing-credential.js'

/** A cheap work factor: one record per mount, fast enough for a test. */
const CHEAP = Object.freeze({ N: 1024, r: 8, p: 1, keylen: 32 })

/** The credential the seeded record stands for, i.e. "the current one". */
const CREDENTIAL = 'pairing credential 4c19'

/** A credential one character under the shared minimum. */
const TOO_SHORT = 'z'.repeat(PAIRING_CREDENTIAL_MIN_LENGTH - 1)

/** The endpoint under test. */
const ENDPOINT = '/admin/credential'

/** A temporary DSH home; the production path is never touched. */
async function temporaryHome() {
  return await mkdtemp(join(tmpdir(), 'dsh-gateway-change-'))
}

/** Where the credential lives inside a home. */
function credentialPath(home) {
  return join(home, 'daemon', 'auth', PAIRING_CREDENTIAL_FILE)
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
    role: 'main',
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

/** Run `body` against a freshly mounted, already-paired daemon; always tear it down. */
async function withDaemon(config, body) {
  const home = await temporaryHome()
  await seedCredential(home)
  const daemon = await startDaemon(home, config)
  try {
    return await body({ home, ...daemon })
  } finally {
    await daemon.close()
    await rm(home, { recursive: true, force: true })
  }
}

/** Sign in and return the `Cookie` header value this browser should send. */
async function signIn(origin, credential = CREDENTIAL) {
  const response = await fetch(`${origin}/api/auth.login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: credential }),
  })
  assert.equal(response.status, 200, `the credential "${credential}" was accepted`)
  const cookies = response.headers.getSetCookie()
  assert.ok(cookies.length > 0, 'signing in set a session cookie')
  return cookies.map((value) => value.split(';')[0]).join('; ')
}

/** Post a change request and return the raw response. */
async function change(origin, body, { cookie, path = ENDPOINT } = {}) {
  return await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  })
}

/** Whether a cookie still stands for a live session, asked of the auth layer itself. */
async function authenticated(origin, cookie) {
  const response = await fetch(`${origin}/api/auth.state`, { headers: { cookie } })
  assert.equal(response.status, 200)
  return (await response.json()).authenticated === true
}

/** Whether this cookie can still read an admin route — a session, not just a claim. */
async function adminReachable(origin, cookie) {
  const response = await fetch(`${origin}/admin/state`, { headers: { cookie } })
  if (response.status !== 200) return false
  return String(response.headers.get('content-type') ?? '').startsWith('application/json')
}

/** The bytes of the credential file, or undefined when it does not exist. */
async function credentialBytes(home) {
  return await readFile(credentialPath(home), 'utf8').catch(() => undefined)
}

// --- the happy path ----------------------------------------------------------

test('the correct current credential changes the credential at once', async () => {
  // "At once" is the whole reason this endpoint exists: the usual motive for changing
  // is a suspected leak, and a change that waits for a restart leaves the window that
  // matters. So the assertion is made against the *login endpoint* right after the
  // response, with no restart in between: the new value signs a browser in and the old
  // one does not.
  await withDaemon({}, async ({ home, origin }) => {
    const caller = await signIn(origin)
    const before = await credentialBytes(home)

    const next = 'a brand new pairing credential 81f2'
    const response = await change(origin, { current: CREDENTIAL, password: next, confirm: next }, { cookie: caller })
    assert.equal(response.status, 200, 'the change is accepted')
    assert.deepEqual(await response.json(), { ok: true }, 'and says only that it worked')

    const after = await credentialBytes(home)
    assert.notEqual(after, before, 'the credential file was rewritten')
    assert.equal(after.includes(next), false, 'what reached the disk is a hash, not the new credential')
    assert.equal((await stat(credentialPath(home))).mode & 0o777, 0o600, 'the file is still owner-only')

    // The new credential logs in — no restart, no re-mount, no second call.
    const fresh = await fetch(`${origin}/api/auth.login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: next }),
    })
    assert.equal(fresh.status, 200, 'the new credential logs in immediately')

    const stale = await fetch(`${origin}/api/auth.login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: CREDENTIAL }),
    })
    assert.equal(stale.status, 401, 'the old credential no longer does')
  })
})

test('the caller keeps its session and every other session is refused', async () => {
  // Two signed-in browsers, one change. The caller proved it holds both the old and the
  // new credential, so signing it out would only cost a pointless login; the other
  // browser is exactly what a leaked credential would have left behind, so leaving it
  // alive would defeat the change.
  await withDaemon({}, async ({ origin }) => {
    const caller = await signIn(origin)
    const other = await signIn(origin)
    assert.notEqual(caller, other, 'two logins produce two distinct sessions')
    assert.equal(await authenticated(origin, other), true, 'both are live before the change')

    const next = 'another pairing credential 2d70'
    const response = await change(origin, { current: CREDENTIAL, password: next, confirm: next }, { cookie: caller })
    assert.equal(response.status, 200)

    assert.equal(await authenticated(origin, caller), true, 'the caller is still signed in')
    assert.equal(await adminReachable(origin, caller), true, 'and its session still reaches the admin API')
    assert.equal(await authenticated(origin, other), false, 'the other session is gone')
    assert.equal(await adminReachable(origin, other), false, 'and its cookie no longer reaches the admin API')
  })
})

test('a session survives the change across a remount only if it is the caller', async () => {
  // The revocation has to be durable: a store that kept the records in memory and let
  // the next start read the old ones back would sign the withdrawn browser in again.
  // The caller's own record must survive the same restart, or the change would be a
  // logout with extra steps.
  const home = await temporaryHome()
  try {
    await seedCredential(home)
    let daemon = await startDaemon(home)
    let caller
    let other
    try {
      caller = await signIn(daemon.origin)
      other = await signIn(daemon.origin)
      const next = 'yet another pairing credential 55ab'
      assert.equal((await change(daemon.origin, { current: CREDENTIAL, password: next, confirm: next }, { cookie: caller })).status, 200)
    } finally {
      await daemon.close()
    }

    daemon = await startDaemon(home)
    try {
      assert.equal(await authenticated(daemon.origin, caller), true, 'the caller is still signed in after the restart')
      assert.equal(await authenticated(daemon.origin, other), false, 'the withdrawn session was not resurrected by the restart')
    } finally {
      await daemon.close()
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// --- refusals, each leaving the file alone -----------------------------------

test('the wrong current credential is refused and the file is unchanged', async () => {
  // The requirement that makes this a safe change and not a session-only takeover:
  // sessions live for a long time by default, so a session alone must not be able to
  // replace the login credential. An unlocked laptop would otherwise be a permanent
  // takeover.
  await withDaemon({}, async ({ home, origin }) => {
    const caller = await signIn(origin)
    const before = await credentialBytes(home)

    const attempts = [
      ['a wrong current credential', { current: 'not the current credential', password: 'a new credential value', confirm: 'a new credential value' }],
      ['an empty current credential', { current: '', password: 'a new credential value', confirm: 'a new credential value' }],
      ['a missing current credential', { password: 'a new credential value', confirm: 'a new credential value' }],
    ]
    for (const [description, body] of attempts) {
      const response = await change(origin, body, { cookie: caller })
      assert.equal(response.status, 403, `${description} is refused`)
      const answer = await response.json()
      assert.equal(answer.ok, false, `${description}: the refusal says so`)
      assert.equal(typeof answer.error, 'string', `${description}: and explains itself`)
    }

    assert.equal(await credentialBytes(home), before, 'the credential file was not touched by any refusal')
    assert.equal(await authenticated(origin, caller), true, 'a refused change does not sign the caller out')
    assert.equal((await signIn(origin, CREDENTIAL)) !== undefined, true, 'the current credential still works')
  })
})

test('a too-short, empty or mismatched new credential is refused and the file is unchanged', async () => {
  // The new value is judged by the shared rule, so the floor here and the floor on the
  // setup form are the same number rather than two that can drift. And the confirmation
  // is checked by the endpoint as well as the form: a request that skips the page is not
  // a reason to accept one entry as if it had been typed twice.
  await withDaemon({}, async ({ home, origin }) => {
    const caller = await signIn(origin)
    const before = await credentialBytes(home)

    const attempts = [
      ['too short', { current: CREDENTIAL, password: TOO_SHORT, confirm: TOO_SHORT }, 400],
      ['empty', { current: CREDENTIAL, password: '', confirm: '' }, 400],
      ['mismatched', { current: CREDENTIAL, password: 'a perfectly fine new credential', confirm: 'a perfectly fine new credential!' }, 400],
      ['missing confirmation', { current: CREDENTIAL, password: 'a perfectly fine new credential' }, 400],
    ]
    for (const [description, body, status] of attempts) {
      const response = await change(origin, body, { cookie: caller })
      assert.equal(response.status, status, `${description}: refused`)
      assert.equal((await response.json()).ok, false, `${description}: the refusal says so`)
    }

    assert.equal(await credentialBytes(home), before, 'no refusal wrote anything')
    assert.equal(await authenticated(origin, caller), true, 'and none of them signed the caller out')
    assert.equal((await fetch(`${origin}/api/auth.login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: CREDENTIAL }),
    })).status, 200, 'the credential in force still logs in')
  })
})

test('a session is required, and a request without one cannot change the credential', async () => {
  // The gate is the ordinary admin one: without a session the request is answered with
  // the login page and never reaches the route, so no credential can be changed by
  // something that is not signed in at all.
  await withDaemon({}, async ({ home, origin }) => {
    const before = await credentialBytes(home)
    const response = await fetch(`${origin}${ENDPOINT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ current: CREDENTIAL, password: 'a credential nobody signed in chose', confirm: 'a credential nobody signed in chose' }),
    })
    assert.equal(response.status, 200, 'an unauthenticated request gets the page')
    assert.match(String(response.headers.get('content-type')), /^text\/html/u)
    assert.equal(await credentialBytes(home), before, 'and the credential is untouched')
    assert.equal((await signIn(origin, CREDENTIAL)) !== undefined, true, 'the credential still works')
  })
})

test('a refused change tells the caller nothing about the credential in force', async () => {
  // Even a wrong current credential must not be an oracle: no length, no fragment, no
  // "close". The one thing the body carries is that the value was wrong.
  await withDaemon({}, async ({ origin }) => {
    const caller = await signIn(origin)
    const nearMiss = CREDENTIAL.slice(0, -1)
    const bodies = []
    for (const current of ['', nearMiss, 'a completely different credential']) {
      const response = await change(origin, { current, password: 'a new credential value', confirm: 'a new credential value' }, { cookie: caller })
      assert.equal(response.status, 403)
      bodies.push(await response.text())
    }
    for (const body of bodies) {
      assert.equal(body.includes(CREDENTIAL), false, 'no fragment of the stored credential is echoed')
      assert.equal(body.includes(String(PAIRING_CREDENTIAL_MIN_LENGTH)), false, 'and the refusal says nothing about its shape')
    }
    assert.equal(new Set(bodies).size, 1, 'every wrong current credential is answered identically')
  })
})

// --- the response and the surface --------------------------------------------

test('the answer carries nothing about the credential', async () => {
  // The panel must not be able to display any part of it — no last-changed time, no
  // mask, no hint — so the endpoint returns nothing that could be displayed. The body
  // is asserted to be exactly `{ ok: true }`: a field added here for debugging would be
  // a field the panel could render, and a screenshot could carry.
  await withDaemon({}, async ({ origin }) => {
    const caller = await signIn(origin)
    const next = 'one more pairing credential f00d'
    const response = await change(origin, { current: CREDENTIAL, password: next, confirm: next }, { cookie: caller })

    assert.equal(response.status, 200)
    const text = await response.text()
    assert.deepEqual(JSON.parse(text), { ok: true }, 'the whole answer is "it worked"')
    for (const leak of [CREDENTIAL, next, 'createdAt', 'timestamp', 'hint', 'mask', 'fragment', 'length']) {
      assert.equal(text.includes(leak), false, `the answer carries no ${leak}`)
    }
    assert.match(String(response.headers.get('cache-control')), /no-store/u, 'and a shared cache will not keep it')
  })
})

test('a change is answered under the mount the panel is served from', async () => {
  // The panel lives inside the harness, so its requests resolve against that mount. A
  // change that only answers at the origin root is a form that silently does nothing on
  // every prefixed deployment.
  await withDaemon({ rootPrefix: '/main' }, async ({ origin }) => {
    const caller = await signIn(origin)
    const next = 'a credential set through the mounted panel'
    const response = await change(
      origin,
      { current: CREDENTIAL, password: next, confirm: next },
      { cookie: caller, path: '/main/admin/credential' },
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })

    assert.equal((await fetch(`${origin}/api/auth.login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: next }),
    })).status, 200, 'the mounted change took effect')
  })
})

test('the route refuses anything but a POST and offers no way to read the credential', async () => {
  // A `GET` here would have to answer with something about the credential — that is the
  // only thing the route is about — and the ticket forbids showing any of it. So there
  // is nothing to read: the method is refused with the one that is allowed.
  await withDaemon({}, async ({ origin }) => {
    const caller = await signIn(origin)
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(`${origin}${ENDPOINT}`, { method, headers: { cookie: caller } })
      assert.equal(response.status, 405, `${method} is refused`)
      assert.equal(response.headers.get('allow'), 'POST', `${method} is told what is allowed`)
      const body = await response.json()
      assert.equal(body.ok, false)
      assert.equal(body.credential, undefined, `${method} answers with no credential`)
    }
    assert.equal(await authenticated(origin, caller), true, 'and none of those attempts was a logout')
  })
})

test('a browser that is not signed in but presents a stale cookie is refused, and so is a tunnel peer', async () => {
  // Two doors that must stay shut. A cookie the store no longer honours is not a session,
  // so it must not be able to change the credential. And the tunnel-authenticated path
  // into `/admin` is a peer node, not the operator: it carries no session, so it has
  // nothing the change could keep and no proof of the credential either.
  await withDaemon({ token: 'e'.repeat(48) }, async ({ home, origin }) => {
    const before = await credentialBytes(home)
    const forged = 'dsh_daemon_session=AAAAAAAAAAAAAAAAAAAAAA.1'
    const withCookie = await change(origin, { current: CREDENTIAL, password: 'a credential from a stale cookie', confirm: 'a credential from a stale cookie' }, { cookie: forged })
    assert.equal(withCookie.status, 200, 'a cookie naming no session gets the login page')
    assert.match(String(withCookie.headers.get('content-type')), /^text\/html/u)

    const tunnel = await fetch(`${origin}${ENDPOINT}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-federation': 'e'.repeat(48) },
      body: JSON.stringify({ current: CREDENTIAL, password: 'a credential from a peer node', confirm: 'a credential from a peer node' }),
    })
    assert.equal(tunnel.status, 403, 'a tunnel peer has no session to keep and is refused')
    assert.equal(await credentialBytes(home), before, 'neither door changed the credential')
  })
})
