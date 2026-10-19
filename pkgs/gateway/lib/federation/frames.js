/**
 * Wire format for the federation tunnel.
 *
 * One WebSocket carries every request between a main node and an edge: HTTP calls to
 * the edge's harness, WebSocket upgrades, and management commands. They are told apart
 * by a request id and a small type tag, so several can be in flight at once without
 * waiting for each other.
 *
 * ```
 * [4 byte length][1 byte type][16 byte request id][payload]
 * ```
 *
 * The length prefix means a receiver never has to guess where a frame ends — the same
 * reason `dsh-ssh` uses one, and a lesson from every half-written protocol that tried to
 * rely on separators instead.
 *
 * @module @yiln-dsh/dsh-gateway/federation/frames
 */

/** Request/response lifecycle tags. */
import { randomBytes } from 'node:crypto'

/** Request/response lifecycle tags. */
export const FRAME = {
  /** JSON head of an HTTP request: method, path, headers. */
  requestHead: 1,
  /** Raw bytes of a request body. */
  requestBody: 2,
  /** Request body finished; no more body frames follow. */
  requestEnd: 3,
  /** JSON head of a response: status, headers. */
  responseHead: 4,
  /** Raw bytes of a response body. */
  responseBody: 5,
  /** Response finished. */
  responseEnd: 6,
  /** The caller went away; stop work and drop resources. */
  cancel: 7,
  /** Keeps a quiet connection from being reaped by intermediaries. */
  heartbeat: 8,
}

const HEADER_BYTES = 4
const TYPE_BYTES = 1
const ID_BYTES = 16
const PREFIX_BYTES = HEADER_BYTES + TYPE_BYTES + ID_BYTES

/** Upper bound for one frame. A larger value is treated as a corrupt stream. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

/**
 * Encode one frame.
 *
 * @param type - one of {@link FRAME}.
 * @param id - 16-byte request identifier.
 * @param payload - frame body, empty for terminators.
 * @returns the framed bytes.
 */
export function encodeFrame(type, id, payload = Buffer.alloc(0)) {
  if (id.length !== ID_BYTES) throw new Error(`federation: request id must be ${ID_BYTES} bytes, got ${id.length}`)
  if (type < 1 || type > 255) throw new Error(`federation: frame type out of range: ${type}`)
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  if (body.length > MAX_FRAME_BYTES) throw new Error(`federation: frame payload too large: ${body.length}`)
  const out = Buffer.allocUnsafe(PREFIX_BYTES + body.length)
  out.writeUInt32BE(body.length, 0)
  out.writeUInt8(type, HEADER_BYTES)
  id.copy(out, HEADER_BYTES + TYPE_BYTES)
  body.copy(out, PREFIX_BYTES)
  return out
}

/** Convenience: encode a frame whose payload is JSON. */
export function encodeJsonFrame(type, id, value) {
  return encodeFrame(type, id, Buffer.from(JSON.stringify(value), 'utf8'))
}

/**
 * Incremental frame reader.
 *
 * WebSocket delivers whatever arrived, not what the protocol wants, so frames are
 * reassembled across messages. A frame larger than {@link MAX_FRAME_BYTES} is rejected
 * rather than buffered: a corrupt length prefix must not be allowed to exhaust memory.
 */
export class FrameReader {
  /** Bytes received but not yet consumed into a complete frame. */
  buffer = Buffer.alloc(0)

  /**
   * Feed received bytes and take out every complete frame.
   *
   * @param chunk - bytes from the socket.
   * @returns complete frames, in arrival order.
   */
  push(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const frames = []
    for (;;) {
      if (this.buffer.length < HEADER_BYTES) break
      const length = this.buffer.readUInt32BE(0)
      if (length > MAX_FRAME_BYTES) {
        throw new Error(`federation: frame length ${length} exceeds the ${MAX_FRAME_BYTES} byte limit`)
      }
      if (this.buffer.length < PREFIX_BYTES + length) break
      const type = this.buffer.readUInt8(HEADER_BYTES)
      const id = this.buffer.subarray(HEADER_BYTES + TYPE_BYTES, PREFIX_BYTES)
      const payload = this.buffer.subarray(PREFIX_BYTES, PREFIX_BYTES + length)
      // `subarray` aliases the receive buffer, which the next `concat` may drop.
      frames.push({ type, id: Buffer.from(id), payload: Buffer.from(payload) })
      this.buffer = this.buffer.subarray(PREFIX_BYTES + length)
    }
    return frames
  }
}

/** A fresh request id. */
export function newRequestId() {
  return randomBytes(16)
}
