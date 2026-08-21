/**
 * dsh-plugin-file-explorer — Host half (static DSH bundle).
 *
 * Registers exact HTTP routes under /_dsh/file-explorer for the browser
 * bundle: list (with parent path), read (text preview), download (data URL),
 * and delete.
 */

function parentOf(path) {
  if (!path) return null
  const cleaned = path.replace(/[/\\]+$/, '')
  if (cleaned === '' || /^[A-Za-z]:$/.test(cleaned)) return null
  const slash = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  if (slash < 0) return null
  if (slash === 0) return cleaned[0] === '/' ? '/' : null
  const parent = cleaned.slice(0, slash)
  return parent === '' ? null : parent
}

function bytesToBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function guessMime(name) {
  const ext = (name.split('.').pop() || '').toLowerCase()
  const map = {
    json: 'application/json', txt: 'text/plain', md: 'text/markdown',
    js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
    ts: 'text/typescript', tsx: 'text/typescript', jsx: 'text/javascript',
    html: 'text/html', htm: 'text/html', css: 'text/css',
    csv: 'text/csv', yml: 'text/yaml', yaml: 'text/yaml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip',
  }
  return map[ext] || 'application/octet-stream'
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

async function readJson(req) {
  let body = ''
  for await (const chunk of req) body += chunk
  if (body.length === 0) return {}
  return JSON.parse(body)
}

export const name = 'file-explorer'

/** Hard dependency: the active web server (which the auth webserver also provides). */
export const inject = ['webServer']

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  const disposers = []
  const addRoute = (path, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path, handler }))
  }

  addRoute('/_dsh/file-explorer/list', async (req, res) => {
    if (req.method === 'POST') req = await readJson(req)
    const fs = ctx.get('fs')
    if (fs === undefined) {
      sendJson(res, 200, { ok: false, error: 'filesystem service unavailable' })
      return
    }

    let requestedPath
    if (typeof req.path === 'string' && req.path.trim() !== '') {
      requestedPath = req.path
    } else {
      const policy = ctx.get('sandboxPolicy')
      if (policy && typeof policy.workspaceRoot === 'string') requestedPath = policy.workspaceRoot
    }
    if (typeof requestedPath !== 'string') {
      sendJson(res, 200, { ok: false, error: 'no directory to list' })
      return
    }

    try {
      const target = await fs.resolve(requestedPath)
      const entries = await fs.listDir(target)
      sendJson(res, 200, {
        ok: true,
        path: target.displayPath,
        parent: parentOf(target.displayPath),
        entries: entries.map((entry) => ({
          name: entry.name,
          type: entry.type,
          size: typeof entry.size === 'number' ? entry.size : null,
          path: entry.target.displayPath,
        })),
      })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error && typeof error.message === 'string' ? error.message : String(error) })
    }
  })

  addRoute('/_dsh/file-explorer/read', async (req, res) => {
    if (req.method === 'POST') req = await readJson(req)
    const fs = ctx.get('fs')
    if (fs === undefined) {
      sendJson(res, 200, { ok: false, error: 'filesystem service unavailable' })
      return
    }
    if (typeof req.path !== 'string') {
      sendJson(res, 200, { ok: false, error: 'missing file path' })
      return
    }

    try {
      const target = await fs.resolve(req.path)
      const info = await fs.stat(target)
      const size = info && typeof info.size === 'number' ? info.size : null
      const limit = 256 * 1024
      if (size !== null && size > limit) {
        sendJson(res, 200, { ok: true, name: target.displayPath.split('/').pop(), size, tooLarge: true })
        return
      }
      const bytes = await fs.readBytes(target, undefined, limit)
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      let binary = false
      for (let i = 0; i < bytes.length; i += 1) {
        if (bytes[i] === 0) { binary = true; break }
      }
      if (!binary && text.replace(/\uFFFD/g, '').length * 10 < text.length * 9) binary = true
      sendJson(res, 200, {
        ok: true,
        name: target.displayPath.split('/').pop(),
        size,
        text: binary ? null : text,
        binary,
      })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error && typeof error.message === 'string' ? error.message : String(error) })
    }
  })

  addRoute('/_dsh/file-explorer/download', async (req, res) => {
    if (req.method === 'POST') req = await readJson(req)
    const fs = ctx.get('fs')
    if (fs === undefined) {
      sendJson(res, 200, { ok: false, error: 'filesystem service unavailable' })
      return
    }
    if (typeof req.path !== 'string') {
      sendJson(res, 200, { ok: false, error: 'missing file path' })
      return
    }

    try {
      const target = await fs.resolve(req.path)
      const info = await fs.stat(target)
      const size = info && typeof info.size === 'number' ? info.size : null
      const limit = 64 * 1024 * 1024
      if (size !== null && size > limit) {
        sendJson(res, 200, { ok: false, error: 'file too large for explorer download' })
        return
      }
      const bytes = await fs.readBytes(target, undefined, limit)
      const name = target.displayPath.split('/').pop()
      sendJson(res, 200, { ok: true, name, size, dataUrl: `data:${guessMime(name)};base64,${bytesToBase64(bytes)}` })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error && typeof error.message === 'string' ? error.message : String(error) })
    }
  })

  addRoute('/_dsh/file-explorer/delete', async (req, res) => {
    if (req.method === 'POST') req = await readJson(req)
    if (typeof req.path !== 'string') {
      sendJson(res, 200, { ok: false, error: 'missing file path' })
      return
    }
    const subprocess = ctx.get('subprocess')
    const fs = ctx.get('fs')
    if (subprocess === undefined) {
      sendJson(res, 200, { ok: false, error: 'subprocess service unavailable' })
      return
    }
    if (fs === undefined) {
      sendJson(res, 200, { ok: false, error: 'filesystem service unavailable' })
      return
    }

    try {
      const target = await fs.resolve(req.path)
      const info = await fs.stat(target)
      if (!info || info.type !== 'file') {
        sendJson(res, 200, { ok: false, error: info ? 'only regular files can be deleted here' : 'file does not exist' })
        return
      }
      const path = fs.processPath(target)
      const handle = subprocess.spawn({
        argv: ['rm', '-f', '--', path],
        cwd: '/',
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        graceMs: 5000,
      })
      const outcome = await handle.done
      if (outcome.exitCode !== 0) {
        sendJson(res, 200, { ok: false, error: `remove failed with exit code ${outcome.exitCode}` })
        return
      }
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error && typeof error.message === 'string' ? error.message : String(error) })
    }
  })

  ctx.effect(() => () => {
    while (disposers.length > 0) {
      const dispose = disposers.pop()
      try {
        dispose()
      } catch (_e) {
        // Route teardown is best-effort while the web server is shutting down.
      }
    }
  })
}

/** Attach inject on the default-exported apply: the loader unwraps default exports and drops named exports. */
apply.inject = ['webServer']

export default apply