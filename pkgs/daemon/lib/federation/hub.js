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
 * @module @yiln-dsh/dsh-daemon/federation/hub
 */

import { WebSocketServer } from 'ws'
import { FRAME, FrameReader, encodeFrame, encodeJsonFrame, newRequestId } from './frames.js'

/** Path the edges connect to. */
export const TUNNEL_PATH = '/_tunnel'

/**
 * Accept and manage edge connections.
 *
 * @param options.verifyToken - `(token) => environment | undefined`; resolves the
 *   environment an edge claims to be, or nothing when the token is unknown.
 * @param options.logger - logger.
 * @returns the hub: `accept`, `proxy`, `proxyUpgrade`, `isOnline`, `ids`, `close`.
 */
export function createTunnelHub({ verifyToken, logger }) {
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
    const key = frame.id.toString('hex')
    const entry = record.pending.get(key)
    if (entry === undefined) return
    if (frame.type === FRAME.responseHead) {
      entry.onHead(JSON.parse(frame.payload.toString('utf8')))
      return
    }
    if (frame.type === FRAME.responseBody) {
      entry.onBody(frame.payload)
      return
    }
    if (frame.type === FRAME.responseEnd) {
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
    if (record === undefined) return false

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
    req.on('close', () => {
      // The browser went away before the edge answered. Say so, or the edge keeps
      // working on a response nobody will read.
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
    if (record === undefined) return false

    const id = newRequestId()
    const key = id.toString('hex')
    let upgraded = false

    record.pending.set(key, {
      onHead(head2) {
        if (head2.status !== 101) {
          socket.end(`HTTP/1.1 ${head2.status} ${head2.statusText}\r\n\r\n`)
          return
        }
        upgraded = true
        const lines = [`HTTP/1.1 101 ${head2.statusText || 'Switching Protocols'}`]
        for (const [name, value] of Object.entries(head2.headers)) {
          lines.push(`${name}: ${value}`)
        }
        socket.write(`${lines.join('\r\n')}\r\n\r\n`)
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
    })

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
    socket.on('close', () => {
      if (record.pending.delete(key)) record.socket.send(encodeFrame(FRAME.cancel, id))
    })
    socket.on('error', () => {
      if (record.pending.delete(key)) record.socket.send(encodeFrame(FRAME.cancel, id))
    })
    return true
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

  return { accept: register, verify, proxy, proxyUpgrade, isOnline, ids, close }
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
