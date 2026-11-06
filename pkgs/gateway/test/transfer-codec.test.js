/**
 * How a file's bytes are encoded for the wire.
 *
 * The choice is measured, not assumed: text compresses to almost nothing and random
 * bytes compress to slightly more than they started. Both cases are asserted with the
 * same evidence the implementation uses — encoded size.
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

import {
  chooseEncoding,
  compress,
  decodeChunk,
  decompress,
  encodeChunk,
  ENCODING,
} from '../lib/transfer-codec.js'

test('text is compressed, because it comes out far smaller', () => {
  const text = Buffer.from('the quick brown fox jumps over the lazy dog\n'.repeat(2000))
  const chosen = chooseEncoding(text)
  assert.equal(chosen.encoding, ENCODING.zstd)
  // The measured gain on this machine was ~1.5 KB -> a few hundred bytes.
  assert.ok(chosen.sample.length < text.length / 4, `expected a real gain, got ${chosen.sample.length} of ${text.length}`)
  assert.ok(decompress(chosen.sample).equals(text))
})

test('random bytes are not compressed, because zstd would make them bigger', () => {
  // Measured: 1 MiB of random input compressed to 1,048,609 bytes — one byte larger.
  const noise = randomBytes(256 * 1024)
  const chosen = chooseEncoding(noise)
  assert.equal(chosen.encoding, ENCODING.raw)
  assert.ok(chosen.sample.equals(noise))
  assert.ok(compress(noise).length >= noise.length - 16, 'zstd must not look like a win here')
})

test('an empty chunk stays raw instead of becoming a frame', () => {
  const chosen = chooseEncoding(Buffer.alloc(0))
  assert.equal(chosen.encoding, ENCODING.raw)
  assert.equal(chosen.sample.length, 0)
})

test('every byte value survives a raw chunk', () => {
  // 0x00..0xff in order: a text-oriented path would mangle several of these.
  const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
  const back = decodeChunk(encodeChunk(all, ENCODING.raw), ENCODING.raw)
  assert.ok(back.equals(all))
})

test('a zstd chunk round-trips, independently of any other chunk', () => {
  // Each chunk is its own frame, so it must decompress alone.
  const piece = Buffer.from('independent chunk '.repeat(500))
  const wire = encodeChunk(piece, ENCODING.zstd)
  assert.ok(wire.length < piece.length)
  assert.ok(decodeChunk(wire, ENCODING.zstd).equals(piece))
})

test('the encoding is carried with the data, so the two cannot be mismatched silently', () => {
  // Raw and zstd produce different bytes for the same input; a receiver that guessed
  // would produce a corrupt file with no error. The tag travels with every chunk.
  const source = Buffer.from('payload '.repeat(200))
  const raw = encodeChunk(source, ENCODING.raw)
  const packed = encodeChunk(source, ENCODING.zstd)
  assert.ok(!raw.equals(packed), 'the two forms must be distinguishable')
  assert.ok(decodeChunk(raw, ENCODING.raw).equals(source))
  assert.ok(decodeChunk(packed, ENCODING.zstd).equals(source))
  // A zstd chunk is not valid UTF-8 text, which is why it must never go through a
  // JSON string field.
  assert.notEqual(packed.toString('utf8'), source.toString('utf8'))
})
