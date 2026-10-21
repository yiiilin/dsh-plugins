/**
 * The daemon's authentication layer: one credential check, one session cookie.
 *
 * Deliberately smaller than the retired gateway package. That package's login
 * surface also carried a mobile preview, a settings editor and a paired-client
 * list; none of those answer "who may reach this origin", so they are not here.
 *
 * There is exactly one way in — the pairing credential in `pairing.json`, read from
 * that file and nowhere else — and exactly one thing it buys: a session cookie.
 * Sessions are minted under an authentication epoch (`SESSION_AUTH_EPOCH` in the
 * store), so changing the way in invalidates the cookies the previous model handed
 * out instead of leaving them to stand for a credential that no longer exists.
 *
 * When that file does not exist the layer does not fail: the login page becomes the
 * first-time setup form, and `POST /api/auth.login` writes the credential and signs
 * the browser in on the same request. The one condition for that shape is the file's
 * absence — a fresh install and a deleted file are the same state — and the setup
 * endpoint is deliberately not restricted by source address. That trade-off (LAN-wide
 * installability bought with an open window whenever the file is gone) is documented
 * at the top of `pairing-credential.js` and in the package README.
 *
 * The layer also reports which sessions exist ({@link createAuth} returns
 * `sessions`): "who is signed in" is a question about authentication, and the store
 * already holds the answer. The view is read-only — revoking a named session is a
 * write across nodes and is not part of this surface.
 *
 * The one write this surface does own is {@link createAuth}'s `changeCredential`: the
 * pairing credential can be replaced by a caller that presents both the current and the
 * new value, and because a credential change must take effect at once, every session
 * except the asking one is revoked with it. The two halves belong to two stores this
 * module holds, so neither is reachable from the caller that asks for the change.
 *
 * Wire format matches the shipped login page: it posts JSON to `/api/auth.login`
 * and reloads on `{ ok: true }`, so a failure is JSON too — never a rendered
 * error page, which the page could not display.
 *
 * @module @yiln-dsh/dsh-gateway/auth
 */

import { loginErrorMessage, renderLoginPage, selectLoginLocale } from './login-page.js'
import { PAIRING_CREDENTIAL_MIN_LENGTH, PairingCredential, pairingCredentialProblem } from './pairing-credential.js'
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
 * @param options - credential storage location and cookie policy.
 * @param options.directory - directory holding the session and pairing stores.
 * @param options.realm - realm shown on the login page.
 * @param options.sessionMaxAgeSeconds - absolute session lifetime.
 * @param options.sessionIdleSeconds - idle timeout.
 * @param options.now - clock the stores read their timestamps from; defaults to
 *   the system clock. Injecting one makes "when does a session expire" a
 *   deterministic question instead of a waiting game.
 * @param options.logger - diagnostic sink.
 * @param options.rootPrefix - the mount prefix the daemon serves its own UI under.
 *   The login page is reached at arbitrary paths, so its PWA asset URLs are built
 *   from this value — the same value the asset routes are built from.
 * @returns the authentication surface used by the entry router.
 */
export function createAuth({
  directory,
  realm,
  sessionMaxAgeSeconds = 2_592_000,
  sessionIdleSeconds = 604_800,
  now = systemClock,
  rootPrefix = '',
  logger,
}) {
  // First, before any store opens: the pairing credential is read here, so a corrupt
  // file stops the mount instead of surfacing at the first login attempt. A missing
  // file does not stop it: that is the state the login page guides the visitor out of
  // by setting one. Nothing seeds it — the file is the only source of the credential.
  const pairing = new PairingCredential({ directory, now, logger })
  const store = new SessionStore({
    directory,
    maxAgeSeconds: sessionMaxAgeSeconds,
    idleTimeoutSeconds: sessionIdleSeconds,
    now,
    logger,
  })

  /**
   * Decide whether a request carries a live session, and keep the browser's cookie
   * alive when it is falling behind.
   *
   * The browser's copy of the cookie carries a `Max-Age` fixed at the moment it was
   * issued, while the server's deadline slides forward with every accepted request.
   * Without a re-issue the two drift apart and an actively used browser is signed
   * out at the lifetime it was given at login — a window the session itself never
   * reached. So an accepted request that finds the cookie due re-issues it.
   *
   * `res` is optional: the caller that only wants to know who is asking can leave it
   * out, and then nothing is written.
   *
   * @param req - the incoming request.
   * @param secure - whether the browser reached the daemon over HTTPS.
   * @param res - the response to re-issue the cookie on, when it is due.
   * @returns the session record, or undefined.
   */
  function session(req, secure, res) {
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
    const record = store.touch(id, issuedAt)
    if (record === null) return undefined
    if (res !== undefined && store.cookieRenewalDue(record)) {
      store.markCookieRenewed(record)
      res.setHeader?.('set-cookie', sessionCookie(record, secure))
    }
    return record
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
      if (record !== undefined) store.revoke(record.id)
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

  /**
   * Every answer the login endpoint gives, in the page's language.
   *
   * @param locale - the locale the page will read the answer in.
   * @param res - the response to write.
   * @param status - HTTP status.
   * @param key - dictionary key of the message.
   * @param values - placeholders the message substitutes.
   */
  function refuse(locale, res, status, key, values) {
    json(res, status, { ok: false, error: loginErrorMessage(locale, key, values) })
    return true
  }

  /**
   * Answer the login endpoint: verify a credential, or set one when none exists.
   *
   * Which of the two it is has exactly one condition — whether the credential file
   * exists — so a first install and a deployment whose file was deleted follow the
   * same path. In the set-up case the request must carry the new credential twice;
   * a mismatch, an empty value or one below the minimum is refused *before* anything
   * is written, so a failed attempt leaves no credential behind. On success the file
   * is written and the browser that submitted it is signed in on the same response,
   * because asking it to log in again with the credential it just chose is a second
   * step that buys nothing.
   *
   * @param req - the incoming request.
   * @param res - the response to write.
   * @param url - the raw request URL, whose `lang` picks the message language.
   * @param secure - whether the request arrived over TLS.
   * @returns true, once the endpoint has answered.
   */
  async function login(req, res, url, secure) {
    const locale = selectLoginLocale(req)
    if (req.method !== 'POST') {
      json(res, 405, { ok: false, error: loginErrorMessage(locale, 'methodNotAllowed') }, { allow: 'POST' })
      return true
    }
    if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
      return refuse(locale, res, 415, 'contentType')
    }
    let body
    try {
      body = await readJson(req)
    } catch {
      return refuse(locale, res, 400, 'invalidBody')
    }
    if (body === null || typeof body !== 'object') return refuse(locale, res, 400, 'invalidBody')

    if (!pairing.configured) {
      const submitted = body.password ?? ''
      const problem = pairingCredentialProblem(submitted)
      if (problem === 'empty') return refuse(locale, res, 400, 'empty')
      if (problem === 'tooShort') {
        return refuse(locale, res, 400, 'tooShort', { min: PAIRING_CREDENTIAL_MIN_LENGTH })
      }
      // The confirmation is the form's guard against a typo locking the operator out.
      // It is checked here too, because a request that skips the page is not a reason
      // to accept one entry as if it had been typed twice.
      if (submitted !== (body.confirm ?? '')) return refuse(locale, res, 400, 'mismatch')
      try {
        await pairing.set(submitted)
      } catch (error) {
        logger?.warn?.(`daemon: could not write the pairing credential: ${error.message}`)
        return refuse(locale, res, 500, 'setupFailed')
      }
    } else if (!(await pairing.verify(body.password ?? ''))) {
      // The stored hash is the only source of truth: it is the whole of the
      // credential, and nothing else can be consulted. The pairing credential travels
      // in `password`, so the shipped login form keeps working.
      return refuse(locale, res, 401, 'invalid')
    }

    const record = store.create({
      address: req.socket.remoteAddress,
      userAgent: req.headers['user-agent'],
      secure,
    })
    json(res, 200, { ok: true }, { 'set-cookie': [sessionCookie(record, secure)] })
    return true
  }

  function sessionCookie(record, secure) {
    const name = secure ? SECURE_COOKIE_NAME : COOKIE_NAME
    return `${name}=${record.id}.${record.issuedAt}; Path=/; Max-Age=${store.cookieLifetimeSeconds(record)}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
  }

  function clearCookie(secure) {
    const name = secure ? SECURE_COOKIE_NAME : COOKIE_NAME
    return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`
  }

  return {
    handle,
    session,
    /**
     * Every live session on this node, as a display-ready projection.
     *
     * A session is what "who is signed in" means, so answering that question is the
     * auth layer's job rather than a caller's: the store already keeps the records
     * and knows which of them have expired, and its projection is exactly the field
     * set a panel needs — `id`, `address`, `userAgent`, `issuedAt`, `lastSeenAt`,
     * `expiresAt` and `current`.
     *
     * Read-only by construction: the returned value is a fresh array of plain objects
     * copied out of the store, so a caller cannot reach a live record, cannot revoke
     * one, and cannot mutate the store through what it was given. Expired sessions are
     * dropped by the store before the projection is built, so a vanished session is
     * absent rather than listed with a deadline in the past.
     *
     * @param currentId - id of the session asking, marked `current: true` in the
     *   result. Omit when the question comes from something that is not a session.
     * @returns one entry per live session, most recently active first.
     */
    sessions(currentId) {
      return store.list(currentId).map((session) => ({
        id: session.id,
        address: session.address,
        userAgent: session.userAgent,
        issuedAt: session.issuedAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        current: session.current,
      }))
    },
    /**
     * Replace the pairing credential, on behalf of one signed-in session.
     *
     * Both halves of a change live here because they belong to two stores this module
     * holds and to nobody else: the new credential is written (and the in-memory hash
     * swapped) by the credential store, and every *other* session is withdrawn by the
     * session store. Neither store is reachable from the caller, so a change cannot be
     * half-applied by a caller that stopped paying attention, and there is no order a
     * caller could choose in which the file says one thing and the sessions another.
     *
     * **The current credential is required, and is checked first.** A session is not
     * enough: sessions live for a long time by default, so a caller that could change
     * the credential on a session alone would turn one login into a permanent takeover.
     * The check runs before the new value is looked at, so a caller who does not hold
     * the current credential learns nothing about the rules for the new one.
     *
     * The new value is judged by the shared rule (`pairingCredentialProblem`), not by a
     * copy of it, and the confirmation is checked here as well as in the form: a request
     * that skips the form is not a reason to accept one entry as if it had been typed
     * twice. Every refusal happens before anything is written, so a rejected change
     * leaves the file exactly as it was.
     *
     * On success every session except `keepId` is revoked. The asking session has just
     * proved it holds both the old and the new credential, so signing it out would buy
     * nothing and cost a login; every other session is exactly what a leaked credential
     * left behind, and those must not survive the change by even one request.
     *
     * Nothing about the credential is returned — not its age, not a fragment, not
     * whether the new value differs from the old one. The caller learns success or which
     * input was refused, and nothing else.
     *
     * @param options - the request to carry out.
     * @param options.keepId - id of the session asking; the only one left in force.
     *   Omitted means every session is revoked, which is the safe direction: the caller
     *   that cannot name itself does not get to keep a session alive.
     * @param options.current - the credential in force now, as submitted.
     * @param options.password - the proposed new credential.
     * @param options.confirm - the proposal again, as the form's typo guard.
     * @returns `{ ok: true }`, or `{ ok: false, reason }` with `reason` one of
     *   `'invalid'` (the current credential is wrong), `'empty'`, `'tooShort'`,
     *   `'mismatch'` or `'writeFailed'`.
     */
    async changeCredential({ keepId, current, password, confirm } = {}) {
      if (!(await pairing.verify(current ?? ''))) return { ok: false, reason: 'invalid' }
      const problem = pairingCredentialProblem(password)
      if (problem !== undefined) return { ok: false, reason: problem }
      if (password !== (confirm ?? '')) return { ok: false, reason: 'mismatch' }
      try {
        await pairing.set(password)
      } catch (error) {
        // The write is atomic, so a failure here left the previous record on disk and
        // in memory: reporting it is the whole of the recovery, and no session is
        // withdrawn on a change that did not happen.
        logger?.warn?.(`daemon: could not change the pairing credential: ${error.message}`)
        return { ok: false, reason: 'writeFailed' }
      }
      if (!store.revokeAllExcept(keepId)) {
        // The credential is already replaced, so reporting a failed change here would be
        // worse than useless: the caller would retry with a current credential that no
        // longer exists. The records are gone in memory either way, so every other
        // browser is refused from this request on; only the file on disk still names
        // them, and only a restart could read it back. Saying that out loud is the one
        // recovery this layer has.
        logger?.warn?.(
          'daemon: the pairing credential changed but the session store could not be rewritten; a restart could revive the sessions this change revoked',
        )
      }
      return { ok: true }
    },
    /**
     * Render the login page for a request that has no session.
     *
     * The page's shape is decided here and nowhere else: `pairing.configured` is
     * "does the credential file exist", so the setup form appears exactly while it
     * does not. There is no other marker and no stored flag — a deleted file and a
     * fresh install are deliberately the same state.
     */
    loginPage(req) {
      return renderLoginPage(realm, selectLoginLocale(req), req.url ?? '/', rootPrefix, {
        setup: !pairing.configured,
      })
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
