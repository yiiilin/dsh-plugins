/**
 * Unit tests for the hand-written RFC 6455 server: handshake, origin check,
 * frame codec (mask/fragment/three length forms/control frames) and the
 * WebSocket ↔ TCP byte pump, driven with fake duplex sockets instead of real
 * ones.
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import {
  CLOSE_MESSAGE_TOO_BIG,
  FrameDecoder,
  OPCODE_BINARY,
  OPCODE_CLOSE,
  OPCODE_CONTINUATION,
  OPCODE_PING,
  OPCODE_PONG,
  OPCODE_TEXT,
  WsProtocolError,
  acceptKey,
  createBridge,
  decodePayload,
  encodeClose,
  encodeFrame,
  encodePayload,
  isAllowedOrigin,
  isSameOriginRequest,
  localOrigins,
  normalizeOrigin,
  parseHandshake,
  selectSubprotocol,
} from '../ws.js'

/** Build one masked client frame, as a browser would send it. */
function clientFrame(opcode, payload = Buffer.alloc(0), { fin = true, mask = [1, 2, 3, 4], forceLength } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const useMask = mask !== null
  const length = forceLength ?? body.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 0x10000) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeUInt32BE(Math.floor(length / 0x100000000), 2)
    header.writeUInt32BE(length >>> 0, 6)
  }
  header[0] = (fin ? 0x80 : 0) | opcode
  if (useMask) header[1] |= 0x80
  const parts = [header]
  if (useMask) {
    const maskBytes = Buffer.from(mask)
    parts.push(maskBytes)
    const masked = Buffer.from(body)
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= maskBytes[i & 3]
    parts.push(masked)
  } else {
    parts.push(body)
  }
  return Buffer.concat(parts)
}

/** Parse a server frame back out of raw bytes. */
function parseServerFrame(buffer) {
  const opcode = buffer[0] & 0x0f
  const fin = (buffer[0] & 0x80) !== 0
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    length = buffer.readUInt32BE(6)
    offset = 10
  }
  return { opcode, fin, masked, payload: buffer.subarray(offset, offset + length) }
}

test('the handshake Accept value matches RFC 6455', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  assert.equal(acceptKey('x3JJHMbDL1EzLkh9GBhXDw=='), 'HSmrc0sMlYUkAGmm5OPpG2HaGWk=')
})

test('a valid upgrade request is accepted and echoes the chosen subprotocol', () => {
  const result = parseHandshake({
    headers: {
      upgrade: 'websocket',
      connection: 'keep-alive, Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': 'binary',
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.accept, 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
  assert.equal(result.subprotocol, 'binary')
})

test('subprotocol negotiation prefers the first offered supported token', () => {
  assert.equal(selectSubprotocol('binary, base64'), 'binary')
  assert.equal(selectSubprotocol('base64, binary'), 'base64')
  assert.equal(selectSubprotocol('chat, base64'), 'base64')
  assert.equal(selectSubprotocol('chat'), null)
  assert.equal(selectSubprotocol(''), null)
  assert.equal(selectSubprotocol(undefined), null)
})

test('a non-websocket or incomplete request is refused', () => {
  assert.equal(parseHandshake({ headers: {} }).ok, false)
  assert.equal(parseHandshake({ headers: { upgrade: 'h2c', connection: 'upgrade', 'sec-websocket-key': 'a' } }).status, 400)
  assert.equal(parseHandshake({ headers: { upgrade: 'websocket', connection: 'upgrade' } }).status, 400)
  const versioned = parseHandshake({
    headers: { upgrade: 'websocket', connection: 'upgrade', 'sec-websocket-key': 'a', 'sec-websocket-version': '8' },
  })
  assert.equal(versioned.ok, false)
  assert.equal(versioned.status, 426)
  assert.equal(versioned.version, '13')
})

test('origin checking allows the bound listener and loopback spellings only', () => {
  const allowed = localOrigins('http://127.0.0.1:3080')
  assert.equal(isAllowedOrigin('http://127.0.0.1:3080', allowed), true)
  assert.equal(isAllowedOrigin('http://localhost:3080', allowed), true)
  assert.equal(isAllowedOrigin('http://127.0.0.1:3080', allowed), true)
  // A foreign page must never borrow the user's browser to reach the desktop.
  assert.equal(isAllowedOrigin('https://evil.example', allowed), false)
  assert.equal(isAllowedOrigin('http://127.0.0.1:9999', allowed), false)
  assert.equal(isAllowedOrigin('null', allowed), false)
  assert.equal(isAllowedOrigin('file:///tmp/x.html', allowed), false)
  // An absent Origin is allowed: non-browser clients are outside this threat model.
  assert.equal(isAllowedOrigin(undefined, allowed), true)
  assert.equal(normalizeOrigin('HTTP://LocalHost:3080'), 'http://localhost:3080')
  assert.equal(normalizeOrigin('nonsense'), null)
})

test('same-origin accepts every address the listener is actually reached by', () => {
  // Regression: the harness binds one port on several interfaces at once, so a
  // literal loopback allow-list answered 403 to LAN and proxied visitors and the
  // panel never left "not connected".
  const allowed = localOrigins('http://127.0.0.1:3080')
  const accept = [
    ['http://127.0.0.1:3080', '127.0.0.1:3080'],
    ['http://localhost:3080', 'localhost:3080'],
    ['http://192.168.55.155:3080', '192.168.55.155:3080'],
    ['http://10.10.10.222:3080', '10.10.10.222:3080'],
    // A TLS terminator in front of a plain listener: same host, other scheme.
    ['https://dsh.yiln.de', 'dsh.yiln.de'],
  ]
  for (const [origin, host] of accept) {
    assert.equal(isSameOriginRequest(origin, host, allowed), true, `${origin} via ${host}`)
  }
})

test('same-origin still refuses a foreign page and a mismatched Host', () => {
  const allowed = localOrigins('http://127.0.0.1:3080')
  const refuse = [
    // The actual attack: any site could otherwise drive the local VNC port.
    ['https://evil.example', '192.168.55.155:3080'],
    ['https://evil.example', '127.0.0.1:3080'],
    // An Origin that does not name the Host it addressed.
    ['http://192.168.55.155:3080', '127.0.0.1:3080'],
    ['null', '127.0.0.1:3080'],
    ['file:///tmp/x.html', '127.0.0.1:3080'],
    // A non-allow-listed origin cannot fall back on an absent Host.
    ['http://192.168.55.155:3080', ''],
    ['http://192.168.55.155:3080', undefined],
  ]
  for (const [origin, host] of refuse) {
    assert.equal(isSameOriginRequest(origin, host, allowed), false, `${origin} via ${host}`)
  }
  // Same host, differing port is a different origin.
  assert.equal(isSameOriginRequest('http://127.0.0.1:3081', '127.0.0.1:3080', allowed), false)
  // An absent Origin stays allowed, as for `isAllowedOrigin`.
  assert.equal(isSameOriginRequest(undefined, '192.168.55.155:3080', allowed), true)
  // An explicitly allow-listed loopback spelling is accepted even when a proxy
  // rewrote the Host, because it already names this machine.
  assert.equal(isSameOriginRequest('http://127.0.0.1:3080', 'dsh.internal', allowed), true)
})

test('a 7-bit-length masked binary frame is unmasked', () => {
  const decoder = new FrameDecoder()
  const events = decoder.push(clientFrame(OPCODE_BINARY, Buffer.from('hello'), { mask: [0xaa, 0xbb, 0xcc, 0xdd] }))
  assert.equal(events.length, 1)
  assert.equal(events[0].type, 'message')
  assert.equal(events[0].opcode, OPCODE_BINARY)
  assert.equal(events[0].payload.toString(), 'hello')
})

test('16-bit and 64-bit length forms round-trip', () => {
  const sixteen = Buffer.alloc(300, 0x41)
  const sixtyFour = Buffer.alloc(70000, 0x42)
  const decoder = new FrameDecoder()

  const first = decoder.push(clientFrame(OPCODE_BINARY, sixteen))
  assert.equal(first[0].payload.length, 300)

  const second = decoder.push(clientFrame(OPCODE_BINARY, sixtyFour))
  assert.equal(second[0].payload.length, 70000)
  assert.ok(second[0].payload.every((byte) => byte === 0x42))
})

test('a frame split across TCP reads is buffered until complete', () => {
  const decoder = new FrameDecoder()
  const frame = clientFrame(OPCODE_BINARY, Buffer.from('abcdefghij'))
  assert.deepEqual(decoder.push(frame.subarray(0, 3)), [])
  assert.deepEqual(decoder.push(frame.subarray(3, 7)), [])
  const events = decoder.push(frame.subarray(7))
  assert.equal(events[0].payload.toString(), 'abcdefghij')
})

test('fragmented messages reassemble across continuation frames', () => {
  const decoder = new FrameDecoder()
  assert.deepEqual(decoder.push(clientFrame(OPCODE_TEXT, Buffer.from('Hel'), { fin: false })), [])
  assert.deepEqual(decoder.push(clientFrame(OPCODE_CONTINUATION, Buffer.from('lo '), { fin: false })), [])
  const events = decoder.push(clientFrame(OPCODE_CONTINUATION, Buffer.from('world')))
  assert.equal(events.length, 1)
  assert.equal(events[0].opcode, OPCODE_TEXT)
  assert.equal(events[0].payload.toString(), 'Hello world')
})

test('a continuation without a start, or interleaved data, is a protocol error', () => {
  const decoder = new FrameDecoder()
  assert.throws(() => decoder.push(clientFrame(OPCODE_CONTINUATION, Buffer.from('x'))), WsProtocolError)

  const second = new FrameDecoder()
  second.push(clientFrame(OPCODE_TEXT, Buffer.from('a'), { fin: false }))
  assert.throws(() => second.push(clientFrame(OPCODE_TEXT, Buffer.from('b'))), WsProtocolError)
})

test('ping and pong payloads survive an interleaved fragmented message', () => {
  const decoder = new FrameDecoder()
  decoder.push(clientFrame(OPCODE_TEXT, Buffer.from('a'), { fin: false }))
  const ping = decoder.push(clientFrame(OPCODE_PING, Buffer.from('beat')))
  assert.equal(ping[0].type, 'ping')
  assert.equal(ping[0].payload.toString(), 'beat')
  const pong = decoder.push(clientFrame(OPCODE_PONG, Buffer.from('back')))
  assert.equal(pong[0].type, 'pong')
  const done = decoder.push(clientFrame(OPCODE_CONTINUATION, Buffer.from('b')))
  assert.equal(done[0].payload.toString(), 'ab')
})

test('close frames report the code and reason', () => {
  const decoder = new FrameDecoder()
  const payload = Buffer.alloc(5)
  payload.writeUInt16BE(1000, 0)
  payload.write('bye', 2)
  const events = decoder.push(clientFrame(OPCODE_CLOSE, payload))
  assert.equal(events[0].type, 'close')
  assert.equal(events[0].code, 1000)
  assert.equal(events[0].reason, 'bye')
})

test('an unmasked client frame is rejected', () => {
  const decoder = new FrameDecoder()
  assert.throws(() => decoder.push(clientFrame(OPCODE_BINARY, Buffer.from('x'), { mask: null })), WsProtocolError)
})

test('a frame above the limit closes with 1009, including across fragments', () => {
  const decoder = new FrameDecoder({ maxFrameBytes: 64 })
  assert.throws(() => decoder.push(clientFrame(OPCODE_BINARY, Buffer.alloc(128), { forceLength: 128 })), (error) => {
    assert.ok(error instanceof WsProtocolError)
    assert.equal(error.closeCode, CLOSE_MESSAGE_TOO_BIG)
    return true
  })

  const small = new FrameDecoder({ maxFrameBytes: 64 })
  small.push(clientFrame(OPCODE_BINARY, Buffer.alloc(40), { fin: false }))
  assert.throws(() => small.push(clientFrame(OPCODE_CONTINUATION, Buffer.alloc(40))), WsProtocolError)
})

test('control frames may not be fragmented or oversized', () => {
  const fragmented = new FrameDecoder()
  assert.throws(() => fragmented.push(clientFrame(OPCODE_PING, Buffer.from('x'), { fin: false })), WsProtocolError)
  const oversized = new FrameDecoder()
  assert.throws(() => oversized.push(clientFrame(OPCODE_PING, Buffer.alloc(200), { forceLength: 200 })), WsProtocolError)
})

test('reserved bits and unknown opcodes are refused', () => {
  const frame = clientFrame(OPCODE_BINARY, Buffer.from('x'))
  const reserved = Buffer.from(frame)
  reserved[0] |= 0x40
  assert.throws(() => new FrameDecoder().push(reserved), WsProtocolError)
  assert.throws(() => new FrameDecoder().push(clientFrame(0x3, Buffer.from('x'))), WsProtocolError)
})

test('server frames are never masked and use the matching length form', () => {
  const small = parseServerFrame(encodeFrame(OPCODE_TEXT, Buffer.from('ok')))
  assert.equal(small.masked, false)
  assert.equal(small.opcode, OPCODE_TEXT)
  assert.equal(small.payload.toString(), 'ok')

  const medium = parseServerFrame(encodeFrame(OPCODE_BINARY, Buffer.alloc(200)))
  assert.equal(medium.masked, false)
  assert.equal(medium.payload.length, 200)

  const large = parseServerFrame(encodeFrame(OPCODE_BINARY, Buffer.alloc(66000)))
  assert.equal(large.masked, false)
  assert.equal(large.payload.length, 66000)
})

test('close frames carry the code and truncate an over-long reason', () => {
  const frame = parseServerFrame(encodeClose(1011, 'x'.repeat(500)))
  assert.equal(frame.opcode, OPCODE_CLOSE)
  assert.equal(frame.payload.readUInt16BE(0), 1011)
  assert.ok(frame.payload.length <= 125)
})

test('base64 subprotocol encodes and decodes the same bytes', () => {
  const original = Buffer.from([0xff, 0x00, 0x81, 0x7f])
  const frame = parseServerFrame(encodePayload(original, 'base64'))
  assert.equal(frame.opcode, OPCODE_TEXT)
  const decoded = decodePayload({ payload: frame.payload }, 'base64')
  assert.deepEqual(decoded, original)

  const binary = parseServerFrame(encodePayload(original, 'binary'))
  assert.equal(binary.opcode, OPCODE_BINARY)
  assert.deepEqual(binary.payload, original)

  // Invalid base64 is a payload error, not silent corruption.
  assert.throws(() => decodePayload({ payload: Buffer.from('!!not base64!!') }, 'base64'), WsProtocolError)
})

/**
 * A socket double with INDEPENDENT directions, the way a real `net.Socket` is.
 *
 * A `PassThrough` would be wrong here: it loops everything written back into its
 * own readable side, so the bridge's outbound pong/close frames would re-enter
 * its decoder as if the client had sent them. `feed()` is inbound, `written` is
 * outbound, and neither touches the other.
 */
function fakeSocket() {
  const socket = new EventEmitter()
  const written = []
  socket.destroyed = false
  socket.writableEnded = false
  socket.write = (chunk) => {
    written.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)))
    return true
  }
  socket.end = () => {
    if (socket.writableEnded) return
    socket.writableEnded = true
    socket.emit('end')
  }
  socket.destroy = () => {
    socket.destroyed = true
  }
  socket.pause = () => {}
  socket.resume = () => {}
  return {
    socket,
    written,
    /** Deliver bytes as if the peer had just sent them. */
    feed(chunk) {
      socket.emit('data', Buffer.from(chunk))
    },
    /** Simulate the peer closing its half of the connection. */
    finish() {
      socket.emit('end')
    },
  }
}

test('WebSocket binary frames are forwarded to TCP byte-for-byte', async () => {
  const ws = fakeSocket()
  const tcp = fakeSocket()
  const bridge = createBridge({ wsSocket: ws.socket, tcpSocket: tcp.socket, subprotocol: 'binary' })

  ws.feed(clientFrame(OPCODE_BINARY, Buffer.from([0x52, 0x46, 0x42, 0x20])))
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(tcp.written.length, 1)
  assert.deepEqual(tcp.written[0], Buffer.from([0x52, 0x46, 0x42, 0x20]))
  assert.equal(bridge.bytesToTcp, 4)
  bridge.dispose()
})

test('TCP bytes come back as WebSocket binary frames, and as text under base64', async () => {
  const ws = fakeSocket()
  const tcp = fakeSocket()
  const bridge = createBridge({ wsSocket: ws.socket, tcpSocket: tcp.socket, subprotocol: 'binary' })

  tcp.feed(Buffer.from([0x01, 0x02]))
  await new Promise((resolve) => setImmediate(resolve))
  const frame = parseServerFrame(ws.written[0])
  assert.equal(frame.opcode, OPCODE_BINARY)
  assert.deepEqual(frame.payload, Buffer.from([0x01, 0x02]))
  bridge.dispose()

  const ws2 = fakeSocket()
  const tcp2 = fakeSocket()
  const bridge2 = createBridge({ wsSocket: ws2.socket, tcpSocket: tcp2.socket, subprotocol: 'base64' })
  tcp2.feed(Buffer.from('RFB 003.008\n'))
  await new Promise((resolve) => setImmediate(resolve))
  const textFrame = parseServerFrame(ws2.written[0])
  assert.equal(textFrame.opcode, OPCODE_TEXT)
  assert.equal(Buffer.from(textFrame.payload.toString(), 'base64').toString(), 'RFB 003.008\n')
  bridge2.dispose()
})

test('a client ping is answered with a pong carrying the same payload', async () => {
  const ws = fakeSocket()
  const tcp = fakeSocket()
  const bridge = createBridge({ wsSocket: ws.socket, tcpSocket: tcp.socket, subprotocol: 'binary' })

  ws.feed(clientFrame(OPCODE_PING, Buffer.from('beat')))
  await new Promise((resolve) => setImmediate(resolve))

  const frame = parseServerFrame(ws.written[0])
  assert.equal(frame.opcode, OPCODE_PONG)
  assert.equal(frame.payload.toString(), 'beat')
  assert.equal(tcp.written.length, 0)
  bridge.dispose()
})

test('a TCP close sends a WebSocket close frame', async () => {
  const ws = fakeSocket()
  const tcp = fakeSocket()
  const bridge = createBridge({ wsSocket: ws.socket, tcpSocket: tcp.socket, subprotocol: 'binary' })

  tcp.finish()
  await new Promise((resolve) => setImmediate(resolve))

  const frame = parseServerFrame(ws.written[0])
  assert.equal(frame.opcode, OPCODE_CLOSE)
  assert.equal(frame.payload.readUInt16BE(0), 1000)
  assert.equal(bridge.closed, true)
  bridge.dispose()
})

test('a protocol error closes the session with the matching code', async () => {
  const ws = fakeSocket()
  const tcp = fakeSocket()
  const bridge = createBridge({
    wsSocket: ws.socket,
    tcpSocket: tcp.socket,
    subprotocol: 'binary',
    maxFrameBytes: 32,
  })

  ws.feed(clientFrame(OPCODE_BINARY, Buffer.alloc(64), { forceLength: 64 }))
  await new Promise((resolve) => setImmediate(resolve))

  const frame = parseServerFrame(ws.written[0])
  assert.equal(frame.opcode, OPCODE_CLOSE)
  assert.equal(frame.payload.readUInt16BE(0), CLOSE_MESSAGE_TOO_BIG)
  assert.equal(bridge.closed, true)
  bridge.dispose()
})

test('a client close is echoed and TCP is released', async () => {
  const ws = fakeSocket()
  const tcp = fakeSocket()
  const bridge = createBridge({ wsSocket: ws.socket, tcpSocket: tcp.socket, subprotocol: 'binary' })

  const payload = Buffer.alloc(2)
  payload.writeUInt16BE(1001, 0)
  ws.feed(clientFrame(OPCODE_CLOSE, payload))
  await new Promise((resolve) => setImmediate(resolve))

  const frame = parseServerFrame(ws.written[0])
  assert.equal(frame.opcode, OPCODE_CLOSE)
  assert.equal(frame.payload.readUInt16BE(0), 1001)
  assert.equal(bridge.closed, true)
  assert.equal(tcp.socket.writableEnded, true)
  bridge.dispose()
})

test('bytes already read past the request line are replayed into the decoder', async () => {
  const ws = fakeSocket()
  const tcp = fakeSocket()
  const head = clientFrame(OPCODE_BINARY, Buffer.from('early'))
  const bridge = createBridge({ wsSocket: ws.socket, tcpSocket: tcp.socket, subprotocol: 'binary', head })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(tcp.written[0].toString(), 'early')
  bridge.dispose()
})

test('a closed bridge forwards no further payload, and one close frame is sent', async () => {
  // `closed` and `torn` differ for exactly one moment — while the close frame flushes.
  // That moment is a state now rather than a combination a reader has to reconstruct.
  const ws = fakeSocket()
  const tcp = fakeSocket()
  const bridge = createBridge({ wsSocket: ws.socket, tcpSocket: tcp.socket, subprotocol: 'binary' })

  bridge.close(1000, 'done')
  assert.equal(bridge.closed, true)

  const afterClose = ws.written.length
  ws.feed(clientFrame(OPCODE_BINARY, Buffer.from([0x01])))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(tcp.written.length, 0, 'no payload reaches TCP once closed')

  // A second close must not queue a second frame: the peer would see two handshakes.
  bridge.close(1000, 'again')
  assert.equal(ws.written.length, afterClose, 'the close frame was already sent')
  bridge.dispose()
})

test('closing a bridge twice is inert', () => {
  const ws = fakeSocket()
  const tcp = fakeSocket()
  const bridge = createBridge({ wsSocket: ws.socket, tcpSocket: tcp.socket, subprotocol: 'binary' })
  bridge.close()
  assert.doesNotThrow(() => bridge.close())
  bridge.dispose()
})
