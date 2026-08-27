import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * dsh-plugin-file-message — Host half.
 *
 * The tool result is a live reference to a regular file in the current
 * session's workspace. The bytes are never copied into DSH attachment storage.
 * A small sidecar next to the session log keeps the same metadata available to
 * the file-message Host routes without scanning every session.
 */

export const name = 'file-message'
export const inject = [
  'webServer',
  'tools',
  'fs',
  'sessions',
  'sessionPersistence',
  'sandboxPolicy',
  'systemPrompt',
]

const META_FILE = 'send-attachments-metas.json'
const API_PATH = '/_dsh/file-message/content'
const MAX_TRANSFER_BYTES = 64 * 1024 * 1024
const MAX_PREVIEW_BYTES = 16 * 1024 * 1024
const META_VERSION = 1

const IMAGE_MIME_BY_EXTENSION = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
})

const MIME_BY_EXTENSION = Object.freeze({
  ...IMAGE_MIME_BY_EXTENSION,
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.tsx': 'text/typescript; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.tgz': 'application/gzip',
})

function fileNameOf(path) {
  const parts = String(path).split(/[\\/]/u).filter(Boolean)
  return parts.at(-1) || String(path)
}

function mediaTypeFor(path) {
  return MIME_BY_EXTENSION[extname(String(path)).toLowerCase()] || 'application/octet-stream'
}

function imageMediaTypeFor(path) {
  return IMAGE_MIME_BY_EXTENSION[extname(String(path)).toLowerCase()]
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sessionFor(exec) {
  const session = exec?.agent?.session
  if (session === undefined || session === null) throw new Error('file-message requires a live agent session')
  return session
}

function sessionCwd(ctx, session) {
  return session.header.cwd || ctx.sandboxPolicy.workspaceRoot
}

function asPositiveSize(info) {
  return typeof info?.size === 'number' && Number.isFinite(info.size) && info.size >= 0
    ? info.size
    : 0
}

async function resolveMessageTarget(ctx, exec, requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.trim() === '') {
    throw new Error('file_path must be a non-empty string')
  }

  const session = sessionFor(exec)
  const cwd = sessionCwd(ctx, session)
  const target = await ctx.fs.resolve(requestedPath, { cwd, signal: exec.signal })
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) throw new Error(`cannot send "${target.displayPath}": file not found`)
  if (info.type !== 'file') throw new Error(`cannot send "${target.displayPath}": target is not a regular file`)

  const root = await ctx.fs.resolve(cwd, { signal: exec.signal })
  if (!ctx.fs.contains(root, target)) {
    throw new Error(`cannot send "${target.displayPath}": file is outside the session workspace`)
  }

  const size = asPositiveSize(info)
  if (size > MAX_TRANSFER_BYTES) {
    throw new Error(`cannot send "${target.displayPath}": file exceeds the ${MAX_TRANSFER_BYTES} byte limit`)
  }

  return {
    session,
    cwd,
    target,
    info,
    size,
    path: target.displayPath,
    name: fileNameOf(target.displayPath),
    mediaType: mediaTypeFor(target.displayPath),
    version: String(info.version),
  }
}

function metaPathFor(ctx, session) {
  const location = ctx.sessionPersistence.locate(session.header)
  if (location === undefined || typeof location.path !== 'string') {
    throw new Error('file-message requires a per-session persistence artifact')
  }
  return join(dirname(location.path), META_FILE)
}

async function readMetaFile(path, sessionId) {
  try {
    const raw = await readFile(path, 'utf8')
    const value = JSON.parse(raw)
    if (!isPlainRecord(value) || value.version !== META_VERSION || !isPlainRecord(value.items)) {
      throw new Error(`invalid ${META_FILE}`)
    }
    if (value.sessionId !== undefined && String(value.sessionId) !== sessionId) {
      throw new Error(`session metadata belongs to ${String(value.sessionId)}`)
    }
    return value
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { version: META_VERSION, sessionId, items: {} }
    }
    throw error
  }
}

function createMetaWriter(ctx) {
  const tails = new Map()

  return async (record) => {
    const sessionId = String(record.sessionId)
    const previous = tails.get(sessionId) || Promise.resolve()
    const operation = previous.then(async () => {
      const path = metaPathFor(ctx, record.session)
      const current = await readMetaFile(path, sessionId)
      current.items[record.callId] = {
        callId: record.callId,
        toolName: record.toolName,
        kind: record.kind,
        path: record.path,
        cwd: record.cwd,
        displayName: record.displayName,
        mediaType: record.mediaType,
        size: record.size,
        version: record.version,
        caption: record.caption,
        createdAt: record.createdAt,
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, path)
    })
    tails.set(sessionId, operation.then(() => {}, () => {}))
    return operation
  }
}

function outputText(value) {
  const kind = value.kind === 'image' ? 'image' : 'file'
  const action = kind === 'image' ? 'The user can preview and download it in the conversation.' : 'The user can download it in the conversation.'
  return `Sent ${kind} "${value.path}" (${value.size} bytes). ${action}`
}

function outputDefinition() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        callId: { type: 'string', required: true },
        kind: { type: 'string', required: true },
        path: { type: 'string', required: true },
        cwd: { type: 'string', required: true },
        displayName: { type: 'string', required: true },
        mediaType: { type: 'string', required: true },
        size: { type: 'integer', required: true },
        version: { type: 'string', required: true },
        caption: { type: 'string' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: outputText(value) }],
    presentationMeta: (_args, value) => ({
      kind: value.kind,
      callId: value.callId,
      path: value.path,
      cwd: value.cwd,
      displayName: value.displayName,
      mediaType: value.mediaType,
      size: value.size,
      version: value.version,
      ...value.caption === undefined ? {} : { caption: value.caption },
      plugin: 'dsh-plugin-file-message',
    }),
  }
}

function createTool(ctx, writeMeta, kind) {
  const imageOnly = kind === 'image'
  const name = imageOnly ? 'send_image' : 'send_file'
  const description = imageOnly
    ? 'Send an existing PNG, JPEG, WebP, or GIF file from the current workspace to the user. The file is referenced by its workspace path, not copied; it can become unavailable if the source file is deleted or moved.'
    : 'Send an existing regular file from the current workspace to the user. The file is referenced by its workspace path, not copied; it can become unavailable if the source file is deleted or moved.'

  return defineTool({
    name,
    description,
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'Path to the file, resolved against the current session workspace.',
      },
      caption: {
        type: 'string',
        description: 'Optional short caption shown above the file card.',
      },
    },
    output: outputDefinition(),
    presentCall(args) {
      return {
        card: 'generic',
        title: `${imageOnly ? 'Send image' : 'Send file'} ${args.file_path}`,
      }
    },
    presentResult(_args, result) {
      if (result.isError || !isPlainRecord(result.meta)) return undefined
      return {
        card: 'generic',
        title: `${imageOnly ? 'Image' : 'File'} ${result.meta.displayName || result.meta.path || ''}`.trim(),
      }
    },
    async execute(args, exec) {
      const resolved = await resolveMessageTarget(ctx, exec, args.file_path)
      if (imageOnly && imageMediaTypeFor(resolved.path) === undefined) {
        throw new Error(`cannot send "${resolved.path}": send_image only accepts PNG, JPEG, WebP, or GIF files`)
      }

      ctx.emit('fs/observed', resolved.target, {
        kind: 'present',
        version: resolved.info.version,
      }, exec)

      const value = {
        callId: String(exec.callId),
        kind,
        path: resolved.path,
        cwd: resolved.cwd,
        displayName: resolved.name,
        mediaType: imageOnly ? imageMediaTypeFor(resolved.path) : resolved.mediaType,
        size: resolved.size,
        version: resolved.version,
        ...typeof args.caption === 'string' && args.caption.trim() !== '' ? { caption: args.caption.trim() } : {},
      }

      await writeMeta({
        ...value,
        toolName: name,
        sessionId: resolved.session.id,
        session: resolved.session,
        createdAt: new Date().toISOString(),
      })
      return value
    },
  })
}

async function findSessionHeader(ctx, sessionId) {
  const live = ctx.sessions.get(sessionId)
  if (live !== undefined) return live.header
  const headers = await ctx.sessionPersistence.list()
  return headers.find((header) => String(header.id) === sessionId)
}

async function readRecord(ctx, sessionId, callId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || typeof callId !== 'string' || callId.length === 0) {
    throw new Error('sessionId and callId are required')
  }
  const header = await findSessionHeader(ctx, sessionId)
  if (header === undefined) throw new Error('session not found')
  const location = ctx.sessionPersistence.locate(header)
  if (location === undefined || typeof location.path !== 'string') throw new Error('session file metadata is unavailable')
  const path = join(dirname(location.path), META_FILE)
  const document = await readMetaFile(path, sessionId)
  const record = document.items[callId]
  if (!isPlainRecord(record) || String(record.callId) !== callId) throw new Error('file message not found')
  return record
}

function safeHeaderName(name) {
  return String(name || 'download').replace(/[\r\n"\\]/gu, '_').replace(/[^\x20-\x7e]/gu, '_') || 'download'
}

function contentDisposition(name, mode) {
  const fallback = safeHeaderName(name)
  const encoded = encodeURIComponent(String(name || 'download')).replace(/['()]/gu, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${mode === 'download' ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function handleContent(ctx, req, res) {
  const url = new URL(req.url || '/', 'http://dsh.local')
  const sessionId = url.searchParams.get('sessionId')
  const callId = url.searchParams.get('callId')
  const mode = url.searchParams.get('mode') || 'preview'
  if (mode !== 'preview' && mode !== 'download') {
    sendJson(res, 400, { ok: false, error: 'mode must be preview or download' })
    return
  }

  try {
    const record = await readRecord(ctx, sessionId, callId)
    const target = await ctx.fs.resolve(record.path, { cwd: record.cwd })
    const info = await ctx.fs.stat(target)
    if (info === undefined || info.type !== 'file') throw new Error('source file is no longer available')
    if (!ctx.fs.contains(await ctx.fs.resolve(record.cwd), target)) throw new Error('source file is outside the session workspace')

    const size = asPositiveSize(info)
    if (mode === 'preview' && (!String(record.mediaType).startsWith('image/') || size > MAX_PREVIEW_BYTES)) {
      throw new Error('image preview is unavailable for this file')
    }

    const mediaType = mode === 'preview' ? String(record.mediaType) : (String(record.mediaType) || 'application/octet-stream')
    res.writeHead(200, {
      'content-type': mediaType,
      'cache-control': 'no-store',
      'content-disposition': contentDisposition(record.displayName, mode),
      'content-length': size,
      'x-content-type-options': 'nosniff',
    })

    // Native streaming download: pipe the resolved host path straight to the
    // HTTP response. No full-file buffering in Node or the browser, and no
    // fixed transfer ceiling — the earlier MAX_TRANSFER_BYTES read bound no
    // longer applies to `download` (preview stays capped at MAX_PREVIEW_BYTES).
    const path = ctx.fs.processPath(target)
    const stream = createReadStream(path)
    stream.on('error', (error) => {
      if (res.headersSent) res.destroy(error)
      else {
        try {
          sendJson(res, 500, { ok: false, error: `failed to stream file: ${errorMessage(error)}` })
        } catch {
          res.destroy(error)
        }
      }
    })
    stream.pipe(res)
  } catch (error) {
    const status = /not found|no longer available|file message not found|session not found/iu.test(errorMessage(error)) ? 404 : 400
    sendJson(res, status, { ok: false, error: errorMessage(error) })
  }
}

export function apply(ctx) {
  const writeMeta = createMetaWriter(ctx)
  ctx.systemPrompt.section({
    name: 'tool:file-message',
    order: 104,
    text: 'When the user asks you to send or show a workspace file, use send_file. When the user asks you to send or show a PNG, JPEG, WebP, or GIF, use send_image. These tools reference the current workspace path instead of copying bytes, so explain that the message becomes unavailable if the source file is deleted or moved.',
  })

  ctx.tools.register(createTool(ctx, writeMeta, 'file'))
  ctx.tools.register(createTool(ctx, writeMeta, 'image'))

  const routeDisposer = ctx.webServer.register({
    kind: 'exact',
    path: API_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      return handleContent(ctx, req, res)
    },
  })

  ctx.effect(() => () => {
    routeDisposer()
  }, 'file-message: content route')
}

apply.inject = inject
export default apply
