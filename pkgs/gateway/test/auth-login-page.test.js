/**
 * The login page asks for exactly one credential.
 *
 * Every assertion here is about what a browser — or a caller of the public
 * interface — can observe: the rendered document, and the JSON a real login
 * request gets over a socket. Nothing reads the source, so the page may be
 * restructured freely as long as it keeps asking one question and keeps
 * exchanging the right answer for a session.
 */

import assert from 'node:assert/strict'
import { randomBytes, scryptSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PAIRING_CREDENTIAL_FILE } from '../lib/auth/pairing-credential.js'
import { renderLoginPage } from '../lib/auth/login-page.js'
import { createAuth } from '../lib/auth/session.js'

/** A credential distinctive enough that a wrong guess is never a near miss. */
const CREDENTIAL = 'pairing credential 4c1d'

/** A cheap work factor, so writing a record per test stays fast. */
const CHEAP = Object.freeze({ N: 1024, r: 8, p: 1, keylen: 32 })

/** A temporary auth directory; the production path is never touched. */
async function temporaryDirectory() {
  return await mkdtemp(join(tmpdir(), 'dsh-gateway-login-page-'))
}

/**
 * Seed the auth directory with a credential record written by the test.
 *
 * The record carries its own scrypt parameters, so the test may pick a cheaper
 * work factor than the one a fresh bootstrap would choose.
 */
async function writeCredential(directory, credential) {
  const salt = randomBytes(16)
  const hash = scryptSync(credential, salt, CHEAP.keylen, { N: CHEAP.N, r: CHEAP.r, p: CHEAP.p, maxmem: 64 * 1024 * 1024 })
  const record = {
    version: 1,
    credential: {
      kdf: 'scrypt',
      salt: salt.toString('base64url'),
      hash: hash.toString('base64url'),
      ...CHEAP,
      createdAt: 1_600_000_000_000,
    },
  }
  await writeFile(join(directory, PAIRING_CREDENTIAL_FILE), `${JSON.stringify(record)}\n`, { mode: 0o600 })
}

/** A request object shaped like the one the entry router hands the layer. */
function loginPageRequest(headers = {}, url = '/') {
  return { method: 'GET', url, headers, socket: { remoteAddress: '127.0.0.1' } }
}

/** Answer every request with the authentication layer over a real socket. */
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

/** Post one sign-in attempt and return the raw response. */
async function attemptLogin(origin, body, url = '/api/auth.login') {
  return await fetch(`${origin}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// --- what the page asks for --------------------------------------------------

test('the login page has exactly one input and no passkey affordance', async () => {
  // One credential is the whole model now: a second field would be a second thing
  // the operator has to maintain, and a passkey button would be a path with no
  // implementation behind it.
  const directory = await temporaryDirectory()
  await writeCredential(directory, CREDENTIAL)
  const auth = createAuth({ directory })
  try {
    for (const locale of ['en', 'zh']) {
      const html = auth.loginPage(loginPageRequest({ 'accept-language': locale }, '/'))
      const inputs = html.match(/<input\b/giu) ?? []
      assert.equal(inputs.length, 1, `${locale}: the page must ask for exactly one thing, found ${inputs.length} inputs`)
      assert.doesNotMatch(html, /passkey/iu, `${locale}: no passkey reference may survive on the page`)

      // The single field is the pairing credential, posted under the member the
      // login endpoint already reads — the wire format did not change.
      assert.match(html, /name="password"/u, `${locale}: the one input carries the credential in the password member`)
      assert.match(html, /id="login"/u, `${locale}: the form the script submits is still the page's own form`)
      assert.match(html, /\/api\/auth\.login/u, `${locale}: the form still posts to the login endpoint`)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the page renders in both Chinese and English', async () => {
  // Both dictionaries are still live: the language switch is part of the page, and
  // a locale that lost its strings would fall back silently and be noticed by
  // nobody until a user saw English on a Chinese deployment.
  const directory = await temporaryDirectory()
  await writeCredential(directory, CREDENTIAL)
  const auth = createAuth({ directory })
  try {
    const zh = auth.loginPage(loginPageRequest({ 'accept-language': 'zh-CN,zh;q=0.9' }, '/?lang=zh'))
    assert.match(zh, /<html lang="zh-CN">/u, 'the Chinese dictionary declares a Chinese document')
    assert.match(zh, /配对凭据/u, 'the Chinese page names the pairing credential in Chinese')
    assert.doesNotMatch(zh, /Pairing credential/u, 'no English fallback leaked into the Chinese copy')

    const en = auth.loginPage(loginPageRequest({ 'accept-language': 'en-US,en;q=0.9' }, '/?lang=en'))
    assert.match(en, /<html lang="en">/u, 'the English dictionary declares an English document')
    assert.match(en, /Pairing credential/u, 'the English page names the pairing credential in English')
    assert.doesNotMatch(en, /配对凭据/u, 'no Chinese copy leaked into the English page')

    // The two are the same page in two languages, not two pages that drifted apart.
    // Comparing the input count is the part of the structure that matters now.
    for (const html of [zh, en]) {
      assert.equal((html.match(/<input\b/giu) ?? []).length, 1, 'each locale asks for exactly one thing')
      assert.equal((html.match(/<form\b/giu) ?? []).length, 1, 'each locale is one form')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

// --- exchanging the credential for a session ---------------------------------

test('the correct pairing credential buys a session and a wrong one does not', async () => {
  const directory = await temporaryDirectory()
  await writeCredential(directory, CREDENTIAL)
  const auth = createAuth({ directory })
  const { server, origin } = await startAuthServer(auth)
  try {
    const accepted = await attemptLogin(origin, { password: CREDENTIAL })
    assert.equal(accepted.status, 200, 'the pairing credential was accepted')
    const cookies = accepted.headers.getSetCookie()
    const session = cookies.find((entry) => entry.startsWith('dsh_daemon_session='))
    assert.ok(session !== undefined, `expected a session cookie, got ${JSON.stringify(cookies)}`)

    const value = session.slice('dsh_daemon_session='.length).split(';')[0]
    const state = await fetch(`${origin}/api/auth.state`, { headers: { cookie: `dsh_daemon_session=${value}` } })
    assert.equal((await state.json()).authenticated, true, 'the issued cookie stands for a live session')

    const refused = await attemptLogin(origin, { password: 'not the pairing credential' })
    assert.equal(refused.status, 401, 'the wrong credential was refused')
    assert.deepEqual(refused.headers.getSetCookie(), [], 'a refusal hands out no session')

    const empty = await attemptLogin(origin, { password: '' })
    assert.equal(empty.status, 401, 'an empty credential is refused like any other')
    assert.deepEqual(empty.headers.getSetCookie(), [])

    // No credential member at all: the page always sends one, but a hand-made
    // request must not be treated as a blank credential that somehow passes.
    const absent = await attemptLogin(origin, {})
    assert.equal(absent.status, 401, 'a request without a credential is refused')
    assert.deepEqual(absent.headers.getSetCookie(), [])
  } finally {
    await stopAuthServer(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a browser with no session is served the login page instead of a credential error', async () => {
  // The "no credential" case from the ticket's list: nobody signed in yet, so the
  // page is served. It is the state every first visit is in.
  const directory = await temporaryDirectory()
  await writeCredential(directory, CREDENTIAL)
  const auth = createAuth({ directory })
  const { server, origin } = await startAuthServer(auth)
  try {
    const state = await fetch(`${origin}/api/auth.state`)
    assert.equal(state.status, 200)
    assert.equal((await state.json()).authenticated, false, 'an unpaired browser is not authenticated')

    const page = auth.loginPage(loginPageRequest({}, '/'))
    assert.match(page, /<form id="login"/u, 'the unauthenticated visitor gets the form')
    assert.match(page, /name="password"/u, 'with the one field it can fill in')

    // And logging out of nothing revokes nothing and clears the cookie rather than
    // issuing one, so a stale browser is left in a defined state.
    const logout = await fetch(`${origin}/api/auth.logout`, { method: 'POST', redirect: 'manual' })
    assert.equal(logout.status, 303, 'logout redirects back to the login page')
    const cleared = logout.headers.getSetCookie()
    assert.equal(cleared.length, 1, `expected exactly one clearing cookie, got ${JSON.stringify(cleared)}`)
    assert.match(cleared[0], /^dsh_daemon_session=;[^]*Max-Age=0/u, 'the cookie is emptied, not set')
  } finally {
    await stopAuthServer(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a refused pairing credential explains itself in both languages', async () => {
  // The page shows whatever the endpoint says, so the endpoint is where the
  // language has to be right. A refusal that repeats the form's default copy
  // would still be true, but the operator would not know which locale they got.
  const directory = await temporaryDirectory()
  await writeCredential(directory, CREDENTIAL)
  const auth = createAuth({ directory })
  const { server, origin } = await startAuthServer(auth)
  try {
    const en = await attemptLogin(origin, { password: 'wrong' }, '/api/auth.login?lang=en')
    assert.equal(en.status, 401)
    const enBody = await en.json()
    assert.equal(enBody.ok, false)
    assert.match(String(enBody.error), /pairing credential/iu, `expected an English refusal, got ${JSON.stringify(enBody.error)}`)

    const zh = await attemptLogin(origin, { password: 'wrong' }, '/api/auth.login?lang=zh')
    assert.equal(zh.status, 401)
    const zhBody = await zh.json()
    assert.equal(zhBody.ok, false)
    assert.match(String(zhBody.error), /配对凭据/u, `expected a Chinese refusal, got ${JSON.stringify(zhBody.error)}`)
    assert.notEqual(zhBody.error, enBody.error, 'the two languages are not the same string')
  } finally {
    await stopAuthServer(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a credential written to pairing.json is what the page accepts, and nothing else is', async () => {
  // The file is the only source of truth. A page tested against a configured value
  // would pass even if the request path never consulted the store.
  const directory = await temporaryDirectory()
  await writeCredential(directory, CREDENTIAL)
  const auth = createAuth({ directory, sessionMaxAgeSeconds: 3600, sessionIdleSeconds: 60 })
  const { server, origin } = await startAuthServer(auth)
  try {
    assert.equal((await attemptLogin(origin, { password: CREDENTIAL })).status, 200, 'the stored record is accepted')
    assert.equal((await attemptLogin(origin, { password: 'another pairing credential' })).status, 401)
  } finally {
    await stopAuthServer(server)
    await rm(directory, { recursive: true, force: true })
  }
})

test('under a prefix the form posts the credential inside the mount', async () => {
  // A root-absolute action leaves the prefix and reaches whatever answers at the
  // origin — taking the pairing credential with it. The form and the route that
  // accepts it have to be derived from the same prefix.
  const html = renderLoginPage('realm', 'en', '/main/', 'main')
  const action = html.match(/<form[^>]*action="([^"]+)"/u)?.[1]
  assert.ok(action !== undefined, 'the form carries an action')
  assert.ok(
    action.startsWith('/main/api/auth.login'),
    `the form posts inside the mount, got ${action}`,
  )

  // At the origin root the action is still the daemon's own path, not a doubled slash.
  const rootHtml = renderLoginPage('realm', 'en', '/', '')
  const rootAction = rootHtml.match(/<form[^>]*action="([^"]+)"/u)?.[1]
  assert.ok(
    rootAction.startsWith('/api/auth.login'),
    `at the origin root the action stays absolute, got ${rootAction}`,
  )
})
