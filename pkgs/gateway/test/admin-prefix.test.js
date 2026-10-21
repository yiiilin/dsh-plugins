/**
 * The panel's admin API answers under the mount it is served from.
 *
 * The panel is a client plugin inside the harness, so its requests resolve against
 * the page it is on: under `rootPrefix: /main` they arrive as `/main/admin/…`. Those
 * calls name this process's own control surface — the mount is where its UI lives,
 * not a separate authority — so the daemon has to answer them, and only a mounted
 * daemon over a real socket can show that.
 *
 * The counterpart is asserted too: a paired browser must still get JSON for a path
 * *inside* the mount that is not `/admin`, because everything else there belongs to
 * the harness and rewriting it would be a routing bug in the other direction.
 */

import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { PAIRING_CREDENTIAL_FILE } from '../lib/auth/pairing-credential.js'

/** A cheap work factor: one record per mount, fast enough for a test. */
const CHEAP = Object.freeze({ N: 1024, r: 8, p: 1, keylen: 32 })

/** The credential the seeded record stands for. */
const CREDENTIAL = 'pairing credential 5a0c'

/** A temporary DSH home; the production path is never touched. */
async function temporaryHome() {
  return await mkdtemp(join(tmpdir(), 'dsh-gateway-admin-'))
}

/** Seed `daemon/auth/pairing.json`, which is now the only source of the credential. */
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
 * The listener is started by the plugin's own effect, so the bound port is only
 * known from the daemon's startup line.
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

test('a paired browser reaches the admin API under the mount the panel is served from', async () => {
  // This is the request the fixed client makes under `/main/`. Answering it with the
  // login page — which is what an unauthenticated prefix-less request gets — is the
  // silent failure the panel showed as "unreachable".
  await withDaemon({ rootPrefix: '/main' }, async ({ origin }) => {
    const cookie = await pair(origin)

    const state = await fetch(`${origin}/main/admin/state`, { headers: { cookie } })
    assert.equal(state.status, 200)
    assert.match(String(state.headers.get('content-type')), /^application\/json/u, 'the panel gets JSON, not the login page')
    const body = await state.json()
    assert.equal(body.ok, true)
    assert.equal(body.role, 'main')
    assert.deepEqual(body.environments, [], 'the mounted daemon answers with its own state')
  })
})

test('an unpaired request under the mount still gets the login page', async () => {
  // Accepting the prefixed admin path must not be a way around the session: the gate
  // is the same one the prefix-less path goes through.
  await withDaemon({ rootPrefix: '/main' }, async ({ origin }) => {
    const response = await fetch(`${origin}/main/admin/state`)
    assert.equal(response.status, 200)
    assert.match(String(response.headers.get('content-type')), /^text\/html/u, 'a visitor without a session gets the page')
    const html = await response.text()
    assert.match(html, /id="login"/u)
    assert.doesNotMatch(html, /"role":/u, 'no daemon state leaked into the login page')
  })
})

test('only /admin under the mount is rewritten; the rest of the mount is not', async () => {
  // The mount is the harness. A daemon that claimed every path under it would break
  // the product it is hosting, so the rewrite is narrow by design.
  await withDaemon({ rootPrefix: '/main' }, async ({ origin }) => {
    const cookie = await pair(origin)

    // `/main/manifest.webmanifest` is served by the daemon's own asset table; a path
    // it does not own under the mount is forwarded to the harness, which is not
    // mounted here (`rootEmbedded: false`) and therefore answers nothing.
    const asset = await fetch(`${origin}/main/manifest.webmanifest`, { headers: { cookie } })
    assert.equal(asset.status, 200)
    assert.match(String(asset.headers.get('content-type')), /^application\/manifest\+json/u)

    const notAdmin = await fetch(`${origin}/main/some/harness/path`, { headers: { cookie } })
    assert.notEqual(notAdmin.status, 200, 'a harness path is not answered as admin state')
    assert.doesNotMatch(String(notAdmin.headers.get('content-type') ?? ''), /^application\/json/u)
  })
})

test('at the origin root the admin API is unchanged', async () => {
  // An edge serves its harness at `/`, where the panel's requests never carried a
  // prefix. The fix must not move the route it already had.
  await withDaemon({}, async ({ origin }) => {
    const cookie = await pair(origin)
    const state = await fetch(`${origin}/admin/state`, { headers: { cookie } })
    assert.equal(state.status, 200)
    assert.equal((await state.json()).ok, true)
  })
})

test('the login page served under the mount posts to a path the daemon answers', async () => {
  // The page is served from inside the mount, so a browser resolves its form action
  // against that mount. The action must therefore both name the mount AND be
  // rewritten by the daemon — a form that posts to `/main/api/auth.login` when
  // nothing rewrites it falls through to the login page again, and the page's own
  // `response.json()` throws, so pairing becomes impossible on every prefixed
  // deployment while the HTML still looks correct.
  await withDaemon({ rootPrefix: '/main' }, async ({ origin }) => {
    const page = await fetch(`${origin}/main/admin/state`)
    const html = await page.text()
    const action = html.match(/<form[^>]*action="([^"]+)"/u)?.[1]
    assert.ok(action !== undefined, 'the served page carries a form action')
    assert.ok(
      action.startsWith('/main/api/auth.login'),
      `the action stays inside the mount the page was served from, got ${action}`,
    )

    // Post exactly what the browser would post: the action, verbatim.
    const response = await fetch(`${origin}${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: CREDENTIAL }),
    })
    assert.equal(response.status, 200, 'the daemon answers the posted action')
    const body = await response.json()
    assert.equal(body.ok, true, 'the posted credential pairs')
    assert.ok(
      (response.headers.getSetCookie() ?? []).some((entry) => entry.startsWith('dsh_daemon_session=')),
      'pairing yields a session cookie',
    )
  })
})

test('a profile still carrying the retired credential keys is told they do nothing', async () => {
  // Removing a key from the schema does not remove it from an existing profile:
  // schemastery merges unknown keys instead of rejecting them. A deployment that
  // had `twoFactorEnabled: true` would otherwise lose its second factor with no
  // line in the log to explain it.
  const warnings = []
  const home = await temporaryHome()
  try {
    await seedCredential(home)
    const ctx = {
      logger: { info: () => true, warn: (message) => { warnings.push(String(message)); return true } },
      get: () => undefined,
      effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') dispose(); return () => {} },
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
      rootPrefix: 'main',
      twoFactorEnabled: true,
      passkeyOrigin: 'https://example.test',
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
  const notice = warnings.find((line) => line.includes('ignoring'))
  assert.ok(notice !== undefined, `expected a warning about the retired keys, got ${JSON.stringify(warnings)}`)
  assert.match(notice, /twoFactorEnabled/u, 'the warning names the key that no longer does anything')
  assert.match(notice, /passkeyOrigin/u, 'and every retired key it found')
})

test('an accepted request re-issues a cookie that is falling behind', async () => {
  // The browser's cookie carries the lifetime it was given at login, while the
  // server's deadline slides with every accepted request. Without a re-issue the
  // two drift apart and a browser in constant use is signed out when its original
  // window closes — a deadline the session itself never reached. The window here
  // is short so the renewal point arrives inside the test.
  await withDaemon({ rootPrefix: '/main', sessionMaxAgeSeconds: 2 }, async ({ origin }) => {
    const cookie = await pair(origin)

    // Immediately after pairing there is nothing to renew.
    const fresh = await fetch(`${origin}/main/admin/state`, { headers: { cookie } })
    assert.equal(fresh.status, 200)
    assert.deepEqual(fresh.headers.getSetCookie(), [], 'a cookie well inside its window is left alone')

    // Past a quarter of the lifetime the browser's copy is worth renewing. The
    // renewal point is dynamic — the code renews once the elapsed time reaches a
    // third of what is left, which is a quarter of the original lifetime.
    await new Promise((done) => setTimeout(done, 700))
    const due = await fetch(`${origin}/main/admin/state`, { headers: { cookie } })
    assert.equal(due.status, 200, 'the session is still accepted')
    const renewed = due.headers.getSetCookie()
    assert.equal(renewed.length, 1, `the cookie is re-issued once, got ${JSON.stringify(renewed)}`)
    assert.match(renewed[0], /dsh_daemon_session=/u, 'the re-issued cookie carries the same session')
  })
})
