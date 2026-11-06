/**
 * The byte surface: one HTTP route that streams a file out of this node.
 *
 * This replaces the chunk protocol for pulling. That protocol existed because a *frame*
 * is capped at 8 MiB, so a file could not cross in one message — but the tunnel already
 * streams: `proxy()` writes each arriving body piece straight to the browser socket.
 * Slicing a file into 512 KiB chunks and paying a full request/response round trip for
 * each one was therefore self-inflicted, and it cost roughly 10 ms per chunk.
 *
 * So a file is now an ordinary HTTP response with ordinary HTTP semantics:
 *
 * - `GET /file?path=...` streams the whole file.
 * - `Range: bytes=a-b` streams that range, which is what `curl -r`, resumable downloads
 *   and every HTTP client already understand.
 * - `HEAD` returns the size without a body, which is what `describe` used to do.
 *
 * The route is daemon-owned, so it is reachable only over a tunnel that presented this
 * node's federation token — a browser cannot talk to it. It is read-only by
 * construction: there is no method that writes.
 *
 * @module @yiln-dsh/dsh-gateway/file-route
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'

import { validateDestination } from './file-transfer.js'

/** Parse an HTTP `Range` header into a window, or nothing when it is not a range. */
function parseRange(header, size) {
  if (typeof header !== 'string' || header.trim() === '') return undefined
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim())
  if (match === null) return undefined
  const [, fromRaw, toRaw] = match
  // `bytes=-N` means the last N bytes; `bytes=N-` means from N to the end.
  if (fromRaw === '' && toRaw === '') return undefined
  if (fromRaw === '') {
    const tail = Number(toRaw)
    if (!Number.isSafeInteger(tail) || tail <= 0) return undefined
    return { start: Math.max(0, size - tail), end: size - 1 }
  }
  const start = Number(fromRaw)
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return undefined
  const end = toRaw === '' ? size - 1 : Math.min(Number(toRaw), size - 1)
  if (!Number.isSafeInteger(end) || end < start) return undefined
  return { start, end }
}

/**
 * Answer one file request.
 *
 * @param req - the request.
 * @param res - the response.
 * @param url - path plus query, for `?path=`.
 * @returns whether the request was answered here.
 */
export async function serveFileRoute(req, res, url) {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'GET, HEAD' })
    res.end(JSON.stringify({ ok: false, error: `${method} is not supported; this route only reads` }))
    return true
  }

  const wanted = new URL(`http://x${url}`).searchParams.get('path') ?? ''
  const checked = validateDestination(wanted)
  if (checked.ok !== true) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: checked.error }))
    return true
  }

  let info
  try {
    info = await stat(checked.path)
  } catch (error) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: `could not read "${checked.path}": ${error?.message ?? error}` }))
    return true
  }
  if (!info.isFile()) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: `not a regular file: "${checked.path}"` }))
    return true
  }

  const headers = {
    'content-type': 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'content-disposition': `attachment; filename="${basename(checked.path)}"`,
    'x-dsh-file-size': String(info.size),
  }

  const window = parseRange(req.headers.range, info.size)
  if (window === undefined) {
    if (req.headers.range !== undefined) {
      // An unsatisfiable range must say so rather than silently sending everything.
      res.writeHead(416, { ...headers, 'content-range': `bytes */${info.size}` })
      res.end()
      return true
    }
    res.writeHead(200, { ...headers, 'content-length': String(info.size) })
    if (method === 'HEAD') { res.end(); return true }
    createReadStream(checked.path).on('error', () => res.destroy()).pipe(res)
    return true
  }

  const length = window.end - window.start + 1
  res.writeHead(206, {
    ...headers,
    'content-length': String(length),
    'content-range': `bytes ${window.start}-${window.end}/${info.size}`,
  })
  if (method === 'HEAD') { res.end(); return true }
  createReadStream(checked.path, { start: window.start, end: window.end })
    .on('error', () => res.destroy())
    .pipe(res)
  return true
}
