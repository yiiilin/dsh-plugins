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

/** Largest file one call may move. Chunked, so this is a policy cap, not a frame cap. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024

/** Bytes per chunk. Well under the 8 MiB frame cap, leaving room for the frame header. */
export const CHUNK_BYTES = 512 * 1024

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
export async function describeTransfer(path) {
  const checked = validateDestination(path)
  if (checked.ok !== true) return checked
  let handle
  try {
    const info = await stat(checked.path)
    if (!info.isFile()) return { ok: false, error: `not a regular file: "${checked.path}"` }
    if (info.size > MAX_FILE_BYTES) {
      return { ok: false, error: `file is ${info.size} bytes; the limit is ${MAX_FILE_BYTES}` }
    }
    handle = await open(checked.path, 'r')
    const probe = Buffer.alloc(Math.min(CHUNK_BYTES, Math.max(1, info.size)))
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0)
    const chosen = chooseEncoding(probe.subarray(0, bytesRead))
    return {
      ok: true,
      name: basename(checked.path),
      size: info.size,
      chunkBytes: CHUNK_BYTES,
      chunks: Math.max(1, Math.ceil(info.size / CHUNK_BYTES)),
      encoding: chosen.encoding,
    }
  } catch (error) {
    return { ok: false, error: `could not read "${checked.path}": ${error?.message ?? error}` }
  } finally {
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
export async function readTransferChunk({ path, index, chunkBytes = CHUNK_BYTES, encoding = ENCODING.raw }) {
  const checked = validateDestination(path)
  if (checked.ok !== true) return checked
  const at = Number(index)
  if (!Number.isInteger(at) || at < 0) return { ok: false, error: 'index must be a non-negative integer' }
  const span = Math.min(Math.max(1, Number(chunkBytes) || CHUNK_BYTES), CHUNK_BYTES)
  let handle
  try {
    handle = await open(checked.path, 'r')
    const buffer = Buffer.alloc(span)
    const { bytesRead } = await handle.read(buffer, 0, span, at * span)
    if (bytesRead === 0 && at > 0) {
      // Past the end: the file shrank between the description and this read.
      return { ok: false, error: `"${checked.path}" is shorter than expected` }
    }
    const raw = buffer.subarray(0, bytesRead)
    const data = encodeChunk(raw, encoding)
    if (data.length > MAX_FRAME_BYTES) {
      return { ok: false, error: `chunk ${at} is ${data.length} bytes, over the frame limit` }
    }
    const more = await handle.read(Buffer.alloc(1), 0, 1, (at + 1) * span)
    return { ok: true, index: at, data, encoding, eof: more.bytesRead === 0 }
  } catch (error) {
    return { ok: false, error: `could not read "${checked.path}": ${error?.message ?? error}` }
  } finally {
    await handle?.close().catch(() => {})
  }
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
export async function beginTransfer({ path, overwrite = false, totalChunks }) {
  const checked = validateDestination(path)
  if (checked.ok !== true) return checked
  if (transfers.size >= MAX_OPEN_TRANSFERS) {
    return { ok: false, error: `too many uploads in flight (${MAX_OPEN_TRANSFERS}); finish one first` }
  }
  const target = checked.path
  if (overwrite !== true) {
    try {
      await stat(target)
      return { ok: false, error: `"${target}" already exists; pass overwrite to replace it` }
    } catch {
      // Absent is the expected case.
    }
  }
  const staged = `${target}.dsh-transfer-${randomUUID().slice(0, 8)}`
  try {
    await mkdir(dirname(target), { recursive: true })
  } catch (error) {
    return { ok: false, error: `could not create the directory for "${target}": ${error?.message ?? error}` }
  }
  const handle = createWriteStream(staged, { flags: 'w' })
  const opened = await new Promise((done) => {
    handle.once('open', () => done(undefined))
    handle.once('error', (error) => done(error))
  })
  if (opened !== undefined) return { ok: false, error: `could not stage "${target}": ${opened.message}` }

  const transferId = randomUUID()
  transfers.set(transferId, {
    target,
    staged,
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
