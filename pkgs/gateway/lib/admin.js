/**
 * The daemon's control surface.
 *
 * Split by role: the main node manages a list of environments; an edge has no list, so
 * those routes answer 404 there. Every route is wrapped so a thrown error becomes a 500
 * response — an unhandled rejection would take the whole daemon, and with it the panel
 * the operator needs to see what broke.
 *
 * Two routes are answered on both roles because neither is about federation: the session
 * overview (`GET /admin/sessions`) and the credential change (`POST /admin/credential`).
 * An edge has its own login and its own sessions, so an operator who suspects that
 * machine's credential leaked must be able to fix it there rather than from the main
 * node. Both answer through the auth layer, which owns the stores; this router only
 * decides the request shape and the words of the refusal.
 *
 * @module @yiln-dsh/dsh-gateway/admin
 */

import { PAIRING_CREDENTIAL_MIN_LENGTH } from './auth/pairing-credential.js'
import { validateMessageRequest } from './agent-message.js'
import { listSessions, listWorkspaces } from './remote-info.js'
import { describeTransfer, readTransferChunk } from './file-transfer.js'
import { deriveId, freshToken, normalizeEnvironment } from './registry.js'

/** How long a tunnel status stays cached, so a panel refresh is not a probe storm. */
const STATUS_TTL_MS = 5_000

/**
 * How long one relayed question may take before it is reported as timed out.
 *
 * Long enough that a busy edge still answers, short enough that a hung one stops being
 * the table's problem. Injectable so a test can make the same question fail quickly.
 */
const RELAY_TIMEOUT_MS = 30_000

/**
 * The id the session overview gives this node's own sessions.
 *
 * `self` is a reserved environment id, so no registered environment can be mistaken for
 * the node the panel is being read on: the id alone answers "which node".
 */
const SELF_NODE_ID = 'self'

export function createAdmin({
  registry, hub, config, profileSelf, inventory, readModel, readModelRows, writeModel, sessions,
  changeCredential, logger, relayTimeoutMs = RELAY_TIMEOUT_MS, deliverMessage,
  remoteInfo = {},
}) {
  /** id -> `{ at, value }` for the last known connection state. */
  const statusCache = new Map()

  const status = (environment) => {
    const online = hub.isOnline(environment.id)
    if (online) {
      statusCache.set(environment.id, { at: Date.now(), online })
      return { online, lastSeen: Date.now() }
    }
    const cached = statusCache.get(environment.id)
    if (cached !== undefined && Date.now() - cached.at < STATUS_TTL_MS) {
      return { online: cached.online, lastSeen: environment.lastSeen }
    }
    return { online: false, lastSeen: environment.lastSeen }
  }

  const describe = (environment) => {
    const { online, lastSeen } = status(environment)
    return {
      id: environment.id,
      label: environment.label,
      enabled: environment.enabled,
      hostname: environment.hostname,
      machineId: environment.machineId,
      online,
      lastSeen,
      // No fragment of the token leaves this node. A six-character prefix used to be
      // sent so the panel could tell two environments apart, but the panel stopped
      // rendering it, and a slice of a secret that nothing reads is only a leak.
    }
  }

  /**
   * Ask one environment for the sessions it holds, over its tunnel.
   *
   * Never throws and never omits the node: a machine that is offline, slow or broken is
   * still a row in the answer, saying which of those it is. Dropping it would make an
   * unreachable node look like a node with nothing on it — the one reading this view
   * exists to prevent.
   *
   * @param environment - the registry record to ask.
   * @returns one node envelope; `sessions` is present only when the node answered.
   */
  async function askNode(environment) {
    const node = { id: environment.id, role: 'edge', label: environment.label }
    if (!hub.isOnline(environment.id)) {
      return { ...node, state: 'offline', error: `environment "${environment.id}" is offline` }
    }
    // The same read-only route this process answers, reached the way every other
    // environment call is: one HTTP request into the tunnel, with its own timeout.
    const answer = await relay(
      hub,
      environment.id,
      { method: 'GET', path: '/admin/sessions', headers: {} },
      relayTimeoutMs,
    )
    if (answer?.timeout === true) return { ...node, state: 'timeout', error: answer.error }
    if (answer?.ok !== true) {
      return { ...node, state: 'error', error: String(answer?.error ?? 'the environment answered nothing') }
    }
    // The edge answers the same envelope for itself, tagged `self` there. That tag is
    // local to the edge, so the entry is retagged with the id and label this registry
    // knows it by — the panel must name the node the way the environment list does.
    const own = Array.isArray(answer.nodes)
      ? answer.nodes.find((entry) => entry.id === SELF_NODE_ID)
      : undefined
    if (own === undefined || !Array.isArray(own.sessions)) {
      return { ...node, state: 'error', error: 'the environment answered without its own sessions' }
    }
    return { ...node, state: 'ok', sessions: own.sessions }
  }

  /**
   * Every node's live sessions, grouped by the node they are on.
   *
   * A per-node envelope rather than one flat list: an offline node has to stay visible
   * *as a node*, and a flat list could only express its absence as "no rows", which
   * reads exactly like a node nobody is signed in on.
   *
   * The environments are asked in parallel and none of them is awaited in turn, so the
   * table costs one relay timeout in the worst case, not one per unreachable machine.
   *
   * @param sessionId - the session asking, marked `current` on this node.
   * @returns `{ ok, partial, nodes }`; `partial` is true when any node did not answer.
   */
  async function overview(sessionId) {
    const self = { id: SELF_NODE_ID, role: config.role, state: 'ok', sessions: sessions(sessionId) }
    // An edge manages no environments, so its overview is itself: that is the answer the
    // main node relays into the table, and it is also what an operator reading the edge
    // directly should see.
    if (config.role !== 'main') return { ok: true, partial: false, nodes: [self] }
    const nodes = await Promise.all([self, ...registry.list().map(askNode)])
    return { ok: true, partial: nodes.some((node) => node.state !== 'ok'), nodes }
  }

  return async function admin(req, res, url, sessionId) {
    try {
      return await route(req, res, url, sessionId)
    } catch (error) {
      logger.warn(`daemon: ${req.method} ${url} failed: ${error.message}`)
      if (!res.headersSent) {
        json(res, 500, { ok: false, error: String(error?.message ?? error) })
      } else {
        res.destroy()
      }
      return true
    }
  }

  async function route(req, res, url, sessionId) {
    const method = req.method ?? 'GET'
    const pathname = url.split('?')[0]

    if (pathname === '/admin/state' && method === 'GET') {
      json(res, 200, {
        ok: true,
        role: config.role,
        host: config.host,
        port: config.port,
        self: profileSelf === undefined ? undefined : profileSelf(),
        environments: config.role === 'main' ? registry.list().map(describe) : [],
      })
      return true
    }

    if (pathname === '/admin/model' && method === 'GET') {
      json(res, 200, { ok: true, model: await readModel() })
      return true
    }

    if (pathname === '/admin/model' && method === 'POST') {
      const body = await readJson(req)
      if (typeof body.rows !== 'string' || body.rows.trim() === '') {
        json(res, 400, { ok: false, error: 'rows is required' })
        return true
      }
      const result = await writeModel(body.rows, { syncCredentials: body.syncCredentials === true, credentials: body.credentials })
      json(res, result.ok ? 200 : 500, result)
      return true
    }

    if (pathname === '/admin/inventory' && method === 'GET') {
      json(res, 200, { ok: true, inventory: await inventory() })
      return true
    }

    if (pathname === '/admin/agent-message') {
      // Reachable only from another environment: `local()` answers an `/admin` request
      // that carries this node's federation token before the browser session gate, and
      // the hub fills `fromEnvId` from the connection rather than the body. A browser
      // that somehow sent this would still have to be signed in, and would then be
      // rejected below for having no `fromEnvId` — that caller is a peer node, not a
      // person.
      if (method !== 'POST') {
        json(res, 405, { ok: false, error: `${method} is not supported on ${pathname}` }, { allow: 'POST' })
        return true
      }
      const body = await readJson(req)
      const fromEnvId = typeof body.fromEnvId === 'string' ? body.fromEnvId.trim() : ''
      if (fromEnvId === '') {
        json(res, 400, { ok: false, error: 'agent-message requires the sending node to identify itself' })
        return true
      }
      const checked = validateMessageRequest({
        sessionId: body.sessionId,
        text: body.text,
      })
      if (checked.ok !== true) {
        json(res, 400, { ok: false, error: checked.error })
        return true
      }
      if (deliverMessage === undefined) {
        json(res, 501, { ok: false, error: 'this node cannot deliver agent messages' })
        return true
      }
      const result = await deliverMessage({
        fromEnvId,
        fromSessionId: typeof body.fromSessionId === 'string' ? body.fromSessionId : '',
        sessionId: checked.value.sessionId,
        text: checked.value.text,
      })
      json(res, result.ok === true ? 200 : 502, result)
      return true
    }

    if (pathname === '/admin/workspaces') {
      // Read-only, and reachable only from a peer node (`local()` answers an `/admin`
      // request carrying this node's federation token before the browser gate).
      if (method !== 'GET') {
        json(res, 405, { ok: false, error: `${method} is not supported on ${pathname}` }, { allow: 'GET' })
        return true
      }
      json(res, 200, listWorkspaces({ workspaces: remoteInfo.workspaces }))
      return true
    }

    if (pathname === '/admin/remote-sessions') {
      if (method !== 'GET') {
        json(res, 405, { ok: false, error: `${method} is not supported on ${pathname}` }, { allow: 'GET' })
        return true
      }
      const workspaceId = new URL(`http://x${url}`).searchParams.get('workspaceId') ?? ''
      json(res, 200, await listSessions(remoteInfo, workspaceId))
      return true
    }

    if (pathname === '/admin/file') {
      // Read-only by design. A peer may *pull* a file from this node; nothing here lets
      // one node write into another, because a push decides something on a machine its
      // sender does not own. The pulling side applies the change locally, where the
      // consequences are its own.
      //
      // `describe` is metadata and answers JSON. `chunk` answers the piece as the
      // response body itself — raw bytes, or a zstd frame — so no encoding layer sits
      // between the file and the wire. Headers carry what a JSON envelope used to:
      // the encoding, the piece index, and whether this was the last one.
      if (method !== 'POST') {
        json(res, 405, { ok: false, error: `${method} is not supported on ${pathname}` }, { allow: 'POST' })
        return true
      }
      const body = await readJson(req)
      const action = typeof body.action === 'string' ? body.action : ''
      if (action === 'describe') {
        json(res, 200, await describeTransfer(body.path, { offset: body.offset, length: body.length }))
        return true
      }
      if (action === 'chunk') {
        const piece = await readTransferChunk({
          path: body.path,
          index: body.index,
          chunkBytes: body.chunkBytes,
          encoding: body.encoding,
          offset: body.offset,
          length: body.length,
        })
        if (piece.ok !== true) {
          json(res, 400, { ok: false, error: piece.error })
          return true
        }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(piece.data.length),
          'x-dsh-chunk-encoding': piece.encoding,
          'x-dsh-chunk-index': String(piece.index),
          'x-dsh-chunk-eof': piece.eof === true ? '1' : '0',
          'cache-control': 'no-store',
        })
        res.end(piece.data)
        return true
      }
      json(res, 400, { ok: false, error: 'action must be "describe" or "chunk"' })
      return true
    }

    if (pathname === '/admin/sessions') {
      // This route only reads. The one bulk revocation the daemon offers is the
      // credential change below, which signs out every session except the caller's;
      // withdrawing *one* session, on this node or through a tunnel, is a write across
      // nodes and needs a rollback story this surface does not have.
      if (method !== 'GET') {
        json(res, 405, { ok: false, error: `${method} is not supported on ${pathname}: sessions are read-only` }, { allow: 'GET' })
        return true
      }
      // Answered on both roles: an edge's answer is what the main node relays into its
      // own table, and it is also what a session view read on the edge directly shows.
      json(res, 200, await overview(sessionId))
      return true
    }

    if (pathname === '/admin/credential') {
      // Both roles own their own login, so both can change their own credential: an
      // edge is reached directly as well as through its tunnel, and an operator who
      // suspects the credential leaked should not have to go to the main node to fix it.
      if (method !== 'POST') {
        json(res, 405, { ok: false, error: `${method} is not supported on ${pathname}` }, { allow: 'POST' })
        return true
      }
      // The change is made *by a browser that stays signed in*, so the asking session is
      // not optional: without one there is nothing to keep, and a caller that cannot name
      // itself is not the operator at the panel. A request with no session reaches this
      // router only when it came in over a tunnel — a peer node, not the person whose
      // credential this is.
      if (sessionId === undefined) {
        json(res, 403, { ok: false, error: 'changing the pairing credential requires a signed-in session' })
        return true
      }
      const body = await readJson(req)
      const result = await changeCredential({
        // The session that asked. Passed through so the auth layer can leave exactly it
        // in force: nothing here filters sessions after the fact, because after a bulk
        // revoke the caller's own record is already gone.
        keepId: sessionId,
        // The same member names the setup form posts, so one client shape covers both
        // flows that set a credential.
        current: body.current,
        password: body.password,
        confirm: body.confirm,
      })
      if (result.ok === true) {
        // Success says only that it succeeded. No fragment, no timestamp, no hint: the
        // panel has no business holding any part of the credential, and a value here
        // would end up in a browser's memory and a screenshot.
        json(res, 200, { ok: true })
        return true
      }
      if (result.reason === 'invalid') {
        // 403, not 401: the session is genuine and authenticated the request — what is
        // missing is the proof that the caller holds the credential it is replacing. A
        // 401 would invite a browser to treat this as "log in again", which is the one
        // thing a failed change must not do.
        json(res, 403, { ok: false, error: 'the current pairing credential is not correct' })
        return true
      }
      if (result.reason === 'empty' || result.reason === 'tooShort' || result.reason === 'mismatch') {
        const error = result.reason === 'empty'
          ? 'the new pairing credential must not be empty'
          : result.reason === 'tooShort'
            ? `the new pairing credential must be at least ${PAIRING_CREDENTIAL_MIN_LENGTH} characters`
            : 'the new pairing credential and its confirmation do not match'
        json(res, 400, { ok: false, error })
        return true
      }
      json(res, 500, { ok: false, error: 'the pairing credential could not be written' })
      return true
    }

    // Everything below belongs to the main node. An edge owns no other machines.
    if (config.role !== 'main') {
      json(res, 404, { ok: false, error: 'this daemon is an edge; it manages no environments' })
      return true
    }

    if (pathname === '/admin/environments' && method === 'POST') {
      const body = await readJson(req)
        // The id is a node identifier and the label is a name: they are generated and
        // supplied separately, so renaming a machine never moves its URL.
        const id = deriveId(registry.usedIds())
        const label = typeof body.label === "string" ? body.label.trim() : ""
        if (label === "") {
          json(res, 400, { ok: false, error: "label is required: it is the name this machine is shown under" })
          return true
        }
        const token = freshToken()
        const environment = normalizeEnvironment({
          id,
          label,
          token,
          enabled: body.enabled === undefined ? true : body.enabled === true,
        })
      await registry.add(environment)
      logger.info(`daemon: created environment "${id}"`)
      // The token is shown exactly once: it is the edge's credential and the file that
      // holds it is not meant to be read by hand.
      json(res, 201, { ok: true, environment: describe(environment), token })
      return true
    }

    const match = /^\/admin\/environments\/([a-z][a-z0-9-]{0,31})$/u.exec(pathname)
    if (match !== null) {
      const id = match[1]
      const environment = registry.find(id)
      if (environment === undefined) {
        json(res, 404, { ok: false, error: `unknown environment "${id}"` })
        return true
      }
      if (method === 'GET') {
        json(res, 200, { ok: true, environment: describe(environment) })
        return true
      }
      if (method === 'PATCH') {
        const body = await readJson(req)
        const patch = {}
        if (body.label !== undefined) {
          const label = String(body.label).trim()
        if (label === '') {
            json(res, 400, { ok: false, error: 'label must not be empty' })
            return true
          }
          patch.label = label
        }
        if (body.enabled !== undefined) patch.enabled = body.enabled === true
        if (Object.keys(patch).length === 0) {
          json(res, 400, { ok: false, error: 'nothing to update (editable: label, enabled)' })
          return true
        }
        const updated = await registry.update(id, patch)
        json(res, 200, { ok: true, environment: describe(updated) })
        return true
      }
      if (method === 'DELETE') {
        await registry.remove(id)
        statusCache.delete(id)
        logger.info(`daemon: removed environment "${id}"`)
        json(res, 200, { ok: true })
        return true
      }
      json(res, 405, { ok: false, error: `${method} is not supported on ${pathname}` })
      return true
    }

    const remote = /^\/admin\/environments\/([a-z][a-z0-9-]{0,31})\/inventory$/u.exec(pathname)
    if (remote !== null && method === 'GET') {
      const id = remote[1]
      if (registry.find(id) === undefined) {
        json(res, 404, { ok: false, error: `unknown environment "${id}"` })
        return true
      }
      if (!hub.isOnline(id)) {
        json(res, 503, { ok: false, error: `environment "${id}" is offline` })
        return true
      }
      // The edge's own daemon answers this, over the tunnel: only it knows its layout.
      const answer = await askInventory(hub, id)
      json(res, answer.ok ? 200 : 502, answer)
      return true
    }

    const remoteModel = /^\/admin\/environments\/([a-z][a-z0-9-]{0,31})\/model$/u.exec(pathname)
    if (remoteModel !== null) {
      const id = remoteModel[1]
      if (registry.find(id) === undefined) {
        json(res, 404, { ok: false, error: `unknown environment "${id}"` })
        return true
      }
      if (!hub.isOnline(id)) {
        json(res, 503, { ok: false, error: `environment "${id}" is offline` })
        return true
      }
      if (method === 'GET') {
        const answer = await relay(hub, id, { method: 'GET', path: '/admin/model', headers: {} })
        json(res, answer.ok ? 200 : 502, answer)
        return true
      }
      if (method === 'POST') {
        const body = await readJson(req)
        // `push: true` means "send this node's own model rows"; anything else carries its
        // own `rows`, which lets a caller send a config that exists nowhere yet.
        const rows = body.push === true ? await readModelRows() : body.rows
        if (typeof rows !== 'string' || rows.trim() === '') {
          json(res, 400, { ok: false, error: 'rows is required, or pass push: true' })
          return true
        }
        const answer = await relay(hub, id, {
          method: 'POST',
          path: '/admin/model',
          headers: { 'content-type': 'application/json' },
          body: { rows, syncCredentials: body.syncCredentials === true },
        })
        json(res, answer.ok ? 200 : 502, answer)
        return true
      }
      json(res, 405, { ok: false, error: `${method} is not supported here` })
      return true
    }

    const rotate = /^\/admin\/environments\/([a-z][a-z0-9-]{0,31})\/token$/u.exec(pathname)
    if (rotate !== null && method === 'POST') {
      const id = rotate[1]
      const environment = registry.find(id)
      if (environment === undefined) {
        json(res, 404, { ok: false, error: `unknown environment "${id}"` })
        return true
      }
      const token = freshToken()
      await registry.update(id, { token })
      logger.info(`daemon: rotated the token for "${id}"`)
      json(res, 200, { ok: true, token })
      return true
    }

    json(res, 404, { ok: false, error: `no such route: ${pathname}` })
    return true
  }
}

/**
 * Ask an environment's own daemon for its inventory.
 *
 * A plain HTTP request into the tunnel rather than a bespoke frame type: the tunnel
 * already carries HTTP, and adding a second protocol for one call would be a second
 * thing to keep in sync. `/admin/inventory` is daemon-owned on the edge, so the request
 * never reaches the edge's harness or its login.
 *
 * @returns `{ ok: true, inventory }` or `{ ok: false, error }`.
 */
function askInventory(hub, envId) {
  return relay(hub, envId, { method: 'GET', path: '/admin/inventory', headers: {} }).then((answer) => (
    answer.ok ? answer : { ok: false, error: answer.error }
  ))
}

/**
 * Make one request into an environment over its tunnel.
 *
 * A plain HTTP request rather than a bespoke frame type: the tunnel already carries HTTP,
 * and a second protocol for internal calls would be a second thing to keep in sync.
 *
 * @param hub - the tunnel hub.
 * @param envId - the environment to reach.
 * @param request - `{ method, path, headers, body? }`; a body is JSON-encoded.
 * @param timeoutMs - how long to wait before giving up on the environment.
 * @returns the parsed JSON answer, or `{ ok: false, error }`. A timeout is flagged
 *   `{ ok: false, timeout: true }` so a caller can tell a slow node from a broken one.
 */
function relay(hub, envId, request, timeoutMs = RELAY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const settled = { done: false, body: '' }
    const finish = (value) => {
      if (settled.done) return
      settled.done = true
      resolve(value)
    }
    const timer = setTimeout(
      () => finish({ ok: false, timeout: true, error: 'the environment did not answer in time' }),
      timeoutMs,
    )
    try {
      const sent = hub.request(envId, {
        method: request.method,
        path: request.path,
        headers: { ...request.headers, 'x-dsh-federation': request.token ?? '' },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      }, {
        onBody(chunk) {
          settled.body += chunk.toString('utf8')
        },
        onEnd() {
          clearTimeout(timer)
          try {
            finish(JSON.parse(settled.body === '' ? '{}' : settled.body))
          } catch {
            finish({ ok: false, error: 'the environment answered something that is not JSON' })
          }
        },
        onError(error) {
          clearTimeout(timer)
          finish({ ok: false, error: String(error?.message ?? error) })
        },
      })
      // A refused send never reaches any handler, so waiting for the timeout would turn
      // "this tunnel is already gone" into a 30-second wait for nothing.
      if (sent === false) {
        clearTimeout(timer)
        finish({ ok: false, error: `environment "${envId}" is not connected` })
      }
    } catch (error) {
      clearTimeout(timer)
      finish({ ok: false, error: String(error?.message ?? error) })
    }
  })
}

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(body)
}

/**
 * Read one JSON body.
 *
 * @param req - the request.
 * @param limitBytes - largest body accepted. Control payloads are small; a file transfer
 *   legitimately carries megabytes, so the file route raises this rather than sharing a
 *   limit that is right for neither.
 * @returns the parsed body.
 */
function readJson(req, limitBytes = 256 * 1024) {
  return new Promise((done, fail) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        fail(new Error('daemon: request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        done({})
        return
      }
      try {
        done(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        fail(new Error(`daemon: invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', fail)
  })
}
