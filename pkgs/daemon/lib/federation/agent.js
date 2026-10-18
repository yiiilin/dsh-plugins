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
 * @param options.logger - logger.
 * @returns `{ start, stop, connected }`.
 */
export function createTunnelAgent({ mainUrl, token, harnessPort, logger }) {
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
      for (const frame of frames) handle(frame)
    })

    socket.on('close', () => {
      for (const [, cleanup] of inFlight) cleanup()
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
      const cleanup = inFlight.get(key)
      inFlight.delete(key)
      cleanup?.()
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
    if (head.upgrade === true) startUpgrade(frame.id, key, head)
    else startHttp(frame.id, key, head)
  }

  /** Authority the harness expects: its own loopback listener. */
  function authority() {
    return `127.0.0.1:${harnessPort()}`
  }

  function rewriteHeaders(headers) {
    const next = { ...headers }
    next.host = authority()
    if (next.origin !== undefined) next.origin = `http://${authority()}`
    return next
  }

  function sendOrClose(frame) {
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.send(frame)
      return true
    }
    return false
  }

  function startHttp(id, key, head) {
    let response
    const check = httpRequest({
      host: '127.0.0.1',
      port: harnessPort(),
      method: head.method,
      path: head.path,
      headers: rewriteHeaders(head.headers),
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

    inFlight.set(key, {
      onRequestBody(chunk) {
        check.write(chunk)
      },
      onRequestEnd() {
        check.end()
      },
    })
    check.on('close', () => inFlight.delete(key))
    void response
  }

  function startUpgrade(id, key, head) {
    // The real handshake happens here, against the harness: it keeps the harness's own
    // origin and cookie checks in force, and this side only reports the outcome.
    const upstream = new WebSocket(`ws://${authority()}${head.path}`, {
      headers: rewriteHeaders(head.headers),
      handshakeTimeout: 20_000,
    })
    let settled = false
    upstream.on('open', () => {
      settled = true
      sendOrClose(encodeJsonFrame(FRAME.responseHead, id, {
        status: 101,
        statusText: 'Switching Protocols',
        headers: {
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-accept': upstream.handshakeResponse?.headers['sec-websocket-accept'] ?? '',
        },
      }))
    })
    upstream.on('message', (data) => {
      sendOrClose(encodeFrame(FRAME.responseBody, id, Buffer.isBuffer(data) ? data : Buffer.from(data)))
    })
    upstream.on('close', () => {
      inFlight.delete(key)
      sendOrClose(encodeFrame(FRAME.responseEnd, id))
    })
    upstream.on('error', (error) => {
      inFlight.delete(key)
      if (settled) return
      sendOrClose(encodeJsonFrame(FRAME.responseHead, id, {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }))
      sendOrClose(encodeFrame(FRAME.responseBody, id, Buffer.from(`federation: ${error.message}\n`)))
      sendOrClose(encodeFrame(FRAME.responseEnd, id))
    })

    inFlight.set(key, {
      onRequestBody(chunk) {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(chunk)
      },
    })
  }

  function start() {
    stopped = false
    connect()
  }

  function stop() {
    stopped = true
    clearTimeout(timer)
    socket?.close()
    for (const [, cleanup] of inFlight) cleanup()
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
