/**
 * How a file's bytes are encoded for the tunnel.
 *
 * Two decisions live here, and both are measured rather than assumed.
 *
 * **No base64.** A frame payload is raw bytes, so the base64 layer that used to wrap
 * every chunk was pure overhead: it inflated each transfer by a third to fit inside a
 * JSON field that no longer carries the file. Chunks are `Buffer`s on the wire now.
 *
 * **zstd, but only when it helps.** Measured on this machine: 1 MiB of text compresses
 * to 162 bytes, while 1 MiB of random bytes compresses to 1,048,609 — one byte larger
 * than the input. Compressing blindly would make already-compressed and random files
 * slower and very slightly bigger, so the sender probes the first chunk, keeps whichever
 * form is smaller, and records the choice in the transfer description so the receiver
 * never has to guess.
 *
 * Each chunk is its own zstd frame on purpose: a chunk is sent as an independent message,
 * so it must decompress without the ones before it.
 *
 * @module @yiln-dsh/dsh-gateway/transfer-codec
 */

import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** Encoding tags carried alongside a transfer. */
export const ENCODING = {
  /** Chunks are the file's own bytes. */
  raw: 'raw',
  /** Every chunk is an independent zstd frame. */
  zstd: 'zstd',
}

/** zstd level 3: the library default, and enough for the text this mostly carries. */
export const ZSTD_LEVEL = 3

/**
 * Compress one buffer.
 *
 * @param buffer - the bytes.
 * @returns the compressed bytes.
 */
export function compress(buffer) {
  return zstdCompressSync(buffer, { params: { [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } })
}

/**
 * Decompress one buffer.
 *
 * @param buffer - a zstd frame.
 * @returns the original bytes.
 */
export function decompress(buffer) {
  return zstdDecompressSync(buffer)
}

/**
 * Decide how one transfer should be encoded.
 *
 * Only the sample is compressed to make the decision; the caller compresses the real
 * chunks with whatever was chosen. Comparing encoded sizes is the only reliable test —
 * entropy heuristics misjudge formats that are already compressed, and this costs one
 * small compression instead of a wrong guess for the whole file.
 *
 * @param sample - the first chunk (or the whole file when it is small).
 * @returns `{ encoding, sample }`; `sample` is already encoded in the chosen form.
 */
export function chooseEncoding(sample) {
  if (sample.length === 0) return { encoding: ENCODING.raw, sample }
  const packed = compress(sample)
  // Only worth it when the compressed form is genuinely smaller; a tie goes to raw
  // because it avoids a decompression step on the receiving end.
  if (packed.length < sample.length) return { encoding: ENCODING.zstd, sample: packed }
  return { encoding: ENCODING.raw, sample }
}

/**
 * Encode one chunk in the transfer's chosen form.
 *
 * @param buffer - the chunk's bytes.
 * @param encoding - `raw` or `zstd`.
 * @returns the bytes to put on the wire.
 */
export function encodeChunk(buffer, encoding) {
  return encoding === ENCODING.zstd ? compress(buffer) : buffer
}

/**
 * Decode one chunk in the transfer's chosen form.
 *
 * @param buffer - the bytes received.
 * @param encoding - `raw` or `zstd`.
 * @returns the chunk's original bytes.
 */
export function decodeChunk(buffer, encoding) {
  return encoding === ENCODING.zstd ? decompress(buffer) : buffer
}
