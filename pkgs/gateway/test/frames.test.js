/**
 * The tunnel's wire format.
 *
 * Three frame types and nothing else: the tunnel is a byte pipe, so a frame says only
 * which stream it belongs to. Everything about requests, responses and protocols lives
 * above this layer.
 *
 * The reader is the part worth testing hard. It receives whatever the socket hands it —
 * a whole frame, half of one, or several at once — and the first draft of it silently
 * dropped bytes, which no type system would have caught.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  encodeFrame,
  encodeJsonFrame,
  FRAME,
  FrameReader,
  MAX_FRAME_BYTES,
  newRequestId,
} from '../lib/federation/frames.js'

/** One open + data + end sequence, as it would arrive on a socket. */
const stream = (id, payload = Buffer.from('hello')) => Buffer.concat([
  encodeJsonFrame(FRAME.open, id, { toEnvId: 'edge-a' }),
  encodeFrame(FRAME.data, id, payload),
  encodeFrame(FRAME.end, id),
])

// --- encoding -----------------------------------------------------------------

test('a frame carries its type, stream id and payload', () => {
  const id = newRequestId()
  const wire = encodeFrame(FRAME.data, id, Buffer.from('abc'))
  // 4 length + 1 type + 16 id + 3 payload
  assert.equal(wire.length, 24)
  assert.equal(wire.readUInt32BE(0), 3)
  assert.equal(wire.readUInt8(4), FRAME.data)
  assert.ok(wire.subarray(5, 21).equals(id))
  assert.equal(wire.subarray(21).toString(), 'abc')
})

test('a JSON frame round-trips its object', () => {
  const id = newRequestId()
  const reader = new FrameReader()
  const [frame] = reader.push(encodeJsonFrame(FRAME.open, id, { toEnvId: 'edge-a', port: 3080 }))
  assert.equal(frame.type, FRAME.open)
  assert.deepEqual(JSON.parse(frame.payload.toString()), { toEnvId: 'edge-a', port: 3080 })
})

test('a payload over the frame limit is refused when encoding', () => {
  const id = newRequestId()
  assert.throws(
    () => encodeFrame(FRAME.data, id, Buffer.alloc(MAX_FRAME_BYTES + 1)),
    /payload too large/u,
  )
})

test('a stream id must be 16 bytes', () => {
  assert.throws(() => encodeFrame(FRAME.data, Buffer.alloc(15), Buffer.alloc(0)), /16 bytes/u)
})

// --- reassembly ---------------------------------------------------------------

test('several frames in one chunk are all taken out', () => {
  const frames = new FrameReader().push(stream(newRequestId()))
  assert.deepEqual(frames.map((f) => f.type), [FRAME.open, FRAME.data, FRAME.end])
})

test('a frame split across chunks is reassembled', () => {
  // Byte at a time is the worst case, and the case a first draft got wrong: it kept the
  // new pieces and silently dropped the leftover, so nothing ever parsed.
  const reader = new FrameReader()
  const frames = []
  for (const byte of stream(newRequestId())) frames.push(...reader.push(Buffer.from([byte])))
  assert.deepEqual(frames.map((f) => f.type), [FRAME.open, FRAME.data, FRAME.end])
})

test('a payload survives arbitrary fragmentation, including every byte value', () => {
  const payload = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
  const wire = encodeFrame(FRAME.data, newRequestId(), payload)
  const reader = new FrameReader()
  const frames = []
  for (let at = 0; at < wire.length; at += 7) frames.push(...reader.push(wire.subarray(at, at + 7)))
  assert.equal(frames.length, 1)
  assert.ok(frames[0].payload.equals(payload), 'NUL and high bytes must survive')
})

test('the leftover of a partial frame is kept for the next chunk', () => {
  const reader = new FrameReader()
  const wire = stream(newRequestId())
  // Everything except the last three bytes: the `end` frame stays incomplete.
  const frames = reader.push(wire.subarray(0, wire.length - 3))
  assert.equal(frames.length, 2, 'open and data are complete')
  assert.equal(reader.buffered, 18, 'the truncated end frame is held, not dropped')
  const rest = reader.push(wire.subarray(wire.length - 3))
  assert.equal(rest.length, 1)
  assert.equal(rest[0].type, FRAME.end)
  assert.equal(reader.buffered, 0)
})

test('a declared length over the limit is refused rather than buffered', () => {
  const id = newRequestId()
  const header = Buffer.alloc(21)
  header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
  header.writeUInt8(FRAME.data, 4)
  id.copy(header, 5)
  assert.throws(() => new FrameReader().push(header), /exceeds/u)
})

test('a payload is a copy, not a window into the receive buffer', () => {
  // Aliasing would let a later chunk rewrite a frame the caller already holds.
  const id = newRequestId()
  const reader = new FrameReader()
  const [frame] = reader.push(encodeFrame(FRAME.data, id, Buffer.from('first')))
  reader.push(encodeFrame(FRAME.data, id, Buffer.from('second')))
  assert.equal(frame.payload.toString(), 'first')
})

// --- cost ---------------------------------------------------------------------

test('a large frame in small pieces stays linear', () => {
  // Joining on every arrival was quadratic: this took ~400 ms and now takes single-digit
  // milliseconds. The bound is loose enough not to flake, tight enough to catch a
  // return to per-chunk concatenation.
  const wire = encodeFrame(FRAME.data, newRequestId(), Buffer.alloc(1024 * 1024, 7))
  const reader = new FrameReader()
  const started = process.hrtime.bigint()
  for (let at = 0; at < wire.length; at += 512) reader.push(wire.subarray(at, at + 512))
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  assert.ok(ms < 100, `1 MiB in 512-byte pieces took ${ms.toFixed(1)} ms`)
})
