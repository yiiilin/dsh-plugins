/**
 * The daemon's authentication layer: one credential check, one session cookie.
 *
 * Deliberately smaller than the retired gateway package. That package's login
 * surface also carried a mobile preview, a settings editor and a paired-client
 * list; none of those answer "who may reach this origin", so they are not here.
 *
 * The stores are reused unchanged, so existing session files, passkey records and
 * TOTP secrets keep their on-disk formats.
 *
 * Wire format matches the shipped login page: it posts JSON to `/api/auth.login`
 * and reloads on `{ ok: true }`, so a failure is JSON too — never a rendered
 * error page, which the page could not display.
 *
 * @module @yiln-dsh/dsh-gateway/auth
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server'
import { loginErrorMessage, renderLoginPage, selectLoginLocale } from './login-page.js'
import { PasskeyStore } from './passkey-store.js'
import { SessionStore } from './session-store.js'
import { verifyTotp } from './totp.js'

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
 * @param options.directory - directory holding the session and passkey stores.
 * @param options.username - the single accepted user name.
 * @param options.password - the accepted password; empty disables password login.
 * @param options.realm - realm shown on the login page.
 * @param options.twoFactorEnabled - require a TOTP code in addition to the password.
 * @param options.totpSecret - base32 TOTP secret; required when two-factor is on.
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
  username,
  password,
  realm,
  twoFactorEnabled = false,
  totpSecret = '',
  sessionMaxAgeSeconds = 2_592_000,
  sessionIdleSeconds = 604_800,
  passkeyOrigin = '',
  passkeyRpId = '',
  now = systemClock,
  logger,
}) {
  const sessions = new SessionStore({
    directory,
    maxAgeSeconds: sessionMaxAgeSeconds,
    idleTimeoutSeconds: sessionIdleSeconds,
    now,
    logger,
  })
  const passkeys = new PasskeyStore({ directory, now, logger })
  // Compare digests, never the configured text: a config dump must not be
  // replayable, and equal-length digests keep the comparison constant-time.
  const passwordDigest = password === '' ? undefined : digest(password)
  const usernameDigest = digest(username)

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
    if (path === '/api/auth.passkey.login.options') {
      await passkeyOptions(req, res)
      return true
    }
    if (path === '/api/auth.passkey.login.verify') {
      await passkeyVerify(req, res, secure)
      return true
    }
    if (path === '/api/auth.state') {
      const record = session(req, secure)
      json(res, 200, {
        ok: true,
        authenticated: record !== undefined,
        username: record?.username,
        twoFactorEnabled,
        passkeyAvailable: passkeys.hasAny(),
      })
      return true
    }
    return false
  }

  /**
   * Resolve the WebAuthn origin and RP ID for a request.
   *
   * A passkey is bound to the origin the browser shows, so behind a proxy that
   * terminates TLS the derived origin would be the wrong one. A configured
   * `passkeyOrigin` therefore wins, and the RP ID follows it rather than the
   * request's Host header.
   */
  function passkeyContext(req, secure) {
    const host = String(req.headers.host ?? '')
    if (host === '') throw new Error('a valid Host is required for passkeys')
    const origin = passkeyOrigin !== ''
      ? passkeyOrigin
      : new URL(`${secure ? 'https' : 'http'}://${host}`).origin
    const rpId = String(passkeyRpId === '' ? new URL(origin).hostname : passkeyRpId).trim()
    if (rpId === '') throw new Error('passkey RP configuration is invalid')
    return { origin, rpId }
  }

  async function passkeyOptions(req, res) {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'Method not allowed' }, { allow: 'POST' })
      return
    }
    if (!passkeys.hasAny()) {
      json(res, 404, { ok: false, error: 'No passkeys are registered' })
      return
    }
    try {
      const secure = isSecure(req)
      const { origin, rpId } = passkeyContext(req, secure)
      const options = await generateAuthenticationOptions({
        rpID: rpId,
        allowCredentials: passkeys.list().map((entry) => ({ id: entry.id, transports: entry.transports })),
        userVerification: 'required',
        timeout: 60_000,
      })
      passkeys.createChallenge({
        purpose: 'login',
        challenge: options.challenge,
        rpId,
        origin,
        address: req.socket?.remoteAddress,
      })
      json(res, 200, { ok: true, challenge: options.challenge, options })
    } catch (error) {
      logger?.warn?.(`daemon: passkey options failed: ${error.message}`)
      json(res, 400, { ok: false, error: error.message })
    }
  }

  async function passkeyVerify(req, res, secure) {
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: 'Method not allowed' }, { allow: 'POST' })
      return
    }
    let body
    try {
      body = await readJson(req)
    } catch {
      json(res, 400, { ok: false, error: 'Invalid request body' })
      return
    }
    const pending = passkeys.consumeChallenge(body.challenge, 'login', { address: req.socket?.remoteAddress })
    const credentialId = body.response?.id
    const credential = typeof credentialId === 'string' && pending !== null
      ? passkeys.credential(credentialId)
      : null
    if (pending === null || credential === null) {
      json(res, 401, { ok: false, error: 'Passkey verification failed' })
      return
    }
    let verification
    try {
      verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: pending.challenge,
        expectedOrigin: pending.origin,
        expectedRPID: pending.rpId,
        credential,
        requireUserVerification: true,
      })
    } catch (error) {
      // The browser only learns "failed"; the reason belongs in the log, because
      // a mismatched origin and a stale counter are fixed in different places.
      logger?.warn?.(`daemon: passkey verify threw for ${credentialId.slice(0, 12)} (origin=${pending.origin}): ${error.message}`)
      json(res, 401, { ok: false, error: 'Passkey verification failed' })
      return
    }
    if (!verification.verified) {
      logger?.warn?.(`daemon: passkey refused for ${credentialId.slice(0, 12)} (origin=${pending.origin} rpId=${pending.rpId})`)
      json(res, 401, { ok: false, error: 'Passkey verification failed' })
      return
    }
    const info = verification.authenticationInfo
    if (!passkeys.updateAuthentication(credentialId, info.newCounter, info.credentialDeviceType, info.credentialBackedUp)) {
      json(res, 503, { ok: false, error: 'Passkey state could not be persisted' })
      return
    }
    // A passkey proves identity on its own, so it mints a session without the
    // password — which is what makes it the recovery path when the password is
    // unusable.
    const record = sessions.create({
      username,
      address: req.socket?.remoteAddress,
      userAgent: req.headers['user-agent'],
      secure,
    })
    json(res, 200, { ok: true, username }, { 'set-cookie': [sessionCookie(record, secure)] })
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
    if (passwordDigest === undefined) {
      json(res, 403, { ok: false, error: loginErrorMessage(locale, 'invalid') })
      return true
    }
    const usernameOk = safeEqual(digest(body.username ?? ''), usernameDigest)
    const passwordOk = safeEqual(digest(body.password ?? ''), passwordDigest)
    // Both comparisons always run: returning early on a bad user would make the
    // response time distinguish an unknown user from a wrong password.
    if (!usernameOk || !passwordOk) {
      json(res, 401, { ok: false, error: loginErrorMessage(locale, 'invalid') })
      return true
    }
    if (twoFactorEnabled) {
      const code = String(body.otp ?? '').replace(/\s+/gu, '')
      if (totpSecret === '' || !verifyTotp(totpSecret, code)) {
        json(res, 401, { ok: false, error: loginErrorMessage(locale, 'invalid') })
        return true
      }
    }

    const record = sessions.create({
      username,
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
    sessions,
    passkeys,
    twoFactorEnabled,
    realm,
    /** Render the login page for a request that has no session. */
    loginPage(req) {
      return renderLoginPage(realm, twoFactorEnabled, selectLoginLocale(req), req.url ?? '/', passkeys.hasAny())
    },
  }
}

function isSecure(req) {
  if (req.socket?.encrypted === true) return true
  const forwarded = req.headers['x-forwarded-proto']
  return typeof forwarded === 'string' && forwarded.split(',')[0].trim() === 'https'
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest()
}

function safeEqual(left, right) {
  return left.length === right.length && timingSafeEqual(left, right)
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
