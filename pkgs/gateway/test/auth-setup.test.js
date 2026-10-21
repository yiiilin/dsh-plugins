/**
 * First-time setup: when there is no credential file, the login page teaches you to set one.
 *
 * Every assertion goes through the public surface a browser uses — the rendered page over
 * a real socket, and the JSON the login endpoint answers — so the page may be restructured
 * freely as long as it keeps asking the right questions and keeps the right answers.
 *
 * The daemon is really mounted here, because that is the seam the ticket moves: a missing
 * `pairing.json` used to stop `apply()` before a listener existed. A test that built the
 * auth layer by hand would pass while the daemon still refused to start.
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'
import { PAIRING_CREDENTIAL_FILE } from '../lib/auth/pairing-credential.js'

/** A credential that satisfies the minimum length and is nobody's near miss. */
const CREDENTIAL = 'a fresh pairing credential 3e7b'
/** One character under the minimum the spec fixes at 12. */
const TOO_SHORT = 'x'.repeat(11)

/** A temporary DSH home; the production path is never touched. */
async function temporaryHome() {
  return await mkdtemp(join(tmpdir(), 'dsh-gateway-setup-'))
}

/** Where the credential would live inside a home. */
function credentialPath(home) {
  return join(home, 'daemon', 'auth', PAIRING_CREDENTIAL_FILE)
}

/**
 * Mount the daemon and wait until it is listening.
 *
 * The listener is started by the plugin's own effect, so the bound port is only known
 * from the daemon's startup line. A mount that throws never announces, which is exactly
 * how the "it still starts" assertion below would fail.
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

/** Run `body` against a mounted daemon and always tear it down. */
async function withDaemon(config, body) {
  const home = await temporaryHome()
  const daemon = await startDaemon(home, config)
  try {
    return await body({ home, ...daemon })
  } finally {
    await daemon.close()
    await rm(home, { recursive: true, force: true })
  }
}

/** The page a visitor with no session is served. */
async function loginPage(origin, url = '/') {
  const response = await fetch(`${origin}${url}`)
  assert.equal(response.status, 200)
  assert.match(String(response.headers.get('content-type')), /^text\/html/u)
  return await response.text()
}

/** Submit the login endpoint and return the raw response. */
async function submit(origin, body, url = '/api/auth.login') {
  return await fetch(`${origin}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** The session cookie value a response set, or undefined. */
function sessionOf(response) {
  const raw = response.headers.getSetCookie()
  const cookie = raw.find((entry) => entry.startsWith('dsh_daemon_session='))
  return cookie?.slice('dsh_daemon_session='.length).split(';')[0]
}

/** What the auth layer says about the session a cookie stands for. */
async function authState(origin, cookie) {
  const response = await fetch(`${origin}/api/auth.state`, {
    headers: cookie === undefined ? {} : { cookie: `dsh_daemon_session=${cookie}` },
  })
  assert.equal(response.status, 200)
  return await response.json()
}

/** The number of password fields a document asks the visitor to fill in. */
function inputCount(html) {
  return (html.match(/<input\b/giu) ?? []).length
}

// --- the shape of the page ---------------------------------------------------

test('without a credential file the daemon mounts and the page is the setup form', async () => {
  // The dead end this ticket removes: no credential used to mean no process at all, so
  // there was nowhere to set one. The mount has to succeed, and the page it serves has
  // to be the guide out — two entries, because a typo would otherwise lock the operator
  // out of the machine they are installing.
  await withDaemon({}, async ({ home, origin }) => {
    assert.equal(
      await readFile(credentialPath(home), 'utf8').catch(() => undefined),
      undefined,
      'the setup has not run yet, so there is no file',
    )

    const html = await loginPage(origin)
    assert.equal(inputCount(html), 2, 'the setup form asks for the new credential and its confirmation')
    assert.match(html, /id="credential"/u, 'the first field is the credential itself')
    assert.match(html, /id="confirm"/u, 'the second field is the confirmation')
    assert.match(html, /name="password"/u, 'the credential posts under the member the endpoint reads')
    assert.match(html, /name="confirm"/u, 'the confirmation posts under its own member')
    assert.match(html, /\/api\/auth\.login/u, 'the setup form posts to the login endpoint')
    // The visitor is told this is an install, not a sign-in, and why the window is open.
    assert.match(html, /[Nn]o pairing credential is set yet/u)
    assert.match(html, /anyone who can reach/iu, 'the page states the source-address trade-off')

    // And it is genuinely unauthenticated: setup is not a way in before it is used.
    assert.equal((await authState(origin, undefined)).authenticated, false)
  })
})

test('with a credential file the page is the ordinary login form', async () => {
  // The other half of the one condition: the file exists, so there is nothing to set
  // up. A setup form here would invite overwriting a credential the operator already
  // chose, which is a much bigger surface than the missing-file window.
  const home = await temporaryHome()
  try {
    const authDirectory = join(home, 'daemon', 'auth')
    await mkdir(authDirectory, { recursive: true, mode: 0o700 })
    // Write the file through the setup endpoint's own path is not possible yet (no
    // running daemon), so mount first, set the credential over HTTP, then restart.
    let daemon = await startDaemon(home)
    try {
      const accepted = await submit(daemon.origin, { password: CREDENTIAL, confirm: CREDENTIAL })
      assert.equal(accepted.status, 200, 'the first setup is what creates the file')
    } finally {
      await daemon.close()
    }

    daemon = await startDaemon(home)
    try {
      const html = await loginPage(daemon.origin)
      assert.equal(inputCount(html), 1, 'an existing credential is asked for once, not twice')
      assert.match(html, /id="credential"/u)
      assert.doesNotMatch(html, /id="confirm"/u, 'no confirmation field survives into the login form')
      assert.doesNotMatch(html, /[Nn]o pairing credential is set yet/u, 'the install guidance is gone')
    } finally {
      await daemon.close()
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// --- refusing a bad setup ----------------------------------------------------

test('a mismatched or too-short setup is refused and no file is written', async () => {
  // The whole point of the confirmation is that a failed setup leaves the machine
  // exactly as it was. A file written on a refused attempt would be a credential
  // nobody agreed on, and the page would stop offering the guide it still needs.
  await withDaemon({}, async ({ home, origin }) => {
    const path = credentialPath(home)
    const attempts = [
      ['the two entries differ', { password: CREDENTIAL, confirm: `${CREDENTIAL}!` }],
      ['the new credential is empty', { password: '', confirm: '' }],
      ['the new credential is too short', { password: TOO_SHORT, confirm: TOO_SHORT }],
      ['the confirmation is missing', { password: CREDENTIAL }],
      ['the confirmation is empty', { password: CREDENTIAL, confirm: '' }],
    ]
    for (const [description, body] of attempts) {
      const response = await submit(origin, body)
      assert.equal(response.status, 400, `${description}: the setup must be refused`)
      const answer = await response.json()
      assert.equal(answer.ok, false, `${description}: the refusal says so`)
      assert.equal(typeof answer.error, 'string', `${description}: and explains itself`)
      assert.equal(sessionOf(response), undefined, `${description}: a refusal signs nobody in`)
      assert.equal(
        await readFile(path, 'utf8').catch(() => undefined),
        undefined,
        `${description}: no credential file was written`,
      )
    }

    const html = await loginPage(origin)
    assert.equal(inputCount(html), 2, 'after every refusal the page still offers setup')
    assert.equal((await authState(origin, undefined)).authenticated, false, 'and nothing is signed in')
  })
})

test('the minimum length is the same rule the page states', async () => {
  // The page renders the number from the same constant the endpoint enforces. A page
  // that said one thing and an endpoint that did another is exactly the drift the shared
  // constant exists to prevent, so the boundary value is checked from both sides.
  await withDaemon({}, async ({ home, origin }) => {
    const html = await loginPage(origin)
    assert.match(html, /at least 12 characters/u, 'the page names the minimum')

    const boundary = 'y'.repeat(12)
    const accepted = await submit(origin, { password: boundary, confirm: boundary })
    assert.equal(accepted.status, 200, 'a credential of exactly the minimum is accepted')
    assert.notEqual(sessionOf(accepted), undefined, 'and that request is signed in too')
    assert.notEqual(await readFile(credentialPath(home), 'utf8').catch(() => undefined), undefined)
  })
})

// --- a successful setup ------------------------------------------------------

test('a successful setup signs the browser in and the credential works afterwards', async () => {
  // The ticket's core promise: finishing the install is one step. The browser that
  // chose the credential is signed in by the same response, and the credential it chose
  // is real — it works from a fresh browser, survives a restart, and is stored as a
  // hash rather than plaintext.
  await withDaemon({}, async ({ home, origin }) => {
    const response = await submit(origin, { password: CREDENTIAL, confirm: CREDENTIAL })
    assert.equal(response.status, 200, 'the setup is accepted')
    assert.equal((await response.json()).ok, true)

    const cookie = sessionOf(response)
    assert.ok(cookie !== undefined, 'the setup response carries a session cookie')
    assert.equal((await authState(origin, cookie)).authenticated, true, 'and it stands for a live session')

    // The file exists now, owner-only, and holds a hash rather than the credential.
    const path = credentialPath(home)
    const text = await readFile(path, 'utf8')
    assert.equal(text.includes(CREDENTIAL), false, 'the plaintext credential is not on disk')
    assert.equal((await stat(path)).mode & 0o777, 0o600, 'the credential file is owner-only')

    // The page is the ordinary login form now: the window closed the moment the file
    // appeared, which is the single condition doing its job.
    const html = await loginPage(origin)
    assert.equal(inputCount(html), 1, 'setup is over; the login form asks once')

    // A fresh browser signs in with the credential just chosen.
    const later = await submit(origin, { password: CREDENTIAL })
    assert.equal(later.status, 200, 'the credential set by the first visit works for a later login')
    assert.notEqual(sessionOf(later), undefined, 'which yields its own session')
    assert.equal((await submit(origin, { password: 'not the credential' })).status, 401, 'anything else does not')
  })

  // Outside the daemon: mount the same home again and log in with the same value, which
  // can only work if the file, not a process's memory, is what authenticates.
  const home = await temporaryHome()
  try {
    let daemon = await startDaemon(home)
    try {
      assert.equal((await submit(daemon.origin, { password: CREDENTIAL, confirm: CREDENTIAL })).status, 200)
    } finally {
      await daemon.close()
    }
    daemon = await startDaemon(home)
    try {
      const restarted = await submit(daemon.origin, { password: CREDENTIAL })
      assert.equal(restarted.status, 200, 'after a restart the credential from the file logs in')
      assert.equal(inputCount(await loginPage(daemon.origin)), 1, 'and the page is not a setup form again')
    } finally {
      await daemon.close()
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('once the file exists a setup request is just a wrong login', async () => {
  // The condition is the file, not a flag: the very next request after a successful
  // setup follows the login path. Offering setup again would be a second, quieter way
  // to replace a credential without proving the current one.
  await withDaemon({}, async ({ origin }) => {
    assert.equal((await submit(origin, { password: CREDENTIAL, confirm: CREDENTIAL })).status, 200)

    const replay = await submit(origin, { password: 'another credential entirely', confirm: 'another credential entirely' })
    assert.equal(replay.status, 401, 'a setup-shaped request is refused once a credential exists')
    assert.equal(sessionOf(replay), undefined)

    // The original credential still is the only one that works.
    assert.equal((await submit(origin, { password: CREDENTIAL })).status, 200)
  })
})

// --- both languages ----------------------------------------------------------

test('the setup form and its refusals are translated in both languages', async () => {
  // Every visible string goes through the dictionaries; a setup form that fell back to
  // English on a Chinese deployment is the kind of thing only a user notices.
  await withDaemon({}, async ({ origin }) => {
    const zh = await loginPage(origin, '/?lang=zh')
    assert.match(zh, /<html lang="zh-CN">/u)
    assert.match(zh, /新配对凭据/u, 'the Chinese page names the new credential in Chinese')
    assert.match(zh, /确认配对凭据/u, 'and its confirmation')
    assert.doesNotMatch(zh, /Confirm pairing credential/u, 'no English copy leaked in')
    assert.match(zh, /任何能打开这个页面的人/u, 'the trade-off is explained in Chinese too')

    const en = await loginPage(origin, '/?lang=en')
    assert.match(en, /<html lang="en">/u)
    assert.match(en, /New pairing credential/u)
    assert.match(en, /Confirm pairing credential/u)
    assert.doesNotMatch(en, /确认配对凭据/u, 'no Chinese copy leaked in')

    const tooShortZh = await submit(origin, { password: TOO_SHORT, confirm: TOO_SHORT }, '/api/auth.login?lang=zh')
    assert.equal(tooShortZh.status, 400)
    assert.match(String((await tooShortZh.json()).error), /至少需要 12 个字符/u, 'the Chinese refusal names the rule in Chinese')

    const mismatchEn = await submit(origin, { password: CREDENTIAL, confirm: `${CREDENTIAL}!` }, '/api/auth.login?lang=en')
    assert.equal(mismatchEn.status, 400)
    assert.match(String((await mismatchEn.json()).error), /do not match/iu)
  })
})

// --- the same flow under a mount prefix --------------------------------------

test('setup works under the mount the page is served from', async () => {
  // A prefixed deployment serves its UI from inside the mount, so the page's form action
  // carries the prefix and the daemon strips it before the auth layer sees it. The setup
  // form must be reached and answered through that same path, or an install on such a
  // deployment is impossible while the HTML still looks right.
  await withDaemon({ rootPrefix: '/main' }, async ({ home, origin }) => {
    const html = await loginPage(origin, '/main/')
    assert.equal(inputCount(html), 2, 'the prefixed page is the setup form')
    const action = html.match(/<form[^>]*action="([^"]+)"/u)?.[1]
    assert.ok(action?.startsWith('/main/api/auth.login'), `the setup form posts inside the mount, got ${action}`)

    const accepted = await fetch(`${origin}/main/api/auth.login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: CREDENTIAL, confirm: CREDENTIAL }),
    })
    assert.equal(accepted.status, 200, 'the prefixed setup endpoint accepts the credential')
    assert.notEqual(sessionOf(accepted), undefined, 'and signs the browser in')
    assert.notEqual(await readFile(credentialPath(home), 'utf8').catch(() => undefined), undefined)

    // The window closes here too: the same prefixed page is the login form now.
    assert.equal(inputCount(await loginPage(origin, '/main/')), 1)
  })
})
