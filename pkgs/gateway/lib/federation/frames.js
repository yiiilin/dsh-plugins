/**
 * Wire format for the federation tunnel.
 *
 * The tunnel is a **byte pipe**. It moves streams from one environment to another and
 * understands nothing about what travels through them — no method, no path, no status.
 * That separation is the point: an HTTP request, a gRPC call and a WebSocket handshake
 * are all just bytes here, and a protocol the tunnel has never heard of works the same
 * as the one it was written for.
 *
 * An earlier version did understand HTTP: it encoded `method`/`path`/`headers` per
 * request and had dedicated frames for upgrades and file streaming. Every new need grew
 * another variant (`relay`, `stream-file`, `binary`), and one of them was already
 * unused. Routing lives in `open`; everything else is opaque.
 *
 * ```
 * open:  [4 length][1 type][16 streamId][JSON { toEnvId, port? }]
 * data:  [4 length][1 type][16 streamId][raw bytes]
 * end:   [4 length][1 type][16 streamId][empty]
 * ```
 *
 * The length prefix means a receiver never has to guess where a frame ends — the same
 * reason `dsh-ssh` uses one, and a lesson from every half-written protocol that tried to
 * rely on separators instead.
 *
 * @module @yiln-dsh/dsh-gateway/federation/frames
 */

import { randomBytes } from 'node:crypto'

/**
 * Frame tags.
 *
 * Three, and no direction bit: which side of a stream a frame belongs to follows from
 * whether its `streamId` is in the receiver's table, so the wire does not carry it.
 */
export const FRAME = {
  /** JSON `{ toEnvId, port? }`: open a stream toward one environment. */
  open: 1,
  /** Raw bytes belonging to an open stream. Never parsed by the tunnel. */
  data: 2,
  /** The stream is finished in this direction. */
  end: 3,
  /**
   * A topology snapshot from the main node. Not a stream: there is no data or end, and
   * its id is unused. It lives in this frame space rather than a parallel channel so a
   * node needs only one socket to learn the shape of the federation.
   */
  topology: 4,
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
 * @param id - 16-byte stream identifier.
 * @param payload - frame body, empty for terminators.
 * @returns the framed bytes.
 */
export function encodeFrame(type, id, payload = Buffer.alloc(0)) {
  if (id.length !== ID_BYTES) throw new Error(`federation: stream id must be ${ID_BYTES} bytes, got ${id.length}`)
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

/**
 * Encode one frame whose payload is JSON.
 *
 * @param type - one of {@link FRAME}.
 * @param id - 16-byte stream identifier.
 * @param value - the JSON body.
 * @returns the framed bytes.
 */
export function encodeJsonFrame(type, id, value) {
  return encodeFrame(type, id, Buffer.from(JSON.stringify(value), 'utf8'))
}

/**
 * Reassemble frames from a byte stream.
 *
 * The receiver gets whatever the socket hands it — one frame, part of a frame, or
 * several frames at once — so frames are taken out of a growing buffer whenever their
 * length prefix says they are complete.
 *
 * Completed frames are copied out on extraction. `subarray` alone would alias the
 * receive buffer, and the next chunk concatenated onto it would silently rewrite the
 * payloads of frames the caller still holds.
 */
export class FrameReader {
  /**
   * Unparsed bytes, as a list of pieces.
   *
   * One source of truth. An earlier draft kept a separate "leftover buffer" and a "new
   * pieces" list; the length prefix was then read from one while the frame started in the
   * other, and a frame spanning two calls never parsed. Two places for the same bytes is
   * the bug; pieces are joined only when a whole frame is known to be present.
   */
  #pieces = []

  /** Total bytes across `#pieces`, counted rather than re-summed per call. */
  #held = 0

  /** Bytes currently held, awaiting a complete frame; for tests and diagnostics. */
  get buffered() {
    return this.#held
  }

  /** The held bytes, joined. Only called once enough bytes are present to be worth it. */
  #joined() {
    if (this.#pieces.length === 1) return this.#pieces[0]
    const joined = Buffer.concat(this.#pieces)
    this.#pieces = [joined]
    return joined
  }

  /**
   * Feed received bytes and take out every complete frame.
   *
   * @param chunk - bytes from the socket.
   * @returns complete frames, in arrival order.
   */
  push(chunk) {
    if (chunk.length > 0) {
      this.#pieces.push(chunk)
      this.#held += chunk.length
    }
    const frames = []
    for (;;) {
      if (this.#held < PREFIX_BYTES) break
      // Peek the length off the head piece instead of joining on every arrival — the
      // prefix is the first four bytes of the stream, present as soon as that piece is.
      // Joining first is what made this quadratic.
      const first = this.#pieces[0]
      const head = first.length >= PREFIX_BYTES ? first : this.#joined()
      const length = head.readUInt32BE(0)
      if (length > MAX_FRAME_BYTES) {
        throw new Error(`federation: frame length ${length} exceeds the ${MAX_FRAME_BYTES} byte limit`)
      }
      // Join only when the whole frame is present.
      if (this.#held < PREFIX_BYTES + length) break
      const whole = this.#joined()

      const type = whole.readUInt8(HEADER_BYTES)
      const start = HEADER_BYTES + TYPE_BYTES
      const id = Buffer.from(whole.subarray(start, start + ID_BYTES))
      const payload = Buffer.from(whole.subarray(PREFIX_BYTES, PREFIX_BYTES + length))
      frames.push({ type, id, payload })

      const consumed = PREFIX_BYTES + length
      this.#held = whole.length - consumed
      this.#pieces = this.#held > 0 ? [Buffer.from(whole.subarray(consumed))] : []
    }
    return frames
  }
}

/**
 * Mint one stream identifier.
 *
 * 16 random bytes: two nodes picking the same value is not reachable in practice, which
 * is what lets the tunnel leave `streamId` alone as a stream crosses hops.
 *
 * @returns the identifier bytes.
 */
export function newRequestId() {
  return randomBytes(16)
}
