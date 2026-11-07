/**
 * desktop-vnc Host half — hand-written RFC 6455 WebSocket server.
 *
 * The workspace declares no `ws` dependency and the plugin must not add one, so
 * this module implements the parts of RFC 6455 the VNC bridge actually needs:
 *
 * - the server handshake (`Sec-WebSocket-Accept`, subprotocol negotiation),
 * - frame decoding (client mask, 7/16/64-bit lengths, fragmentation,
 *   ping/pong/close) with a single-frame byte cap,
 * - frame encoding for server→client traffic (never masked), and
 * - a two-way byte pump between one WebSocket and one TCP socket.
 *
 * It is transport-shaped but dependency-free: every entry point takes plain
 * streams/requests so `node:test` can drive the codec and the pump with
 * event-emitting fakes, while production uses the raw socket handed to
 * `webServer.registerUpgrade`.
 *
 * @module @yiln-dsh/dsh-browser-vnc/ws
 */

import { createHash } from 'node:crypto'

/** RFC 6455 §1.3 handshake GUID. */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** One frame may not exceed this; larger frames close the session with 1009. */
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024

export const OPCODE_CONTINUATION = 0x0
export const OPCODE_TEXT = 0x1
export const OPCODE_BINARY = 0x2
export const OPCODE_CLOSE = 0x8
export const OPCODE_PING = 0x9
export const OPCODE_PONG = 0xa

export const CLOSE_NORMAL = 1000
export const CLOSE_PROTOCOL_ERROR = 1002
export const CLOSE_INVALID_PAYLOAD = 1007
export const CLOSE_MESSAGE_TOO_BIG = 1009
export const CLOSE_INTERNAL_ERROR = 1011

/** Subprotocols noVNC may offer; `binary` is its default in 1.7. */
export const SUBPROTOCOLS = ['binary', 'base64']

const EMPTY = Buffer.alloc(0)

/** A framing violation carrying the close code the peer must be told about. */
export class WsProtocolError extends Error {
  /** @param {string} message human-readable diagnosis. @param {number} closeCode RFC 6455 close code. */
  constructor(message, closeCode = CLOSE_PROTOCOL_ERROR) {
    super(message)
    this.name = 'WsProtocolError'
    this.closeCode = closeCode
  }
}

/** `Sec-WebSocket-Accept` for one `Sec-WebSocket-Key`. */
export function acceptKey(key) {
  return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64')
}

/**
 * Pick the first supported subprotocol from a `Sec-WebSocket-Protocol` header.
 * @param {string|undefined} header raw header value.
 * @returns {'binary'|'base64'|null} the selected protocol, or null to echo none.
 */
export function selectSubprotocol(header) {
  if (typeof header !== 'string' || header === '') return null
  for (const raw of header.split(',')) {
    const token = raw.trim()
    if (token === 'binary' || token === 'base64') return token
  }
  return null
}

/**
 * Compare a request `Origin` against the origins the host answers on. An absent
 * Origin is allowed (same-origin browsers may omit it; non-browser clients are
 * not the threat this defends against). A literal `null` origin — a file:// or
 * sandboxed document — is refused: any such page could otherwise borrow the
 * user's browser to reach the local VNC port.
 * @param {string|undefined} origin request Origin header.
 * @param {Iterable<string>} allowed accepted origins, already normalized.
 * @returns {boolean} whether the upgrade may proceed.
 */
export function isAllowedOrigin(origin, allowed) {
  if (origin === undefined || origin === null || origin === '') return true
  const candidate = normalizeOrigin(origin)
  if (candidate === null) return false
  for (const entry of allowed) {
    if (candidate === normalizeOrigin(entry)) return true
  }
  return false
}

/**
 * Same-origin check against the request the browser actually made.
 *
 * A literal allow-list is not enough here: the harness binds one port on several
 * interfaces at once, so a user may reach the very same server as
 * `127.0.0.1:3080`, `192.168.1.5:3080`, or a public hostname behind a reverse
 * proxy. Enumerating those spellings is impossible, and refusing all but the
 * loopback ones silently broke the panel for every non-loopback visitor (the
 * WebSocket was answered 403, so the pane sat at "not connected"). The standard
 * rule is relational instead: the page's Origin host must equal the Host it
 * addressed.
 *
 * A foreign page is still refused, because its Origin names its own host while
 * the Host header names ours — that is exactly the case this must stop, since
 * otherwise any site could borrow the user's browser to drive the local VNC
 * port. A request with no Origin (a non-browser client) is not the threat model
 * and keeps the historical allowance.
 *
 * @param {string|undefined} origin request Origin header.
 * @param {string|undefined} host request Host header.
 * @param {Iterable<string>} allowed explicitly accepted origins (loopback spellings).
 * @returns {boolean} whether the upgrade may proceed.
 */
export function isSameOriginRequest(origin, host, allowed) {
  if (origin === undefined || origin === null || origin === '') return true
  const candidate = normalizeOrigin(origin)
  if (candidate === null) return false
  if (isAllowedOrigin(origin, allowed)) return true
  if (typeof host !== 'string' || host === '') return false
  const requestHost = host.trim().toLowerCase()
  if (requestHost === '') return false
  try {
    // Compare host:port only; the scheme may legitimately differ from the
    // Origin when a TLS terminator fronts a plain-HTTP listener.
    return new URL(candidate).host.toLowerCase() === requestHost
  } catch {
    return false
  }
}

/** Lower-cased `protocol//host` of an origin, or null when it is unusable. */
export function normalizeOrigin(value) {
  if (typeof value !== 'string' || value === '' || value === 'null') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.protocol}//${url.host}`.toLowerCase()
  } catch {
    return null
  }
}

/**
 * The origins this host treats as same-origin: the bound listener plus the
 * loopback spellings of the same port.
 * @param {string} boundOrigin `webServer.getOrigin()`.
 * @returns {string[]} normalized candidate origins.
 */
export function localOrigins(boundOrigin) {
  const set = new Set()
  let port
  try {
    const url = new URL(boundOrigin)
    port = url.port
    set.add(`${url.protocol}//${url.host}`.toLowerCase())
  } catch {
    port = ''
  }
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    set.add(`http://${port === '' ? host : `${host}:${port}`}`)
    set.add(`https://${port === '' ? host : `${host}:${port}`}`)
  }
  return [...set]
}

/** Validate the upgrade request's WebSocket headers. */
export function parseHandshake(req) {
  const headers = req?.headers ?? {}
  const upgrade = String(headers.upgrade ?? '').trim().toLowerCase()
  const connection = String(headers.connection ?? '').toLowerCase()
  const key = headers['sec-websocket-key']
  const version = String(headers['sec-websocket-version'] ?? '').trim()

  const connectionTokens = connection.split(',').map((token) => token.trim())
  if (upgrade !== 'websocket' || !connectionTokens.includes('upgrade')) {
    return { ok: false, status: 400, error: 'expected a websocket upgrade request' }
  }
  if (typeof key !== 'string' || key.trim() === '') {
    return { ok: false, status: 400, error: 'missing Sec-WebSocket-Key' }
  }
  if (version !== '13') {
    return { ok: false, status: 426, error: 'unsupported websocket version', version: '13' }
  }
  return {
    ok: true,
    key: key.trim(),
    accept: acceptKey(key.trim()),
    subprotocol: selectSubprotocol(headers['sec-websocket-protocol']),
  }
}

const STATUS_TEXT = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  426: 'Upgrade Required',
  503: 'Service Unavailable',
}

/** Write a plain-text HTTP response on a socket that must not be upgraded. */
export function writeHttpError(socket, status, message, extraHeaders = {}) {
  const text = String(message ?? STATUS_TEXT[status] ?? 'Error')
  const body = Buffer.from(text, 'utf8')
  const headers = [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
    'content-type: text/plain; charset=utf-8',
    `content-length: ${body.length}`,
    'connection: close',
    ...Object.entries(extraHeaders).map(([name, value]) => `${name}: ${value}`),
  ]
  socket.write(`${headers.join('\r\n')}\r\n\r\n`)
  socket.write(body)
  socket.end()
  return body.length
}

/** Write the 101 response, echoing the selected subprotocol when one was chosen. */
export function writeUpgrade(socket, { accept, subprotocol }) {
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
  ]
  if (typeof subprotocol === 'string' && subprotocol !== '') {
    lines.push(`Sec-WebSocket-Protocol: ${subprotocol}`)
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
}

/**
 * Incremental RFC 6455 frame decoder.
 *
 * `push()` returns every completed event; incomplete trailing bytes stay
 * buffered. Data frames are reassembled across continuation frames, control
 * frames may interleave, and violations throw {@link WsProtocolError} with the
 * close code the caller must send.
 */
export class FrameDecoder {
  /** @param {{maxFrameBytes?: number}} [options] single-frame and message byte cap. */
  constructor({ maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
    this.maxFrameBytes = maxFrameBytes
    this.buffer = EMPTY
    this.fragmentOpcode = 0
    this.fragments = []
    this.fragmentBytes = 0
  }

  /**
   * Feed transport bytes.
   * @param {Buffer|Uint8Array} chunk raw bytes from the socket.
   * @returns {Array<{type: 'message', opcode: number, payload: Buffer}|{type:'ping'|'pong', payload: Buffer}|{type:'close', code: number, reason: string}>} completed events.
   */
  push(chunk) {
    if (chunk !== undefined && chunk !== null) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (bytes.length > 0) {
        this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes])
      }
    }
    const events = []
    for (;;) {
      const next = this.#decodeOne()
      if (next === null) break
      if (next !== undefined) events.push(next)
    }
    return events
  }

  /** @returns {object|null|undefined} event, null when more bytes are needed, undefined when the frame produced no event. */
  #decodeOne() {
    const buffer = this.buffer
    if (buffer.length < 2) return null

    const b0 = buffer[0]
    const b1 = buffer[1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let length = b1 & 0x7f
    let offset = 2

    if ((b0 & 0x70) !== 0) {
      throw new WsProtocolError('reserved bits must be zero: no extension was negotiated')
    }
    if (length === 126) {
      if (buffer.length < 4) return null
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return null
      const high = buffer.readUInt32BE(2)
      const low = buffer.readUInt32BE(6)
      if (high !== 0) throw new WsProtocolError('frame declares an impossible payload length', CLOSE_MESSAGE_TOO_BIG)
      length = low
      offset = 10
    }
    if (length > this.maxFrameBytes || this.fragmentBytes + length > this.maxFrameBytes) {
      throw new WsProtocolError(`frame exceeds the ${this.maxFrameBytes} byte limit`, CLOSE_MESSAGE_TOO_BIG)
    }

    const isControl = opcode >= OPCODE_CLOSE
    if (isControl) {
      if (!fin) throw new WsProtocolError('control frames must not be fragmented')
      if (length > 125) throw new WsProtocolError('control frame payload must be at most 125 bytes')
      if (opcode !== OPCODE_CLOSE && opcode !== OPCODE_PING && opcode !== OPCODE_PONG) {
        throw new WsProtocolError(`unsupported control opcode 0x${opcode.toString(16)}`)
      }
    } else if (opcode !== OPCODE_CONTINUATION && opcode !== OPCODE_TEXT && opcode !== OPCODE_BINARY) {
      throw new WsProtocolError(`unsupported opcode 0x${opcode.toString(16)}`)
    }

    // RFC 6455 §5.1: every client→server frame must be masked.
    if (!masked) throw new WsProtocolError('client frames must be masked')
    if (buffer.length < offset + 4) return null
    const mask = buffer.subarray(offset, offset + 4)
    offset += 4
    if (buffer.length < offset + length) return null

    const payload = Buffer.from(buffer.subarray(offset, offset + length))
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3]
    this.buffer = buffer.subarray(offset + length)

    if (isControl) {
      if (opcode === OPCODE_CLOSE) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : ''
        return { type: 'close', code, reason }
      }
      return { type: opcode === OPCODE_PING ? 'ping' : 'pong', payload }
    }

    if (opcode === OPCODE_CONTINUATION) {
      if (this.fragmentOpcode === 0) throw new WsProtocolError('continuation frame without a preceding data frame')
      this.#accumulate(payload)
      if (!fin) return undefined
      const full = Buffer.concat(this.fragments)
      const messageOpcode = this.fragmentOpcode
      this.#resetFragments()
      return { type: 'message', opcode: messageOpcode, payload: full }
    }

    if (this.fragmentOpcode !== 0) throw new WsProtocolError('expected a continuation frame')
    if (fin) return { type: 'message', opcode, payload }
    this.fragmentOpcode = opcode
    this.#accumulate(payload)
    return undefined
  }

  #accumulate(payload) {
    this.fragments.push(payload)
    this.fragmentBytes += payload.length
    if (this.fragmentBytes > this.maxFrameBytes) {
      throw new WsProtocolError(`message exceeds the ${this.maxFrameBytes} byte limit`, CLOSE_MESSAGE_TOO_BIG)
    }
  }

  #resetFragments() {
    this.fragmentOpcode = 0
    this.fragments = []
    this.fragmentBytes = 0
  }
}

/** Encode one server→client frame (never masked), choosing the 7/16/64-bit length form. */
export function encodeFrame(opcode, payload = EMPTY, { fin = true } = {}) {
  const body = payload === undefined || payload === null
    ? EMPTY
    : (Buffer.isBuffer(payload) ? payload : Buffer.from(payload))
  let header
  if (body.length < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = body.length
  } else if (body.length < 0x10000) {
    header = Buffer.allocUnsafe(4)
    header[1] = 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[1] = 127
    header.writeUInt32BE(Math.floor(body.length / 0x100000000), 2)
    header.writeUInt32BE(body.length >>> 0, 6)
  }
  header[0] = (fin ? 0x80 : 0) | opcode
  return Buffer.concat([header, body])
}

/** Encode a close frame; reason is truncated to the 123 bytes the payload allows. */
export function encodeClose(code = CLOSE_NORMAL, reason = '') {
  const text = Buffer.from(String(reason ?? ''), 'utf8').subarray(0, 123)
  const payload = Buffer.allocUnsafe(2 + text.length)
  payload.writeUInt16BE(code, 0)
  text.copy(payload, 2)
  return encodeFrame(OPCODE_CLOSE, payload)
}

/**
 * Wrap outbound RFB bytes in the frame type the negotiated subprotocol uses:
 * raw binary frames for `binary`, base64 text frames for `base64` (noVNC's
 * text fallback).
 */
export function encodePayload(bytes, subprotocol) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (subprotocol === 'base64') {
    return encodeFrame(OPCODE_TEXT, Buffer.from(body.toString('base64'), 'utf8'))
  }
  return encodeFrame(OPCODE_BINARY, body)
}

/** Decode one client message payload into the RFB bytes it carries. */
export function decodePayload(event, subprotocol) {
  // Under `binary` the frame payload IS the RFB bytes. Under `base64` noVNC
  // sends text frames, so the payload is the base64 encoding of those bytes.
  if (subprotocol !== 'base64') return event.payload
  const text = event.payload.toString('utf8').trim()
  if (text === '') return EMPTY
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new WsProtocolError('invalid base64 payload', CLOSE_INVALID_PAYLOAD)
  }
  return Buffer.from(text, 'base64')
}

/**
 * Pump bytes between one WebSocket transport and one TCP transport.
 *
 * Both arguments only need the duplex surface `write/on/pause/resume/end/destroy`,
 * so tests drive it with event-emitting fakes and production with the upgraded
 * `net.Socket` plus the x11vnc connection.
 *
 * @param {object} options
 * @param {import('node:stream').Duplex} options.wsSocket the upgraded HTTP socket.
 * @param {import('node:stream').Duplex} options.tcpSocket the connection to 127.0.0.1:rfbPort.
 * @param {'binary'|'base64'} options.subprotocol negotiated subprotocol.
 * @param {number} [options.maxFrameBytes] frame size cap.
 * @param {Buffer} [options.head] bytes already read past the HTTP request line.
 * @param {(level: string, message: string) => void} [options.log] diagnostic sink.
 * @returns {{close: (code?: number, reason?: string) => void, dispose: () => void, bytesToTcp: number, bytesToWs: number, closed: boolean}} bridge handle.
 */
export function createBridge({ wsSocket, tcpSocket, subprotocol, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES, head, log }) {
  const decoder = new FrameDecoder({ maxFrameBytes })
  // `closed` means no more payload is forwarded; `torn` means the transports are
  // gone. They differ exactly while the close handshake flushes its frame.
  const state = { bytesToTcp: 0, bytesToWs: 0, closed: false, closeSent: false, torn: false, forceTimer: null }

  /**
   * The close handshake, as a table.
   *
   * Three booleans described it and the difference between two of them exists for exactly
   * one moment — `closed` with `!torn` is "flushing a close frame, transports still up".
   * Naming the states makes that moment a state instead of a combination a reader has to
   * reconstruct, and gives the flush timeout somewhere to say what it does.
   *
   * - `open`       — payload flows both ways.
   * - `flushing`   — `close()` ran; the close frame is going out, transports still up.
   * - `torn`       — both transports destroyed; nothing else may be written.
   *
   * `closeSent` stays a flag on purpose: it is a property of the handshake ("has the frame
   * been queued"), not a state — a write can be attempted before and after it flips.
   */
  const CLOSE_TRANSITIONS = {
    open: { shutdown: 'flushing', teardown: 'torn' },
    flushing: { teardown: 'torn' },
    torn: {},
  }

  /** The lifecycle state the three flags encode. */
  const closeState = () => (state.torn ? 'torn' : state.closed ? 'flushing' : 'open')

  /**
   * Move the handshake to `event` and report where it landed.
   *
   * @param event - one of the events named on the table.
   * @returns the state after the event.
   */
  const advanceClose = (event) => {
    const row = CLOSE_TRANSITIONS[closeState()]
    const next = row === undefined ? undefined : row[event]
    if (next === 'flushing') state.closed = true
    if (next === 'torn') { state.closed = true; state.torn = true }
    return closeState()
  }

  const note = (level, message) => {
    if (typeof log === 'function') {
      try {
        log(level, message)
      } catch {
        // Diagnostics must never break the bridge.
      }
    }
  }

  const writeSocket = (frame) => {
    if (state.torn || wsSocket.destroyed === true) return false
    try {
      return wsSocket.write(frame) !== false
    } catch (error) {
      note('warn', `ws write failed: ${error?.message ?? error}`)
      dispose()
      return false
    }
  }

  const sendClose = (code, reason) => {
    if (state.closeSent) return
    state.closeSent = true
    writeSocket(encodeClose(code, reason))
  }

  const stopTimer = () => {
    if (state.forceTimer !== null) {
      clearTimeout(state.forceTimer)
      state.forceTimer = null
    }
  }

  const destroyBoth = () => {
    stopTimer()
    advanceClose('teardown')
    for (const socket of [wsSocket, tcpSocket]) {
      try {
        if (socket.destroyed !== true) socket.destroy()
      } catch {
        // Teardown is best-effort.
      }
    }
  }

  /** Close the session: flush a close frame, then end both transports. */
  const close = (code = CLOSE_NORMAL, reason = '') => {
    if (closeState() !== 'open') return
    advanceClose('shutdown')
    stopTimer()
    sendClose(code, reason)
    try {
      if (tcpSocket.destroyed !== true) tcpSocket.end()
    } catch {
      // ignore
    }
    try {
      if (wsSocket.destroyed !== true) wsSocket.end()
    } catch {
      // ignore
    }
    state.forceTimer = setTimeout(destroyBoth, 1000)
    state.forceTimer.unref?.()
  }

  /** Tear down immediately, without a close frame (plugin unload path). */
  const dispose = () => {
    if (state.torn) return
    destroyBoth()
  }

  const fail = (error) => {
    const code = error instanceof WsProtocolError ? error.closeCode : CLOSE_PROTOCOL_ERROR
    note('warn', `desktop-vnc websocket: ${error?.message ?? error}`)
    close(code, error instanceof Error && error.name === 'WsProtocolError' ? error.message.slice(0, 120) : '')
  }

  const onWsData = (chunk) => {
    if (state.closed) return
    let events
    try {
      events = decoder.push(chunk)
    } catch (error) {
      fail(error)
      return
    }
    for (const event of events) {
      if (state.closed) return
      if (event.type === 'message') {
        let payload
        try {
          payload = decodePayload(event, subprotocol)
        } catch (error) {
          fail(error)
          return
        }
        if (payload.length === 0) continue
        state.bytesToTcp += payload.length
        if (tcpSocket.write(payload) === false) {
          wsSocket.pause?.()
          tcpSocket.once('drain', () => wsSocket.resume?.())
        }
      } else if (event.type === 'ping') {
        writeSocket(encodeFrame(OPCODE_PONG, event.payload))
      } else if (event.type === 'close') {
        // Echo the peer's close code when it sent a usable one (RFC 6455 §5.5.1).
        const echo = event.code >= 1000 && event.code < 5000 ? event.code : CLOSE_NORMAL
        close(echo, '')
        return
      }
      // pong frames need no answer.
    }
  }

  const onTcpData = (chunk) => {
    if (state.closed) return
    const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (body.length === 0) return
    state.bytesToWs += body.length
    const ok = writeSocket(encodePayload(body, subprotocol))
    if (!ok && state.closed === false) {
      tcpSocket.pause?.()
      wsSocket.once('drain', () => tcpSocket.resume?.())
    }
  }

  const onTcpEnd = () => {
    if (state.closed) return
    close(CLOSE_NORMAL, 'vnc stream closed')
  }

  const onWsEnd = () => {
    if (state.closed) return
    close(CLOSE_NORMAL, '')
  }

  wsSocket.on('data', onWsData)
  wsSocket.on('end', onWsEnd)
  wsSocket.on('error', () => dispose())
  wsSocket.on('close', () => {
    if (state.closed === false) dispose()
    else stopTimer()
  })
  tcpSocket.on('data', onTcpData)
  tcpSocket.on('end', onTcpEnd)
  tcpSocket.on('error', () => dispose())
  tcpSocket.on('close', () => {
    if (state.closed === false) dispose()
  })

  if (head !== undefined && head !== null && head.length > 0) onWsData(head)

  return {
    close,
    dispose,
    get closed() {
      return state.closed
    },
    get bytesToTcp() {
      return state.bytesToTcp
    },
    get bytesToWs() {
      return state.bytesToWs
    },
  }
}
