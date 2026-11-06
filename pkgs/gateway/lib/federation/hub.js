/**
 * Main-node side of the federation tunnel.
 *
 * Edges dial out and keep one WebSocket each; this module turns browser requests into
 * frames on that socket and back. The main node never dials an edge, so an edge needs no
 * inbound port open.
 *
 * Trust model: the connection is authenticated once, by the environment token, and only
 * the edge can be on the other end of it. A request that arrives *from* an edge is
 * therefore already attributed to that environment — no cookie, header or signature is
 * consulted. That is why the edge can proxy straight to its harness without asking its
 * own user to log in again.
 *
 * @module @yiln-dsh/dsh-gateway/federation/hub
 */

import { WebSocketServer } from 'ws'
import { FRAME, FrameReader, encodeFrame, encodeJsonFrame, newRequestId } from './frames.js'
import { keepAlive } from './keepalive.js'

/** Path the edges connect to. */
export const TUNNEL_PATH = '/_tunnel'

/**
 * The environment id meaning "this node".
 *
 * Shared with the admin API's own overview, which reports this node under the same id,
 * so a caller that learned the id from one service can use it in the other.
 */
export const SELF_ENV_ID = 'self'

/**
 * Accept and manage edge connections.
 *
 * @param options.verifyToken - `(token) => environment | undefined`; resolves the
 *   environment an edge claims to be, or nothing when the token is unknown.
 * @param options.logger - logger.
 * @param options.deliver - `(message) => Promise<{ok, error?}>`; puts one message into a
 *   session **on this machine**. Supplied by the gateway so the tunnel stays a
 *   transport and never learns how a session is reached.
 * @param options.forward - `(toEnvId, message) => Promise<{ok, error?}>`; sends a message
 *   to another edge through this node. Absent on an edge, which forwards nothing.
 * @returns the hub: `accept`, `proxy`, `proxyUpgrade`, `request`, `sendAgentMessage`,
 *   `isOnline`, `ids`, `close`.
 */
export function createTunnelHub({ verifyToken, logger, deliver, forward, listEnvironments }) {
  /** envId -> connection record. */
  const connections = new Map()

  /**
   * Register one edge socket.
   *
   * @returns the connection record, or undefined when the token was rejected.
   */
  function register(environment, socket) {
    const record = {
      envId: environment.id,
      socket,
      reader: new FrameReader(),
      /** requestId(hex) -> handlers for an in-flight request. */
      pending: new Map(),
      openedAt: Date.now(),
    }

    // The main node watches too: an edge that vanishes without closing its socket would
    // otherwise stay listed as online forever, and `/env-<id>/` would answer 503 from a
    // record that claims the tunnel is up.
    keepAlive(socket, { label: record.envId, logger })

    socket.on('message', (data) => {
      let frames
      try {
        frames = record.reader.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
      } catch (error) {
        logger.warn(`federation: dropping ${record.envId}: ${error.message}`)
        socket.close()
        return
      }
      for (const frame of frames) dispatch(record, frame)
    })

    socket.on('close', () => {
      // Fail every request still in flight: the alternative is a browser waiting for a
      // response that can never arrive.
      for (const [, entry] of record.pending) entry.onClose?.()
      record.pending.clear()
      if (connections.get(record.envId) === record) connections.delete(record.envId)
      logger.info(`federation: ${record.envId} disconnected`)
    })

    socket.on('error', (error) => {
      logger.warn(`federation: ${record.envId} socket error: ${error.message}`)
    })

    // A reconnect replaces the previous socket: the old one is dead even if its close
    // event has not fired yet.
    const previous = connections.get(record.envId)
    if (previous !== undefined && previous !== record) {
      try {
        previous.socket.close()
      } catch {
        // The old socket is already gone; nothing to do.
      }
    }
    connections.set(record.envId, record)
    logger.info(`federation: ${record.envId} connected`)
    return record
  }

  function dispatch(record, frame) {
    if (frame.type === FRAME.heartbeat) return
    // An edge may only originate one thing, and it is not a pending request: handle it
    // before the `pending` lookup, which would otherwise count it as an orphan.
    if (frame.type === FRAME.agentMessage) {
      void receiveAgentMessage(record, frame)
      return
    }
    const key = frame.id.toString('hex')
    const entry = record.pending.get(key)
    if (entry === undefined) {
      // Not noise: a frame for a finished request means the browser is still talking
      // about something we already released, and a frame for a live request means the
      // key was lost early. Both deserve a name.
      record.orphans = (record.orphans ?? 0) + 1
      if (record.orphans <= 5) {
        logger.warn(`federation: ${record.envId} frame type ${frame.type} for unknown request ${key.slice(0, 8)}`)
      }
      return
    }
    if (frame.type === FRAME.responseHead) {
      entry.onHead(JSON.parse(frame.payload.toString('utf8')))
      return
    }
    if (frame.type === FRAME.responseBody) {
      entry.bytes = (entry.bytes ?? 0) + frame.payload.length
      entry.onBody(frame.payload)
      return
    }
    if (frame.type === FRAME.responseEnd) {
      if (entry.upgraded === true) {
        logger.info(`federation: upgrade relayed ${entry.bytes ?? 0} byte(s) to the browser`)
      }
      record.pending.delete(key)
      entry.onEnd()
    }
  }

  /**
   * Send one request into an edge and pipe the response back.
   *
   * @param envId - the environment to reach.
   * @param req - the browser's request.
   * @param res - the browser's response.
   * @param upstreamPath - path as the edge's harness should see it.
   * @returns whether the request could be sent.
   */
  function proxy(envId, req, res, upstreamPath) {
    const record = connections.get(envId)
    if (record === undefined) {
      logger.warn(`federation: ${envId} has no tunnel; answering 503`)
      return false
    }
    logger.info(`federation: ${envId} ${req.method} ${upstreamPath}`)

    const id = newRequestId()
    const key = id.toString('hex')
    // Host and Origin are rewritten on the edge, which is the only side that knows its
    // own harness authority.
    const headers = { ...req.headers }

    record.pending.set(key, {
      onHead(head) {
        res.writeHead(head.status, head.statusText, head.headers)
      },
      onBody(payload) {
        res.write(payload)
      },
      onEnd() {
        res.end()
      },
      onClose() {
        if (!res.writableEnded) res.destroy()
      },
    })

    record.socket.send(encodeJsonFrame(FRAME.requestHead, id, {
      method: req.method,
      path: upstreamPath,
      headers,
    }))
    req.on('data', (chunk) => record.socket.send(encodeFrame(FRAME.requestBody, id, chunk)))
    req.on('end', () => record.socket.send(encodeFrame(FRAME.requestEnd, id)))
    // The response's `close` means the browser is gone; the request's `close` also fires
    // when the body finishes, which is the normal case and must not cancel anything.
    res.on('close', () => {
      if (res.writableEnded) return
      if (record.pending.has(key)) {
        record.pending.delete(key)
        record.socket.send(encodeFrame(FRAME.cancel, id))
      }
    })
    return true
  }

  /**
   * Open a WebSocket through the tunnel.
   *
   * The edge performs the real handshake with its harness; this side only relays the
   * outcome to the browser and then copies bytes both ways. Doing it that way keeps the
   * harness's own origin and cookie checks in force.
   *
   * @param envId - the environment to reach.
   * @param req - the browser's upgrade request.
   * @param socket - the raw socket from the server's upgrade event.
   * @param head - bytes already read from the socket.
   * @param upstreamPath - path as the edge's harness should see it.
   * @returns whether the request could be sent.
   */
  function proxyUpgrade(envId, req, socket, head, upstreamPath) {
    const record = connections.get(envId)
    if (record === undefined) {
      logger.warn(`federation: ${envId} has no tunnel for an upgrade; answering 503`)
      return false
    }
    logger.info(`federation: ${envId} UPGRADE ${upstreamPath}`)

    const id = newRequestId()
    const key = id.toString('hex')
    let upgraded = false

    const entryRef = {
      onHead(head2) {
        entryRef.upgraded = true
        if (head2.status !== 101) {
          socket.end(`HTTP/1.1 ${head2.status} ${head2.statusText}\r\nconnection: close\r\n\r\n`)
          return
        }
        upgraded = true
        // `rawHeaders` is the harness's own block, so `Sec-WebSocket-Accept` is the value
        // it computed rather than one this proxy would have to invent.
        if (Array.isArray(head2.rawHeaders)) {
          const lines = [`HTTP/1.1 101 ${head2.statusText || 'Switching Protocols'}`]
          for (let i = 0; i + 1 < head2.rawHeaders.length; i += 2) {
            lines.push(`${head2.rawHeaders[i]}: ${head2.rawHeaders[i + 1]}`)
          }
          socket.write(`${lines.join('\r\n')}\r\n\r\n`)
          return
        }
        socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n')
      },
      onBody(payload) {
        if (upgraded) socket.write(payload)
      },
      onEnd() {
        if (upgraded) socket.end()
      },
      onClose() {
        socket.destroy()
      },
    }
    record.pending.set(key, entryRef)

    record.socket.send(encodeJsonFrame(FRAME.requestHead, id, {
      method: req.method,
      path: upstreamPath,
      headers: req.headers,
      upgrade: true,
    }))
    if (head !== undefined && head.length > 0) {
      record.socket.send(encodeFrame(FRAME.requestBody, id, head))
    }
    // After the 101, everything the browser sends is opaque bytes for the harness.
    socket.on('data', (chunk) => record.socket.send(encodeFrame(FRAME.requestBody, id, chunk)))
    // An upgraded socket arrives paused: attaching `data` alone never receives a byte.
    socket.resume()
    socket.on('close', () => {
      if (record.pending.delete(key)) record.socket.send(encodeFrame(FRAME.cancel, id))
    })
    socket.on('error', () => {
      if (record.pending.delete(key)) record.socket.send(encodeFrame(FRAME.cancel, id))
    })
    return true
  }

  /**
   * Send one request into an edge without a browser on the other end.
   *
   * Same frames as `proxy`, but the caller supplies handlers instead of a response
   * object — used by the main node to ask an environment about itself.
   *
   * @param envId - the environment to reach.
   * @param request - `{ method, path, headers, body? }`; a body is sent as one frame.
   * @param handlers - `{ onBody, onEnd, onError }`.
   * @returns whether the request could be sent.
   */
  function request(envId, req, handlers) {
    const record = connections.get(envId)
    if (record === undefined) return false
    const id = newRequestId()
    const key = id.toString('hex')
    record.pending.set(key, {
      onHead() {},
      onBody(payload) {
        handlers.onBody(payload)
      },
      onEnd() {
        handlers.onEnd()
      },
      onClose() {
        handlers.onError?.(new Error('the tunnel closed before the environment answered'))
      },
    })
    record.socket.send(encodeJsonFrame(FRAME.requestHead, id, {
      method: req.method,
      path: req.path,
      headers: req.headers,
    }))
    if (req.body !== undefined && req.body !== '') {
      record.socket.send(encodeFrame(FRAME.requestBody, id, Buffer.from(req.body, 'utf8')))
    }
    record.socket.send(encodeFrame(FRAME.requestEnd, id))
    return true
  }

  /**
   * Answer one edge's `agentMessage` frame.
   *
   * The sender is `record.envId` — taken from the connection, never from the payload —
   * so `fromEnvId` below cannot be forged by whoever wrote the frame. The reply is an
   * ordinary `responseHead`/`responseBody`/`responseEnd` trio on the same request id:
   * the edge's sender is waiting on that id like any other request.
   *
   * @param record - the connection the frame arrived on.
   * @param frame - the decoded frame.
   */
  async function receiveAgentMessage(record, frame) {
    let answer
    try {
      const payload = JSON.parse(frame.payload.toString('utf8'))
      if (payload?.kind === 'list-environments') {
        // The main node is the only one that knows the environment table, which is why
        // an edge asks rather than reading its own empty registry.
        answer = { ok: true, environments: listEnvironments?.() ?? [] }
        sendAgentAnswer(record, frame, answer)
        return
      }
      const message = {
        fromEnvId: record.envId,
        fromSessionId: typeof payload.fromSessionId === 'string' ? payload.fromSessionId : '',
        sessionId: payload.sessionId,
        text: payload.text,
      }
      const toEnvId = typeof payload.toEnvId === 'string' ? payload.toEnvId.trim() : ''
      if (toEnvId === record.envId) {
        // Forwarding a message back to its own sender is never what was meant, and it
        // would let a buggy edge keep a conversation with itself alive forever.
        answer = { ok: false, error: `an environment cannot message itself (${toEnvId})` }
      } else if (toEnvId === '' || toEnvId === SELF_ENV_ID) {
        answer = await deliver?.(message) ?? { ok: false, error: 'this node cannot deliver messages' }
      } else if (forward === undefined) {
        // An edge has no peers of its own; only the main node routes between them.
        answer = { ok: false, error: 'this node does not route messages to other environments' }
      } else if (!connections.has(toEnvId)) {
        answer = { ok: false, error: `environment "${toEnvId}" is offline` }
      } else {
        answer = await forward(toEnvId, message)
      }
    } catch (error) {
      answer = { ok: false, error: `malformed agent message: ${error?.message ?? error}` }
    }

    sendAgentAnswer(record, frame, answer)
  }

  /**
   * Answer one edge-originated call.
   *
   * @param record - the connection to answer on.
   * @param frame - the frame being answered.
   * @param answer - the JSON body.
   */
  function sendAgentAnswer(record, frame, answer) {
    try {
      record.socket.send(encodeJsonFrame(FRAME.responseHead, frame.id, {
        status: answer.ok === true ? 200 : 502,
        statusText: answer.ok === true ? 'OK' : 'Bad Gateway',
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }))
      record.socket.send(encodeFrame(FRAME.responseBody, frame.id, Buffer.from(JSON.stringify(answer), 'utf8')))
      record.socket.send(encodeFrame(FRAME.responseEnd, frame.id))
    } catch (error) {
      logger.warn(`federation: could not answer ${record.envId}'s agent message: ${error.message}`)
    }
  }

  /**
   * Ask one edge to deliver a message, from this node.
   *
   * Resolves with the edge's answer, or a failure when the tunnel is gone. It never
   * hangs: a socket that dies mid-flight fails the pending entry through `onClose`.
   *
   * @param envId - the environment to reach.
   * @param message - `{ fromEnvId, fromSessionId, sessionId, text }`.
   * @param options.timeoutMs - how long to wait for the answer.
   * @returns `{ ok: true, accepted: true }` or `{ ok: false, error }`.
   */
  function sendAgentMessage(envId, message, { timeoutMs = 30_000 } = {}) {
    return new Promise((resolve) => {
      const settled = { done: false, body: '' }
      const finish = (value) => {
        if (settled.done) return
        settled.done = true
        resolve(value)
      }
      const timer = setTimeout(
        () => finish({ ok: false, error: `environment "${envId}" did not answer in time` }),
        timeoutMs,
      )
      const sent = request(envId, {
        method: 'POST',
        path: '/admin/agent-message',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          fromEnvId: message.fromEnvId,
          fromSessionId: message.fromSessionId,
          sessionId: message.sessionId,
          text: message.text,
        }),
      }, {
        onBody(chunk) { settled.body += chunk.toString('utf8') },
        onEnd() {
          clearTimeout(timer)
          try {
            finish(JSON.parse(settled.body))
          } catch {
            finish({ ok: false, error: `environment "${envId}" answered something that is not JSON` })
          }
        },
      })
      if (!sent) {
        clearTimeout(timer)
        finish({ ok: false, error: `environment "${envId}" is offline` })
      }
    })
  }

  /** Whether an environment currently has a live connection. */
  function isOnline(envId) {
    return connections.has(envId)
  }

  /** Ids of every connected environment. */
  function ids() {
    return [...connections.keys()]
  }

  /** Close every connection, for shutdown. */
  function close() {
    for (const [, record] of connections) record.socket.close()
    connections.clear()
  }

  /** Resolve a presented token to its environment, or undefined. */
  function verify(token) {
    return token === '' ? undefined : verifyToken(token)
  }

  /** The environment table an edge asks for; empty when this hub was given no source. */
  function listKnownEnvironments() {
    return listEnvironments?.() ?? []
  }

  return {
    accept: register,
    verify,
    proxy,
    proxyUpgrade,
    request,
    sendAgentMessage,
    listEnvironments: listKnownEnvironments,
    isOnline,
    ids,
    close,
  }
}

/**
 * Read the token an edge presented.
 *
 * Query parameter first: a browser's WebSocket API cannot set a header, and an edge may
 * eventually run somewhere that cannot either. `Authorization` is accepted as well so a
 * scripted client is not forced to put a secret in a URL.
 *
 * @param req - the upgrade request.
 * @returns the token, or an empty string.
 */
export function tokenOf(req) {
  const url = req.url ?? ''
  const queryAt = url.indexOf('?')
  if (queryAt !== -1) {
    const token = new URLSearchParams(url.slice(queryAt + 1)).get('token')
    if (token !== null && token !== '') return token
  }
  const header = req.headers.authorization ?? ''
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length)
  return ''
}

/** Create a WebSocket server that only accepts our path. */
export function createTunnelServer() {
  return new WebSocketServer({ noServer: true })
}
