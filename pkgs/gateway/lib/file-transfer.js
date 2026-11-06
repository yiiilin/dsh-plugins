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
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

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
 * Read one file and describe it as chunks the sender can put on the wire.
 *
 * @param path - absolute path to read.
 * @returns `{ ok: true, name, size, chunks }` or `{ ok: false, error }`.
 */
export async function readForTransfer(path) {
  const checked = validateDestination(path)
  if (checked.ok !== true) return checked
  try {
    const info = await stat(checked.path)
    if (!info.isFile()) return { ok: false, error: `not a regular file: "${checked.path}"` }
    if (info.size > MAX_FILE_BYTES) {
      return { ok: false, error: `file is ${info.size} bytes; the limit is ${MAX_FILE_BYTES}` }
    }
    const bytes = await readFile(checked.path)
    const chunks = []
    for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
      chunks.push(bytes.subarray(at, at + CHUNK_BYTES).toString('base64'))
    }
    return { ok: true, name: basename(checked.path), size: bytes.length, chunks }
  } catch (error) {
    return { ok: false, error: `could not read "${checked.path}": ${error?.message ?? error}` }
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
 * Append one base64 piece.
 *
 * @param transferId - id from {@link beginTransfer}.
 * @param data - the piece, base64.
 * @returns `{ ok: true, received }` or `{ ok: false, error }`.
 */
export async function appendTransfer(transferId, data) {
  const stage = transfers.get(String(transferId ?? ''))
  if (stage === undefined) return { ok: false, error: 'no such transfer; it was aborted or never began' }
  const piece = Buffer.from(String(data ?? ''), 'base64')
  if (piece.length === 0) return { ok: false, error: 'chunk is empty' }
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
  return { ok: true, received: stage.received }
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
