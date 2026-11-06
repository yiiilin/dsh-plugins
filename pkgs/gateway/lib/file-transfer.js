/**
 * Moving one file from this machine to another over the tunnel.
 *
 * The tunnel caps one frame at 8 MiB, so a file is sent as chunks rather than one blob:
 * the sender reads the file, splits it, and the receiver appends each chunk. Nothing is
 * written until the whole file arrived — a half-transferred file that looked complete
 * would be worse than a refusal.
 *
 * **Why this uses `node:fs` and not the `fs` service.** That service's write entry takes
 * text; a file being copied between machines may be binary, and silently mangling it
 * would be the kind of failure nobody notices until much later. Writes still go through
 * an explicit, narrow rule: the destination must be an absolute path, and the caller
 * must say whether it may be replaced.
 *
 * @module @yiln-dsh/dsh-gateway/file-transfer
 */

import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { chooseEncoding, decodeChunk, ENCODING, encodeChunk } from './transfer-codec.js'
import { MAX_FRAME_BYTES } from './federation/frames.js'

/** Largest window one call may move. Chunked, so this is a policy cap, not a frame cap. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024

/** Bytes per chunk. Well under the 8 MiB frame cap, leaving room for the frame header. */
export const CHUNK_BYTES = 512 * 1024

/**
 * Resolve an optional window against a file's size.
 *
 * Both bounds are optional and mean what they usually mean: no offset is the start, no
 * length is "to the end". The pair is validated here rather than at the call site so a
 * negative offset or an out-of-range window fails the same way everywhere.
 *
 * @param size - the file's size in bytes.
 * @param offset - first byte to read; defaults to 0.
 * @param length - bytes to read; defaults to the rest of the file.
 * @returns `{ ok: true, offset, length }` or `{ ok: false, error }`.
 */
export function resolveWindow(size, offset, length) {
  const start = offset === undefined || offset === null || offset === '' ? 0 : Number(offset)
  if (!Number.isSafeInteger(start) || start < 0) return { ok: false, error: 'offset must be a non-negative integer' }
  if (start > size) return { ok: false, error: `offset ${start} is past the end of the file (${size} bytes)` }
  const available = size - start
  const omitted = length === undefined || length === null || length === ''
  // An omitted length means "to the end", but one call can only move a window. For a
  // file larger than the cap that is not an error — it is the caller asking for as much
  // as can be had, and the answer is one full window. Refusing here made every file over
  // the cap unreadable even by `describe`, which reports the size and nothing else.
  if (omitted) {
    return { ok: true, offset: start, length: Math.min(available, MAX_FILE_BYTES) }
  }
  const wanted = Number(length)
  if (!Number.isSafeInteger(wanted) || wanted < 0) return { ok: false, error: 'length must be a non-negative integer' }
  if (wanted > MAX_FILE_BYTES) {
    return { ok: false, error: `length ${wanted} exceeds the ${MAX_FILE_BYTES} byte window limit` }
  }
  const span = Math.min(wanted, available)
  return { ok: true, offset: start, length: span }
}

/**
 * Validate a destination path before anything is written.
 *
 * @param path - the requested destination.
 * @returns `{ ok: true, path }` or `{ ok: false, error }`.
 */
export function validateDestination(path) {
  const wanted = String(path ?? '').trim()
  if (wanted === '') return { ok: false, error: 'path is required' }
  if (!isAbsolute(wanted)) {
    // A relative path would resolve against whatever cwd the daemon happens to have,
    // which is not something the sender can predict.
    return { ok: false, error: `path must be absolute, got "${wanted.slice(0, 80)}"` }
  }
  if (!wanted.endsWith('/') && basename(wanted) === '') {
    return { ok: false, error: `path must name a file, got "${wanted.slice(0, 80)}"` }
  }
  return { ok: true, path: resolve(wanted) }
}

/**
 * Describe one file without sending its contents, and decide how it will be encoded.
 *
 * The encoding is chosen here, once, from the first chunk: the receiver must be told,
 * because a `raw` chunk and a `zstd` chunk are different byte streams.
 *
 * @param path - absolute path to inspect.
 * @returns `{ ok: true, name, size, chunkBytes, chunks, encoding }` or `{ ok: false, error }`.
 */
export async function describeTransfer(path, { offset, length } = {}) {
  const checked = validateDestination(path)
  if (checked.ok !== true) return checked
  let handle
  try {
    const info = await stat(checked.path)
    if (!info.isFile()) return { ok: false, error: `not a regular file: "${checked.path}"` }
    // The cap is on the *window* this call moves, not on the file. A 2 GiB log has to be
    // readable a slice at a time, which is the whole point of an offset.
    const window = resolveWindow(info.size, offset, length)
    if (window.ok !== true) return window
    handle = await open(checked.path, 'r')
    const probe = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(1, window.length)))
    const { bytesRead } = await handle.read(probe, 0, probe.length, window.offset)
    const chosen = chooseEncoding(probe.subarray(0, bytesRead))
    return {
      ok: true,
      name: basename(checked.path),
      size: info.size,
      offset: window.offset,
      length: window.length,
      chunkBytes: CHUNK_BYTES,
      chunks: Math.max(1, Math.ceil(window.length / CHUNK_BYTES)),
      encoding: chosen.encoding,
    }
  } catch (error) {
    return { ok: false, error: `could not read "${checked.path}": ${error?.message ?? error}` }
  } finally {
    // `describe` is called once per pull and must not hold a descriptor: the chunk reader
    // keeps its own cached handle.
    await handle?.close().catch(() => {})
  }
}

/**
 * Read and encode one piece of a file.
 *
 * The piece is {@link CHUNK_BYTES} of the file, encoded per the transfer's choice. Even
 * when it compresses badly, the raw form is a quarter of the 8 MiB frame cap.
 *
 * @param request - `{ path, index, chunkBytes, encoding }`.
 * @returns `{ ok: true, index, data, eof }` or `{ ok: false, error }`; `data` is a Buffer.
 */
/**
 * Open file handles, keyed by path.
 *
 * A pull requests chunk after chunk from the same file; opening and closing it every time
 * is pure syscall overhead on the hot path. The handle is dropped on commit/abort and
 * bounded, so a long-lived process cannot accumulate descriptors.
 */
const readHandles = new Map()

/** Close every cached read handle. */
export async function closeReadHandles() {
  const entries = [...readHandles.values()]
  readHandles.clear()
  await Promise.all(entries.map((entry) => entry.handle.close().catch(() => {})))
}

/**
 * A cached handle for `path`, opening one when absent or when the file was replaced.
 *
 * The identity check matters: a cached descriptor keeps reading the *old* inode after the
 * path is rewritten or deleted, so a reused path would serve stale bytes — a test caught
 * exactly that, having written a new file over the previous one's name. `dev` and `ino`
 * change on replacement and `mtimeMs` on an in-place edit, so any of them differing
 * invalidates the entry.
 *
 * @returns a handle and the file's identity at the time it was checked.
 */
async function handleFor(path) {
  const info = await stat(path)
  const identity = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.size}`
  const cached = readHandles.get(path)
  if (cached !== undefined && cached.identity === identity) return cached.handle
  if (cached !== undefined) {
    readHandles.delete(path)
    await cached.handle.close().catch(() => {})
  }
  if (readHandles.size >= MAX_OPEN_TRANSFERS * 2) {
    const [oldest, entry] = readHandles.entries().next().value
    readHandles.delete(oldest)
    await entry.handle.close().catch(() => {})
  }
  const handle = await open(path, 'r')
  readHandles.set(path, { handle, identity })
  return handle
}

export async function readTransferChunk({ path, index, chunkBytes = CHUNK_BYTES, encoding = ENCODING.raw, offset = 0, length }) {
  const checked = validateDestination(path)
  if (checked.ok !== true) return checked
  const at = Number(index)
  if (!Number.isInteger(at) || at < 0) return { ok: false, error: 'index must be a non-negative integer' }
  const span = Math.min(Math.max(1, Number(chunkBytes) || CHUNK_BYTES), CHUNK_BYTES)
  const start = Number(offset) || 0
  if (!Number.isSafeInteger(start) || start < 0) return { ok: false, error: 'offset must be a non-negative integer' }
  let handle
  try {
    // Positioned read: the window's offset is absolute in the file, and the chunk index
    // walks forward inside it, so a caller can resume at any chunk without replaying.
    const position = start + at * span
    let want = span
    if (length !== undefined && length !== null && length !== '') {
      const remaining = Number(length) - at * span
      if (remaining <= 0) return { ok: true, index: at, data: Buffer.alloc(0), encoding, eof: true }
      want = Math.min(span, remaining)
    }
    handle = await handleFor(checked.path)
    const buffer = Buffer.alloc(want)
    const { bytesRead } = await handle.read(buffer, 0, want, position)
    if (bytesRead === 0 && at > 0) {
      // Past the end: the file shrank between the description and this read.
      return { ok: false, error: `"${checked.path}" is shorter than expected` }
    }
    const raw = buffer.subarray(0, bytesRead)
    const data = encodeChunk(raw, encoding)
    if (data.length > MAX_FRAME_BYTES) {
      return { ok: false, error: `chunk ${at} is ${data.length} bytes, over the frame limit` }
    }
    const more = await handle.read(Buffer.alloc(1), 0, 1, position + bytesRead)
    return { ok: true, index: at, data, encoding, eof: more.bytesRead === 0 }
  } catch (error) {
    return { ok: false, error: `could not read "${checked.path}": ${error?.message ?? error}` }
  }
  // The handle belongs to the cache, not to this call: closing it here made the next
  // chunk of the same pull fail with "file closed".
}

// --- staged uploads -----------------------------------------------------------

/**
 * One file being received, in pieces.
 *
 * A file can be larger than one frame, so it cannot arrive as a single request. Each
 * upload stages a file next to its destination and appends to it; `commit` renames the
 * staged file over the target. That order is what makes the destination atomic: a
 * reader sees either the old file or the complete new one, never a prefix.
 *
 * Staging lives in this process's memory only. A restart loses the table and leaves the
 * staged files behind, which `abort`/`sweepTransfers` remove; nothing is ever renamed
 * into place by a transfer this process no longer knows about.
 */
export const MAX_OPEN_TRANSFERS = 8

/** transferId -> `{ target, staged, overwrite, expected, received, handle }`. */
const transfers = new Map()

/**
 * Open one staged upload.
 *
 * @param request - `{ path, overwrite, totalChunks }`; the chunk count is recorded so a
 *   truncated upload is refused rather than committed short.
 * @returns `{ ok: true, transferId }` or `{ ok: false, error }`.
 */
export async function beginTransfer({ path, overwrite = false, totalChunks, toOffset = 0 }) {
  const checked = validateDestination(path)
  if (checked.ok !== true) return checked
  if (transfers.size >= MAX_OPEN_TRANSFERS) {
    return { ok: false, error: `too many uploads in flight (${MAX_OPEN_TRANSFERS}); finish one first` }
  }
  const start = Number(toOffset) || 0
  if (!Number.isSafeInteger(start) || start < 0) {
    return { ok: false, error: 'toOffset must be a non-negative integer' }
  }
  const target = checked.path

  // A positioned window is a *resume or a patch*: it writes into the existing file at an
  // offset and must not replace what is already there. That inverts the overwrite rule —
  // continuation requires the file, so it is refused when the file is missing instead of
  // when it exists.
  const positioned = start > 0
  if (positioned) {
    try {
      await stat(target)
    } catch {
      return { ok: false, error: `"${target}" does not exist; a toOffset write continues an existing file` }
    }
  } else if (overwrite !== true) {
    try {
      await stat(target)
      return { ok: false, error: `"${target}" already exists; pass overwrite to replace it` }
    } catch {
      // Absent is the expected case.
    }
  }

  // A positioned write goes to the destination itself: staging it elsewhere and renaming
  // would publish only the window and discard the rest of the file.
  const staged = positioned ? target : `${target}.dsh-transfer-${randomUUID().slice(0, 8)}`
  try {
    await mkdir(dirname(target), { recursive: true })
  } catch (error) {
    return { ok: false, error: `could not create the directory for "${target}": ${error?.message ?? error}` }
  }
  const handle = createWriteStream(staged, { flags: positioned ? 'r+' : 'w', start: positioned ? start : undefined })
  const opened = await new Promise((done) => {
    handle.once('open', () => done(undefined))
    handle.once('error', (error) => done(error))
  })
  if (opened !== undefined) return { ok: false, error: `could not stage "${target}": ${opened.message}` }

  const transferId = randomUUID()
  transfers.set(transferId, {
    target,
    staged,
    positioned,
    overwrite: overwrite === true,
    expected: Number.isInteger(totalChunks) ? totalChunks : undefined,
    received: 0,
    bytes: 0,
    handle,
  })
  return { ok: true, transferId }
}

/**
 * Append one piece to a staged upload.
 *
 * @param transferId - id from {@link beginTransfer}.
 * @param data - the piece's bytes, as they came off the wire.
 * @param encoding - how those bytes are encoded; `raw` means they are the content.
 * @returns `{ ok: true, received, bytes }` or `{ ok: false, error }`.
 */
export async function appendTransfer(transferId, data, encoding = ENCODING.raw) {
  const stage = transfers.get(String(transferId ?? ''))
  if (stage === undefined) return { ok: false, error: 'no such transfer; it was aborted or never began' }
  // `data` arrives as the bytes themselves — no base64 layer. The encoding says whether
  // those bytes are a zstd frame or the file's own content.
  const wire = Buffer.isBuffer(data) ? data : Buffer.from(data ?? '')
  if (wire.length === 0) return { ok: false, error: 'chunk is empty' }
  let piece
  try {
    piece = decodeChunk(wire, encoding)
  } catch (error) {
    await abortTransfer(transferId)
    return { ok: false, error: `chunk is not valid ${encoding}: ${error?.message ?? error}` }
  }
  if (stage.bytes + piece.length > MAX_FILE_BYTES) {
    await abortTransfer(transferId)
    return { ok: false, error: `file exceeds the ${MAX_FILE_BYTES} byte limit` }
  }
  const written = await new Promise((done) => {
    stage.handle.write(piece, (error) => done(error))
  })
  if (written !== undefined && written !== null) {
    await abortTransfer(transferId)
    return { ok: false, error: `could not write a chunk: ${written.message}` }
  }
  stage.received += 1
  stage.bytes += piece.length
  return { ok: true, received: stage.received, bytes: stage.bytes }
}

/**
 * Finish an upload by renaming the staged file into place.
 *
 * @param transferId - id from {@link beginTransfer}.
 * @returns `{ ok: true, path, bytes }` or `{ ok: false, error }`.
 */
export async function commitTransfer(transferId) {
  const key = String(transferId ?? '')
  const stage = transfers.get(key)
  if (stage === undefined) return { ok: false, error: 'no such transfer; it was aborted or never began' }
  if (stage.expected !== undefined && stage.received !== stage.expected) {
    await abortTransfer(key)
    return { ok: false, error: `upload ended after ${stage.received} of ${stage.expected} chunks` }
  }
  try {
    await new Promise((done, fail) => {
      stage.handle.end((error) => (error === undefined || error === null ? done() : fail(error)))
    })
    if (stage.positioned === true) {
      // Already written into the destination at its offset; there is nothing to rename.
      transfers.delete(key)
      return { ok: true, path: stage.target, bytes: stage.bytes }
    }
    if (stage.overwrite !== true) {
      try {
        await stat(stage.target)
        await rm(stage.staged, { force: true })
        transfers.delete(key)
        return { ok: false, error: `"${stage.target}" appeared during the upload; not replaced` }
      } catch {
        // Still absent, which is what was checked at begin.
      }
    }
    await rename(stage.staged, stage.target)
    transfers.delete(key)
    return { ok: true, path: stage.target, bytes: stage.bytes }
  } catch (error) {
    await abortTransfer(key)
    return { ok: false, error: `could not finish "${stage.target}": ${error?.message ?? error}` }
  }
}

/**
 * Drop one upload and delete whatever was staged.
 *
 * @param transferId - id from {@link beginTransfer}.
 * @returns `{ ok: true }`.
 */
export async function abortTransfer(transferId) {
  const key = String(transferId ?? '')
  const stage = transfers.get(key)
  if (stage === undefined) return { ok: true }
  transfers.delete(key)
  try { stage.handle.destroy() } catch { /* already closed */ }
  await rm(stage.staged, { force: true }).catch(() => {})
  return { ok: true }
}

/** How many uploads are open; used by tests and by shutdown. */
export function openTransfers() {
  return transfers.size
}

// --- streaming sink -----------------------------------------------------------

/**
 * Open a destination for a streamed write.
 *
 * The chunk protocol is gone for pulling — a file is one HTTP response now — so what the
 * receiver needs is a sink, not a chunk appender. The same two rules survive: an existing
 * file is refused unless `overwrite`, and a `toOffset` continues an existing file at that
 * byte instead of replacing it.
 *
 * @param request - `{ path, overwrite, toOffset }`.
 * @returns `{ ok: true, sink, finish }` or `{ ok: false, error }`; `finish` resolves after
 *   the stream closed cleanly and the file is in place.
 */
export async function openStreamSink({ path, overwrite = false, toOffset = 0 }) {
  const checked = validateDestination(path)
  if (checked.ok !== true) return checked
  const start = Number(toOffset) || 0
  if (!Number.isSafeInteger(start) || start < 0) {
    return { ok: false, error: 'toOffset must be a non-negative integer' }
  }
  const target = checked.path
  const positioned = start > 0

  if (positioned) {
    try {
      await stat(target)
    } catch {
      return { ok: false, error: `"${target}" does not exist; a toOffset write continues an existing file` }
    }
  } else if (overwrite !== true) {
    try {
      await stat(target)
      return { ok: false, error: `"${target}" already exists; pass overwrite to replace it` }
    } catch {
      // Absent is the expected case.
    }
  }

  const staged = positioned ? target : `${target}.dsh-stream-${randomUUID().slice(0, 8)}`
  try {
    await mkdir(dirname(target), { recursive: true })
  } catch (error) {
    return { ok: false, error: `could not create the directory for "${target}": ${error?.message ?? error}` }
  }

  const handle = createWriteStream(staged, { flags: positioned ? 'r+' : 'w', start: positioned ? start : undefined })
  const failed = new Promise((_, reject) => handle.once('error', reject))
  let bytes = 0

  return {
    ok: true,
    /** Accept one piece of the file; counts what went in. */
    write(piece) {
      bytes += piece.length
      handle.write(piece)
    },
    /** Resolves once the stream closed cleanly and the file is in place. */
    finish: async () => {
      try {
        await Promise.race([
          new Promise((done, fail) => handle.end((error) => (error ? fail(error) : done()))),
          failed,
        ])
        if (!positioned) {
          if (overwrite !== true) {
            try {
              await stat(target)
              await rm(staged, { force: true })
              return { ok: false, error: `"${target}" appeared during the transfer; not replaced` }
            } catch {
              // Still absent.
            }
          }
          await rename(staged, target)
        }
        return { ok: true, path: target, bytes }
      } catch (error) {
        await rm(staged, { force: true }).catch(() => {})
        return { ok: false, error: `could not finish "${target}": ${error?.message ?? error}` }
      }
    },
  }
}
