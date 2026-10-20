/**
 * The daemon's authentication layer: one credential check, one session cookie.
 *
 * Deliberately smaller than the retired gateway package. That package's login
 * surface also carried a mobile preview, a settings editor and a paired-client
 * list; none of those answer "who may reach this origin", so they are not here.
 *
 * There is exactly one way in — the pairing credential in `pairing.json` — and
 * exactly one thing it buys: a session cookie. The session store keeps its
 * on-disk format, so existing session files survive the change.
 *
 * Wire format matches the shipped login page: it posts JSON to `/api/auth.login`
 * and reloads on `{ ok: true }`, so a failure is JSON too — never a rendered
 * error page, which the page could not display.
 *
 * @module @yiln-dsh/dsh-gateway/auth
 */

import { loginErrorMessage, renderLoginPage, selectLoginLocale } from './login-page.js'
import { PairingCredential } from './pairing-credential.js'
import { SessionStore } from './session-store.js'

/** The system clock, used unless a caller injects its own. */
const systemClock = () => Date.now()

/** Cookie carrying the daemon session. */
const COOKIE_NAME = 'dsh_daemon_session'
/** `__Host-` forces a secure, host-only cookie when the daemon is reached over TLS. */
const SECURE_COOKIE_NAME = '__Host-dsh_daemon_session'

/**
 * Build the authentication layer.
 *
 * @param options - credentials, storage location and cookie policy.
 * @param options.directory - directory holding the session and pairing stores.
 * @param options.password - seeds the pairing credential file when it does not exist
 *   yet; ignored once it does. Empty and no file is a startup error.
 * @param options.realm - realm shown on the login page.
 * @param options.sessionMaxAgeSeconds - absolute session lifetime.
 * @param options.sessionIdleSeconds - idle timeout.
 * @param options.now - clock the stores read their timestamps from; defaults to
 *   the system clock. Injecting one makes "when does a session expire" a
 *   deterministic question instead of a waiting game.
 * @param options.logger - diagnostic sink.
 * @returns the authentication surface used by the entry router.
 */
export function createAuth({
  directory,
  password,
  realm,
  sessionMaxAgeSeconds = 2_592_000,
  sessionIdleSeconds = 604_800,
  now = systemClock,
  logger,
}) {
  // First, before any store opens: the pairing credential is read (or bootstrapped
  // from `password`) here, so a missing or corrupt file stops the mount instead of
  // surfacing at the first login attempt.
  const pairing = new PairingCredential({ directory, password, now, logger })
  const sessions = new SessionStore({
    directory,
    maxAgeSeconds: sessionMaxAgeSeconds,
    idleTimeoutSeconds: sessionIdleSeconds,
    now,
    logger,
  })

  /**
   * Decide whether a request carries a live session.
   *
   * @param req - the incoming request.
   * @param secure - whether the browser reached the daemon over HTTPS.
   * @returns the session record, or undefined.
   */
  function session(req, secure) {
    const value = readCookie(req, secure ? SECURE_COOKIE_NAME : COOKIE_NAME)
      ?? readCookie(req, COOKIE_NAME)
    if (value === undefined) return undefined
    // The value is `<id>.<issuedAt>`: the store rejects a session whose issue
    // time does not match, so a stale cookie cannot revive a replaced session.
    const at = value.indexOf('.')
    if (at === -1) return undefined
    const id = value.slice(0, at)
    const issuedAt = Number(value.slice(at + 1))
    if (!Number.isSafeInteger(issuedAt)) return undefined
    const record = sessions.touch(id, issuedAt)
    return record === null ? undefined : record
  }

  /**
   * Answer the daemon's own authentication endpoints.
   *
   * @param req - the incoming request.
   * @param res - the response to write.
   * @param url - the raw request URL.
   * @param secure - whether the request arrived over TLS.
   * @returns true when this layer wrote the response.
   */
  async function handle(req, res, url, secure) {
    const path = url.split('?')[0]
    if (path === '/api/auth.login') return await login(req, res, url, secure)
    if (path === '/api/auth.logout') {
      const record = session(req, secure)
      if (record !== undefined) sessions.revoke(record.id)
      res.writeHead(303, { location: '/', 'set-cookie': [clearCookie(secure)], 'cache-control': 'no-store' })
      res.end()
      return true
    }
    if (path === '/api/auth.state') {
      const record = session(req, secure)
      json(res, 200, {
        ok: true,
        authenticated: record !== undefined,
        username: record?.username,
      })
      return true
    }
    return false
  }

  async function login(req, res, url, secure) {
    const locale = selectLoginLocale(req)
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: loginErrorMessage(locale, 'methodNotAllowed') }, { allow: 'POST' })
      return true
    }
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
      json(res, 415, { ok: false, error: loginErrorMessage(locale, 'contentType') })
      return true
    }
    let body
    try {
      body = await readJson(req)
    } catch {
      json(res, 400, { ok: false, error: loginErrorMessage(locale, 'invalidBody') })
      return true
    }
    // The stored hash is the only source of truth: the configured password seeded
    // the file once and is not consulted again. The pairing credential travels in
    // `password`, so the shipped login form keeps working.
    if (!(await pairing.verify(body.password ?? ''))) {
      json(res, 401, { ok: false, error: loginErrorMessage(locale, 'invalid') })
      return true
    }

    const record = sessions.create({
      address: req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
      secure,
    })
    json(res, 200, { ok: true }, { 'set-cookie': [sessionCookie(record, secure)] })
    return true
  }

  function sessionCookie(record, secure) {
    const name = secure ? SECURE_COOKIE_NAME : COOKIE_NAME
    return `${name}=${record.id}.${record.issuedAt}; Path=/; Max-Age=${sessions.cookieLifetimeSeconds(record)}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
  }

  function clearCookie(secure) {
    const name = secure ? SECURE_COOKIE_NAME : COOKIE_NAME
    return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
  }

  return {
    handle,
    session,
    /** Render the login page for a request that has no session. */
    loginPage(req) {
      return renderLoginPage(realm, selectLoginLocale(req), req.url ?? '/')
    },
  }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

function readCookie(req, name) {
  const header = req.headers.cookie
  if (typeof header !== 'string') return undefined
  for (const segment of header.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    if (segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('daemon: login body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
