/**
 * Edge side of the federation tunnel.
 *
 * The edge dials the main node and keeps one WebSocket open. Everything the main node
 * wants from this machine arrives as frames on it: the harness is never exposed directly
 * and no inbound port is opened.
 *
 * Requests are forwarded to `127.0.0.1:<harnessPort>` with the Host and Origin rewritten
 * to that authority — the harness fences on them, and a browser that reached it through
 * the main node presents the main node's authority instead.
 *
 * @module @yiln-dsh/dsh-daemon/federation/agent
 */

import { request as httpRequest } from 'node:http'
import WebSocket from 'ws'
import { FRAME, FrameReader, encodeFrame, encodeJsonFrame } from './frames.js'

/** Reconnect delays, then the ceiling. Network blips are normal; giving up is not. */
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 20_000, 30_000, 60_000]

/**
 * Connect this edge to its main node and keep it connected.
 *
 * @param options.mainUrl - base URL of the main node, e.g. `https://dsh.yiln.de`.
 * @param options.token - this environment's token.
 * @param options.harnessPort - `() => number`, the local harness listener.
 * @param options.harnessCookie - `() => Promise<string|undefined>`, the cookie this
 *   process holds for its own harness. The harness gates every path on a cookie derived
 *   from its own authority, which the main node's browser can never present — so the
 *   daemon attaches the session it minted for itself, exactly as it does when proxying
 *   its own root profile.
 * @param options.logger - logger.
 * @returns `{ start, stop, connected }`.
 */
export function createTunnelAgent({ mainUrl, token, harnessPort, harnessCookie, logger }) {
  let socket
  let reader
  let stopped = false
  let attempts = 0
  let timer
  /** requestId(hex) -> cleanup for an in-flight request. */
  const inFlight = new Map()

  function target() {
    const base = mainUrl.replace(/\/+$/u, '')
    const scheme = base.startsWith('https:') ? 'wss:' : 'ws:'
    const rest = base.replace(/^https?:/u, '')
    return `${scheme}//${rest}/_tunnel?token=${encodeURIComponent(token)}`
  }

  function schedule() {
    if (stopped) return
    const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]
    attempts += 1
    logger.warn(`federation: reconnecting in ${delay} ms (attempt ${attempts})`)
    timer = setTimeout(connect, delay)
  }

  function connect() {
    if (stopped) return
    const url = target()
    socket = new WebSocket(url, { handshakeTimeout: 15_000 })
    reader = new FrameReader()

    socket.on('open', () => {
      attempts = 0
      const port = harnessPort()
      logger.info(`federation: connected to the main node; forwarding to 127.0.0.1:${port}`)
      socket.send(encodeJsonFrame(FRAME.heartbeat, Buffer.alloc(16), {
        hostname: process.env.HOSTNAME ?? '',
        harnessPort: port,
      }))
    })

    socket.on('message', (data) => {
      let frames
      try {
        frames = reader.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
      } catch (error) {
        logger.warn(`federation: dropping frame: ${error.message}`)
        socket.close()
        return
      }
      logger.info(`federation: received ${frames.length} frame(s)`)
      for (const frame of frames) handle(frame)
    })

    socket.on('close', () => {
      closeInFlight()
      inFlight.clear()
      socket = undefined
      schedule()
    })

    socket.on('error', (error) => {
      logger.warn(`federation: socket error: ${error.message}`)
    })
  }

  function handle(frame) {
    const key = frame.id.toString('hex')
    if (frame.type === FRAME.heartbeat) return
    if (frame.type === FRAME.cancel) {
      const entry = inFlight.get(key)
      inFlight.delete(key)
      entry?.close?.()
      return
    }
    if (frame.type !== FRAME.requestHead) {
      const entry = inFlight.get(key)
      if (entry === undefined) return
      if (frame.type === FRAME.requestBody) entry.onRequestBody(frame.payload)
      else if (frame.type === FRAME.requestEnd) entry.onRequestEnd()
      return
    }
    const head = JSON.parse(frame.payload.toString('utf8'))
    const start = head.upgrade === true ? startUpgrade : startHttp
    start(frame.id, key, head).catch((error) => {
      logger.warn(`federation: ${head.upgrade === true ? 'upgrade' : 'request'} failed: ${error.message}`)
      inFlight.delete(key)
      sendOrClose(encodeJsonFrame(FRAME.responseHead, frame.id, {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }))
      sendOrClose(encodeFrame(FRAME.responseBody, frame.id, Buffer.from(`federation: ${error.message}\n`)))
      sendOrClose(encodeFrame(FRAME.responseEnd, frame.id))
    })
  }

  /** Authority the harness expects: its own loopback listener. */
  function authority() {
    return `127.0.0.1:${harnessPort()}`
  }

  /**
   * Headers the harness will accept.
   *
   * Host and Origin are rewritten because the harness fences on them and a browser
   * arriving through the main node presents the main node's authority. The cookie is
   * replaced rather than forwarded: the main node's session cookie is for the main node,
   * and only this process can mint one its own harness accepts.
   */
  async function rewriteHeaders(headers) {
    const next = { ...headers }
    next.host = authority()
    if (next.origin !== undefined) next.origin = `http://${authority()}`
    const cookie = await harnessCookie?.()
    if (cookie !== undefined) logger.info(`federation: attaching harness cookie ${String(cookie).slice(0, 24)}…`)
    if (cookie !== undefined && cookie !== '') next.cookie = cookie
    else {
      logger.warn('federation: no harness cookie available; the harness will answer the login page')
      delete next.cookie
    }
    return next
  }

  function sendOrClose(frame) {
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.send(frame)
      return true
    }
    return false
  }

  async function startHttp(id, key, head) {
    // Reserve the slot before the first await: body and end frames can arrive while the
    // cookie is still being minted, and a missing entry silently drops them.
    const queued = { body: [], ended: false }
    const slot = {
      onRequestBody(chunk) { queued.body.push(chunk) },
      onRequestEnd() { queued.ended = true },
    }
    inFlight.set(key, slot)

    const prepared = await rewriteHeaders(head.headers)
    let response
    const check = httpRequest({
      host: '127.0.0.1',
      port: harnessPort(),
      method: head.method,
      path: head.path,
      headers: prepared,
    }, (answer) => {
      response = answer
      sendOrClose(encodeJsonFrame(FRAME.responseHead, id, {
        status: answer.statusCode ?? 502,
        statusText: answer.statusMessage ?? '',
        headers: stripHopByHop(answer.headers),
      }))
      answer.on('data', (chunk) => sendOrClose(encodeFrame(FRAME.responseBody, id, chunk)))
      answer.on('end', () => {
        inFlight.delete(key)
        sendOrClose(encodeFrame(FRAME.responseEnd, id))
      })
    })
    check.on('error', (error) => {
      inFlight.delete(key)
      if (socket === undefined) return
      sendOrClose(encodeJsonFrame(FRAME.responseHead, id, {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }))
      sendOrClose(encodeFrame(FRAME.responseBody, id, Buffer.from(`federation: ${error.message}\n`)))
      sendOrClose(encodeFrame(FRAME.responseEnd, id))
    })

    // Buffered frames arrive before this point only if the socket was faster than the
    // cookie exchange; the queue in `pending` below hands them over now.
    Object.assign(slot, {
      onRequestBody(chunk) {
        check.write(chunk)
      },
      onRequestEnd() {
        check.end()
      },
      close() {
        check.destroy()
      },
    })
    for (const chunk of queued.body.splice(0)) check.write(chunk)
    if (queued.ended) check.end()
    check.on('close', () => inFlight.delete(key))
    void response
  }

  async function startUpgrade(id, key, head) {
    // A transparent upgrade: send the browser's own handshake to the harness and relay
    // the harness's 101 verbatim. Reconstructing the response with `ws` would have to
    // recompute `Sec-WebSocket-Accept`, and getting that wrong is exactly what a proxy
    // must not do.
    const prepared = await rewriteHeaders(head.headers)
    prepared.connection = 'Upgrade'
    prepared.upgrade = 'websocket'

    const slot = { onRequestBody() {}, onRequestEnd() {}, close() {} }
    inFlight.set(key, slot)

    const upgrade = httpRequest({
      host: '127.0.0.1',
      port: harnessPort(),
      method: head.method,
      path: head.path,
      headers: prepared,
    })
    upgrade.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
      // Raw header block, so the main node relays the harness's own value for
      // `Sec-WebSocket-Accept` instead of inventing one.
      sendOrClose(encodeJsonFrame(FRAME.responseHead, id, {
        status: 101,
        statusText: 'Switching Protocols',
        rawHeaders: answer.rawHeaders,
      }))
      if (upstreamHead.length > 0) sendOrClose(encodeFrame(FRAME.responseBody, id, upstreamHead))
      upstreamSocket.on('data', (chunk) => sendOrClose(encodeFrame(FRAME.responseBody, id, chunk)))
      upstreamSocket.on('close', () => {
        inFlight.delete(key)
        sendOrClose(encodeFrame(FRAME.responseEnd, id))
      })
      upstreamSocket.on('error', () => inFlight.delete(key))
      Object.assign(slot, {
        onRequestBody(chunk) {
          if (!upstreamSocket.destroyed) upstreamSocket.write(chunk)
        },
        close() {
          upstreamSocket.destroy()
        },
      })
    })
    upgrade.on('response', (answer) => {
      // The harness refused the upgrade: relay its status so the browser reports the
      // real reason (usually 401 or 403) instead of a generic failure.
      inFlight.delete(key)
      sendOrClose(encodeJsonFrame(FRAME.responseHead, id, {
        status: answer.statusCode ?? 400,
        statusText: answer.statusMessage ?? '',
        headers: answer.headers,
      }))
      sendOrClose(encodeFrame(FRAME.responseEnd, id))
      answer.resume()
    })
    upgrade.on('error', (error) => {
      inFlight.delete(key)
      logger.warn(`federation: upgrade failed: ${error.message}`)
      sendOrClose(encodeJsonFrame(FRAME.responseHead, id, {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }))
      sendOrClose(encodeFrame(FRAME.responseEnd, id))
    })
    upgrade.end()
  }

  /** Release every in-flight request, whatever shape its handlers have. */
  function closeInFlight() {
    for (const [, entry] of inFlight) entry.close?.()
  }

  function start() {
    stopped = false
    connect()
  }

  function stop() {
    stopped = true
    clearTimeout(timer)
    socket?.close()
    closeInFlight()
    inFlight.clear()
  }

  return { start, stop, connected: () => socket?.readyState === WebSocket.OPEN }
}

/** Drop headers that describe one hop, not the message. */
function stripHopByHop(headers) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    if (name === 'connection' || name === 'keep-alive' || name === 'transfer-encoding') continue
    if (value !== undefined) out[name] = value
  }
  return out
}
