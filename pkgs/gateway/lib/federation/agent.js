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
 * @module @yiln-dsh/dsh-gateway/federation/agent
 */

import { request as httpRequest } from 'node:http'
import WebSocket from 'ws'
import { FRAME, FrameReader, encodeFrame, encodeJsonFrame, newRequestId } from './frames.js'
import { keepAlive } from './keepalive.js'

/** Reconnect delays, then the ceiling. Network blips are normal; giving up is not. */
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 20_000, 30_000, 60_000]

/**
 * Connect this edge to its main node and keep it connected.
 *
 * @param options.mainUrl - base URL of the main node, e.g. `https://dsh.yiln.de`.
 * @param options.token - this environment's token.
 * @param options.harnessPort - `() => number`, the local harness listener.
 * @param options.daemonPort - `() => number`, this daemon's own listener.
 * @param options.harnessCookie - `() => Promise<string|undefined>`, the cookie this
 *   process holds for its own harness. The harness gates every path on a cookie derived
 *   from its own authority, which the main node's browser can never present — so the
 *   daemon attaches the session it minted for itself, exactly as it does when proxying
 *   its own root profile.
 * @param options.logger - logger.
 * @returns `{ start, stop, connected }`.
 */
export function createTunnelAgent({ mainUrl, token, harnessPort, daemonPort, harnessCookie, logger }) {
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
      // Started before the harness check so the socket is watched from the moment it is
      // usable: a link that dies during startup must still be noticed.
      keepAlive(socket, { label: 'the main node', logger })
      const port = harnessPort()
      if (port === 0) {
        // The harness listener is not mounted yet. Close and retry: forwarding to port 0
        // would send every request into nothing.
        logger.warn('federation: harness listener not ready yet; reconnecting shortly')
        socket.close()
        return
      }
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
      // Not per message: a file stream is hundreds of pieces, and a log line for each
      // one is pure overhead on the hot path. Only unusual counts are worth naming.
      if (frames.length > 1_000) logger.warn(`federation: received ${frames.length} frames in one message`)
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
      // A frame an edge originated comes back as a *response*, not as the
      // request-shaped frames the edge answers. Both spellings mean the same thing to
      // the half that is waiting, so both are accepted here: `agentMessage` is the one
      // request an edge may originate, and its answer is an ordinary response.
      if (frame.type === FRAME.responseHead) {
        // An entry that cares about status and headers (a binary relay) gets them; one
        // that does not simply has no handler.
        entry.onResponseHead?.(JSON.parse(frame.payload.toString('utf8')))
      } else if (frame.type === FRAME.requestBody || frame.type === FRAME.responseBody) {
        entry.onRequestBody(frame.payload)
      } else if (frame.type === FRAME.requestEnd || frame.type === FRAME.responseEnd) {
        inFlight.delete(key)
        entry.onRequestEnd()
      }
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

  const sent = { frames: 0, bytes: 0, dropped: 0 }
  function sendOrClose(frame) {
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.send(frame)
      sent.frames += 1
      sent.bytes += frame.length
      return true
    }
    sent.dropped += 1
    if (sent.dropped === 1) logger.warn('federation: a frame was dropped because the tunnel was not open')
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
      // `/admin` is the daemon's JSON surface; `/file` is its byte surface. Both belong
      // to the daemon rather than the harness behind it, and both are answered only for
      // a request that carried this node's federation token.
      const pathname = head.path.split('?')[0]
      const daemonOwned = pathname === '/admin' || pathname.startsWith('/admin/')
        || pathname === '/file' || pathname.startsWith('/file/')
      const check = httpRequest({
        host: '127.0.0.1',
        port: daemonOwned ? daemonPort() : harnessPort(),
        method: head.method,
        path: head.path,
        headers: daemonOwned
          ? { ...head.headers, host: `127.0.0.1:${daemonPort()}`, 'x-dsh-federation': token }
          : prepared,
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

    const queued = []
    const slot = {
      onRequestBody(chunk) { queued.push(chunk) },
      onRequestEnd() {},
      close() {},
    }
    inFlight.set(key, slot)

    const upgrade = httpRequest({
      host: '127.0.0.1',
      port: harnessPort(),
      method: head.method,
      path: head.path,
      headers: prepared,
    })
    logger.info(`federation: opening upgrade to ${authority()}${head.path}`)
    upgrade.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
      logger.info(`federation: harness accepted the upgrade (${answer.statusCode})`)
      // Raw header block, so the main node relays the harness's own value for
      // `Sec-WebSocket-Accept` instead of inventing one.
      sendOrClose(encodeJsonFrame(FRAME.responseHead, id, {
        status: 101,
        statusText: 'Switching Protocols',
        rawHeaders: answer.rawHeaders,
      }))
      if (upstreamHead.length > 0) sendOrClose(encodeFrame(FRAME.responseBody, id, upstreamHead))
      let up = 0
      upstreamSocket.on('data', (chunk) => {
        if (up === 0) logger.info('federation: first byte from the harness on the upgraded socket')
        up += chunk.length
        sendOrClose(encodeFrame(FRAME.responseBody, id, chunk))
      })
      upstreamSocket.on('close', () => {
        logger.info(`federation: upstream closed, ${up} byte(s) came back; sent so far ${sent.frames} frame(s)/${sent.bytes} byte(s), dropped ${sent.dropped}`)
        inFlight.delete(key)
        sendOrClose(encodeFrame(FRAME.responseEnd, id))
      })
      upstreamSocket.on('error', () => inFlight.delete(key))
      upstreamSocket.resume()
      Object.assign(slot, {
        onRequestBody(chunk) {
          if (!upstreamSocket.destroyed) upstreamSocket.write(chunk)
        },
        close() {
          upstreamSocket.destroy()
        },
      })
      // Frames that arrived during the handshake are delivered now, in order.
      for (const chunk of queued.splice(0)) {
        if (!upstreamSocket.destroyed) upstreamSocket.write(chunk)
      }
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

  /**
   * Ask the main node to deliver one agent message, from this edge.
   *
   * An edge has no other way to reach the main node: its `/admin` refuses a bare edge
   * (the main node sets no `token`, so that gate is false there), so the frame is the
   * whole channel. The reply arrives on the request id as an ordinary response.
   *
   * `fromEnvId` is *not* sent — the hub derives it from this connection, which is what
   * stops one environment from claiming to be another.
   *
   * @param message - `{ toEnvId, fromSessionId, sessionId, text }`.
   * @param options.timeoutMs - how long to wait for the answer.
   * @returns `{ ok: true, accepted: true }` or `{ ok: false, error }`.
   */
  function sendAgentMessage(message, { timeoutMs = 30_000 } = {}) {
    return new Promise((resolve) => {
      if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, error: 'this edge is not connected to the main node' })
        return
      }
      const settled = { done: false, body: '' }
      const finish = (value) => {
        if (settled.done) return
        settled.done = true
        resolve(value)
      }
      const timer = setTimeout(
        () => finish({ ok: false, error: 'the main node did not answer in time' }),
        timeoutMs,
      )
      const id = newRequestId()
      const key = id.toString('hex')
      inFlight.set(key, {
        onRequestBody(payload) { settled.body += payload.toString('utf8') },
        onRequestEnd() {
          clearTimeout(timer)
          try {
            finish(JSON.parse(settled.body))
          } catch {
            finish({ ok: false, error: 'the main node answered something that is not JSON' })
          }
        },
        close() {
          clearTimeout(timer)
          finish({ ok: false, error: 'the tunnel closed before the main node answered' })
        },
      })
      sendOrClose(encodeJsonFrame(FRAME.agentMessage, id, {
        toEnvId: message.toEnvId ?? '',
        fromSessionId: message.fromSessionId ?? '',
        sessionId: message.sessionId,
        text: message.text,
      }))
    })
  }

  /**
   * Ask a peer for one file chunk, through the main node.
   *
   * The answer carries bytes, not JSON, so it is accumulated as a Buffer and the
   * describing headers are returned beside it. Reading it as text would corrupt every
   * byte above 0x7f.
   *
   * @param toEnvId - peer environment id.
   * @param path - source path on the peer.
   * @param index - chunk index.
   * @param encoding - how the chunk was encoded.
   * @returns `{ ok: true, data, encoding, index, eof }` or `{ ok: false, error }`.
   */
  function readRemoteChunk(toEnvId, path, index, encoding, extra = {}) {
    return new Promise((resolve) => {
      if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, error: 'this edge is not connected to the main node' })
        return
      }
      let settled = false
      let body = Buffer.alloc(0)
      let head
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const timer = setTimeout(() => finish({ ok: false, error: 'the main node did not answer in time' }), 60_000)
      const id = newRequestId()
      const key = id.toString('hex')
      inFlight.set(key, {
        onResponseHead(value) { head = value },
        onRequestBody(payload) { body = Buffer.concat([body, payload]) },
        onRequestEnd() {
          clearTimeout(timer)
          if (head !== undefined && head.status !== 200) {
            finish({ ok: false, error: body.toString('utf8').slice(0, 300) || `status ${head.status}` })
            return
          }
          finish({
            ok: true,
            data: body,
            encoding: head?.headers?.['x-dsh-chunk-encoding'] ?? encoding ?? 'raw',
            index: Number(head?.headers?.['x-dsh-chunk-index'] ?? index),
            eof: head?.headers?.['x-dsh-chunk-eof'] === '1',
          })
        },
        close() {
          clearTimeout(timer)
          finish({ ok: false, error: 'the tunnel closed before the peer answered' })
        },
      })
      sendOrClose(encodeJsonFrame(FRAME.agentMessage, id, {
        kind: 'relay',
        toEnvId,
        method: 'POST',
        path: '/admin/file',
        binary: true,
        body: JSON.stringify({ action: 'chunk', path, index, encoding, ...extra }),
      }))
    })
  }

  /**
   * Stream one file from a peer into a local writer, through the main node.
   *
   * One request, one streamed response: the main node relays body pieces as they arrive
   * rather than buffering the file, which is what makes slicing unnecessary.
   *
   * @param toEnvId - peer environment id.
   * @param filePath - absolute path on the peer.
   * @param sink - `(piece) => void`.
   * @param range - optional `Range` header value.
   * @returns `{ ok, size?, error? }`.
   */
  function streamFileFromPeer(toEnvId, filePath, sink, range) {
    return new Promise((resolve) => {
      if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, error: 'this edge is not connected to the main node' })
        return
      }
      let settled = false
      let head
      let bytes = 0
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const timer = setTimeout(() => finish({ ok: false, error: 'the main node did not answer in time' }), 300_000)
      const id = newRequestId()
      const key = id.toString('hex')
      inFlight.set(key, {
        onResponseHead(value) { head = value },
        onRequestBody(payload) {
          bytes += payload.length
          if (head !== undefined && (head.status === 200 || head.status === 206)) sink(payload)
        },
        onRequestEnd() {
          clearTimeout(timer)
          if (head !== undefined && head.status !== 200 && head.status !== 206) {
            finish({ ok: false, error: `the peer answered ${head.status}` })
            return
          }
          finish({ ok: true, size: Number(head?.headers?.['x-dsh-file-size'] ?? bytes) })
        },
        close() {
          clearTimeout(timer)
          finish({ ok: false, error: 'the tunnel closed before the peer finished' })
        },
      })
      sendOrClose(encodeJsonFrame(FRAME.agentMessage, id, {
        kind: 'stream-file',
        toEnvId,
        path: filePath,
        range,
      }))
    })
  }

  /**
   * Ask the main node which environments exist, and which are online.
   *
   * An edge's own registry is empty by design — environments are the main node's to
   * know — so this is the only way `agent_list_envs` can answer anything useful on an
   * edge. The answer comes back on the same request/response path every edge-originated
   * call uses.
   *
   * @param options.timeoutMs - how long to wait for the answer.
   * @returns `{ environments: { envId, label, online }[] }`, or an empty list.
   */
  function listEnvironments({ timeoutMs = 10_000 } = {}) {
    return new Promise((resolve) => {
      if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
        resolve({ environments: [] })
        return
      }
      const settled = { done: false, body: '' }
      const finish = (value) => {
        if (settled.done) return
        settled.done = true
        resolve(value)
      }
      const timer = setTimeout(() => finish({ environments: [] }), timeoutMs)
      const id = newRequestId()
      const key = id.toString('hex')
      inFlight.set(key, {
        onRequestBody(payload) { settled.body += payload.toString('utf8') },
        onRequestEnd() {
          clearTimeout(timer)
          try {
            const parsed = JSON.parse(settled.body)
            finish({ environments: Array.isArray(parsed?.environments) ? parsed.environments : [] })
          } catch {
            finish({ environments: [] })
          }
        },
        close() {
          clearTimeout(timer)
          finish({ environments: [] })
        },
      })
      sendOrClose(encodeJsonFrame(FRAME.agentMessage, id, { kind: 'list-environments' }))
    })
  }

  /**
   * Send one JSON request to a peer through the main node.
   *
   * An edge has no tunnel to another edge; the main node relays. The frame carries the
   * request rather than the edge holding a second connection, which is why `toEnvId` is
   * part of the payload and not of the connection.
   *
   * @param toEnvId - peer environment id.
   * @param method - HTTP method the peer should use.
   * @param path - peer path, e.g. `/admin/workspaces`.
   * @param body - optional JSON body.
   * @returns the peer's parsed answer, or `{ ok: false, error }`.
   */
  function readRemote(toEnvId, method, path, body) {
    return new Promise((resolve) => {
      if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, error: 'this edge is not connected to the main node' })
        return
      }
      const settled = { done: false, body: '' }
      const finish = (value) => {
        if (settled.done) return
        settled.done = true
        resolve(value)
      }
      const timer = setTimeout(() => finish({ ok: false, error: 'the main node did not answer in time' }), 60_000)
      const id = newRequestId()
      const key = id.toString('hex')
      inFlight.set(key, {
        onRequestBody(payload) { settled.body += payload.toString('utf8') },
        onRequestEnd() {
          clearTimeout(timer)
          try {
            finish(JSON.parse(settled.body))
          } catch {
            finish({ ok: false, error: 'the peer answered something that is not JSON' })
          }
        },
        close() {
          clearTimeout(timer)
          finish({ ok: false, error: 'the tunnel closed before the peer answered' })
        },
      })
      sendOrClose(encodeJsonFrame(FRAME.agentMessage, id, {
        kind: 'relay',
        toEnvId,
        method,
        path,
        body: body === undefined ? undefined : JSON.stringify(body),
      }))
    })
  }

  return {
    start,
    stop,
    sendAgentMessage,
    listEnvironments,
    readRemote,
    readRemoteChunk,
    streamFileFromPeer,
    connected: () => socket?.readyState === WebSocket.OPEN,
  }
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
