/**
 * dsh-plugin-file-explorer — Host half (static DSH bundle).
 *
 * Registers exact HTTP routes under /_dsh/file-explorer for the browser
 * bundle: list (with parent path), read (text/image preview), download (data URL),
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

/** Strip git's "fatal: "/"error: " prefixes and collapse whitespace into one line. */
function cleanGitError(stderr, fallback) {
  const text = typeof stderr === 'string' ? stderr.trim() : ''
  if (text === '') return fallback
  const firstLine = text.split('\n')[0].replace(/^(fatal|error|warning):\s*/i, '').trim()
  return firstLine === '' ? fallback : firstLine
}

/** A commit-ish accepted from the browser: hex abbreviations or the WORKING sentinel. */
function isSafeCommitish(value) {
  return typeof value === 'string' && /^([0-9a-fA-F]{6,40}|WORKING)$/.test(value)
}

/** A path argument for `git ... -- <path>`: never empty, never option-like, no control characters. */
function isSafeGitPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith('-') &&
    !/[\0\r\n]/.test(value)
  )
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
      const name = target.displayPath.split('/').pop()
      const mime = guessMime(name)
      const isImage = mime.startsWith('image/')
      const limit = isImage ? 16 * 1024 * 1024 : 1024 * 1024
      if (size !== null && size > limit) {
        sendJson(res, 200, {
          ok: true,
          name,
          size,
          tooLarge: true,
          ...(isImage ? { kind: 'image', mime } : {}),
        })
        return
      }
      const bytes = await fs.readBytes(target, undefined, limit)
      if (isImage) {
        sendJson(res, 200, {
          ok: true,
          name,
          size,
          kind: 'image',
          mime,
          dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}`,
        })
        return
      }
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
      let binary = false
      for (let i = 0; i < bytes.length; i += 1) {
        if (bytes[i] === 0) { binary = true; break }
      }
      if (!binary && text.replace(/\uFFFD/g, '').length * 10 < text.length * 9) binary = true
      sendJson(res, 200, {
        ok: true,
        name,
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
      if (!info) {
        sendJson(res, 200, { ok: false, error: 'file does not exist' })
        return
      }
      // Directories are removed recursively; the UI gates this behind a
      // second-click confirm before the request is ever sent.
      const args = info.type === 'directory' ? ['rm', '-rf', '--'] : ['rm', '-f', '--']
      const path = fs.processPath(target)
      const handle = subprocess.spawn({
        argv: [...args, path],
        cwd: '/',
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        graceMs: 30000,
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

  // --- git graph API -------------------------------------------------------
  // Read-only git plumbing behind the browser's graph view. Every route
  // resolves the repository root from the requested directory first, then
  // runs git with machine-readable separators; nothing but JSON crosses the
  // boundary.
  let gitPathPromise = null
  const resolveGit = () => {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) return Promise.reject(new Error('subprocess service unavailable'))
    if (gitPathPromise === null) {
      gitPathPromise = subprocess
        .resolveExecutable('git')
        .catch((error) => {
          gitPathPromise = null
          throw error
        })
    }
    return gitPathPromise
  }

  const runGit = async (git, cwd, args, maxBytes) => {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) throw new Error('subprocess service unavailable')
    const handle = subprocess.spawn({
      argv: [git, ...args],
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes: 8192 } },
      graceMs: 15000,
    })
    const outcome = await handle.done
    const collect = (reader) => {
      if (!reader) return { text: '', truncated: false }
      const read = reader.readFrom(0)
      return { text: read.text, truncated: read.lossy === true }
    }
    const out = collect(handle.collected.stdout)
    const err = collect(handle.collected.stderr)
    return { code: outcome.exitCode, stdout: out.text, stderr: err.text, truncated: out.truncated }
  }

  // Resolve the requested (or workspace-root) directory to a process path.
  const resolveDir = async (requestedPath) => {
    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('filesystem service unavailable')
    let dir = typeof requestedPath === 'string' && requestedPath.trim() !== '' ? requestedPath : undefined
    if (dir === undefined) {
      const policy = ctx.get('sandboxPolicy')
      if (policy && typeof policy.workspaceRoot === 'string') dir = policy.workspaceRoot
    }
    if (typeof dir !== 'string') throw new Error('no directory given')
    const target = await fs.resolve(dir)
    return fs.processPath(target)
  }

  // Resolve the containing repository: { git, root } or throws a user-facing error.
  const resolveRepo = async (requestedPath) => {
    const dir = await resolveDir(requestedPath)
    const git = await resolveGit()
    const top = await runGit(git, dir, ['rev-parse', '--show-toplevel'], 4096)
    if (top.code !== 0) throw new Error(cleanGitError(top.stderr, 'not a git repository'))
    return { git, root: top.stdout.trim() }
  }

  const parseRefList = (stdout) => {
    const heads = new Set()
    const remotes = new Set()
    const tags = new Set()
    for (const line of stdout.split('\n')) {
      const ref = line.trim()
      if (ref.startsWith('refs/heads/')) heads.add(ref.slice('refs/heads/'.length))
      else if (ref.startsWith('refs/remotes/')) remotes.add(ref.slice('refs/remotes/'.length))
      else if (ref.startsWith('refs/tags/')) tags.add(ref.slice('refs/tags/'.length))
    }
    return { heads, remotes, tags }
  }

  // Classify one %D decorator token ("HEAD -> main", "origin/main", "tag: v1", ...) into a pill.
  const classifyRef = (token, refs) => {
    if (token === 'HEAD') return { kind: 'detached', name: 'HEAD' }
    if (token.startsWith('HEAD -> ')) return { kind: 'head', name: token.slice('HEAD -> '.length) }
    if (token.startsWith('tag: ')) return { kind: 'tag', name: token.slice('tag: '.length) }
    if (refs.heads.has(token)) return { kind: 'branch', name: token }
    if (refs.remotes.has(token)) return { kind: 'remote', name: token }
    return { kind: 'branch', name: token }
  }

  addRoute('/_dsh/file-explorer/git-log', async (req, res) => {
    if (req.method === 'POST') req = await readJson(req)
    try {
      const { git, root } = await resolveRepo(req.path)
      const headRes = await runGit(git, root, ['rev-parse', '--abbrev-ref', 'HEAD'], 4096)
      const head = headRes.code === 0 ? headRes.stdout.trim() : null
      const refsRes = await runGit(git, root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'], 256 * 1024)
      const refs = parseRefList(refsRes.stdout)
      const limitRaw = Number(req.limit)
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 2000) : 300
      const args = ['log', '--all', '--date-order', `--max-count=${limit}`, '--no-color', '--pretty=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e']
      if (req.all === false) args.splice(1, 1)
      const logRes = await runGit(git, root, args, 8 * 1024 * 1024)
      if (logRes.code !== 0) {
        sendJson(res, 200, { ok: false, error: cleanGitError(logRes.stderr, 'git log failed') })
        return
      }
      const commits = []
      for (const record of logRes.stdout.split('\x1e')) {
        const line = record.startsWith('\n') ? record.slice(1) : record
        if (line.trim() === '') continue
        const f = line.split('\x1f')
        const decorated = f[5] || ''
        commits.push({
          hash: f[0] || '',
          parents: f[1] ? f[1].split(' ').filter(Boolean) : [],
          author: f[2] || '',
          email: f[3] || '',
          date: Number(f[4]) || 0,
          refs: decorated.split(',').map((part) => part.trim()).filter(Boolean).map((token) => classifyRef(token, refs)),
          subject: f[6] || '',
        })
      }
      sendJson(res, 200, { ok: true, root, head, commits, truncated: logRes.truncated })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error && typeof error.message === 'string' ? error.message : String(error) })
    }
  })

  addRoute('/_dsh/file-explorer/git-commit', async (req, res) => {
    if (req.method === 'POST') req = await readJson(req)
    if (!isSafeCommitish(req.hash) || req.hash === 'WORKING') {
      sendJson(res, 200, { ok: false, error: 'invalid commit hash' })
      return
    }
    try {
      const { git, root } = await resolveRepo(req.path)
      const show = await runGit(git, root, ['show', '-s', '--no-color', '--format=%H%x1f%an%x1f%at%x1f%B', req.hash], 256 * 1024)
      if (show.code !== 0) {
        sendJson(res, 200, { ok: false, error: cleanGitError(show.stderr, 'unknown commit') })
        return
      }
      const f = show.stdout.split('\x1f')
      // -m --first-parent diffs merge commits against their first parent,
      // matching the graph view's linear history; --root covers the initial commit.
      const tree = await runGit(git, root, ['diff-tree', '--no-commit-id', '--name-status', '-r', '--root', '-m', '--first-parent', '--no-color', '-z', req.hash], 1024 * 1024)
      const files = []
      if (tree.code === 0) {
        const tokens = tree.stdout.split('\0')
        for (let i = 0; i < tokens.length;) {
          const status = tokens[i]
          if (status === '') break
          i += 1
          const letter = status[0]
          if ((letter === 'R' || letter === 'C') && i + 1 < tokens.length) {
            files.push({ status: letter, oldPath: tokens[i], path: tokens[i + 1] })
            i += 2
          } else if (i < tokens.length) {
            files.push({ status: letter, path: tokens[i] })
            i += 1
          }
        }
      }
      sendJson(res, 200, {
        ok: true,
        hash: (f[0] || req.hash).trim(),
        author: (f[1] || '').trim(),
        date: Number(f[2]) || 0,
        message: (f[3] || '').replace(/\n+$/, ''),
        files,
      })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error && typeof error.message === 'string' ? error.message : String(error) })
    }
  })

  addRoute('/_dsh/file-explorer/git-diff', async (req, res) => {
    if (req.method === 'POST') req = await readJson(req)
    if (!isSafeCommitish(req.hash)) {
      sendJson(res, 200, { ok: false, error: 'invalid commit hash' })
      return
    }
    if (!isSafeGitPath(req.file)) {
      sendJson(res, 200, { ok: false, error: 'invalid file path' })
      return
    }
    try {
      const { git, root } = await resolveRepo(req.path)
      const args = req.hash === 'WORKING'
        ? ['diff', 'HEAD', '--no-color', '--no-ext-diff', '--', req.file]
        : ['show', '--no-color', '--no-ext-diff', '--format=', '-m', '--first-parent', req.hash, '--', req.file]
      const diff = await runGit(git, root, args, 512 * 1024)
      if (diff.code !== 0) {
        sendJson(res, 200, { ok: false, error: cleanGitError(diff.stderr, 'git diff failed') })
        return
      }
      sendJson(res, 200, { ok: true, patch: diff.stdout, truncated: diff.truncated })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: error && typeof error.message === 'string' ? error.message : String(error) })
    }
  })

  addRoute('/_dsh/file-explorer/git-status', async (req, res) => {
    if (req.method === 'POST') req = await readJson(req)
    try {
      const { git, root } = await resolveRepo(req.path)
      const status = await runGit(git, root, ['status', '--porcelain=v1', '-b'], 1024 * 1024)
      if (status.code !== 0) {
        sendJson(res, 200, { ok: false, error: cleanGitError(status.stderr, 'git status failed') })
        return
      }
      const lines = status.stdout.split('\n')
      let branch = null
      let unborn = false
      let upstream = null
      let ahead = 0
      let behind = 0
      const header = lines.length > 0 ? lines[0] : ''
      if (header.startsWith('## ')) {
        const info = header.slice(3)
        if (/^HEAD \(no branch\)$/.test(info)) {
          branch = null
        } else if (info.startsWith('No commits yet on ')) {
          branch = info.slice('No commits yet on '.length)
          unborn = true
        } else {
          const dots = info.indexOf('...')
          if (dots === -1) {
            branch = info
          } else {
            branch = info.slice(0, dots)
            const rest = info.slice(dots + 3)
            const bracket = rest.indexOf(' [')
            upstream = bracket === -1 ? rest : rest.slice(0, bracket)
            const flags = bracket === -1 ? '' : rest.slice(bracket + 2).replace(/\]$/, '')
            for (const flag of flags.split(',')) {
              const part = flag.trim().split(' ')
              if (part[0] === 'ahead') ahead = Number(part[1]) || 0
              if (part[0] === 'behind') behind = Number(part[1]) || 0
            }
          }
        }
      }
      const entries = []
      for (const line of lines.slice(1)) {
        if (line.length < 4) continue
        const x = line[0]
        const y = line[1]
        const rawPath = line.slice(3)
        const arrow = x === 'R' || x === 'C' ? rawPath.indexOf(' -> ') : -1
        if (arrow !== -1) {
          entries.push({ status: x, oldPath: rawPath.slice(0, arrow), path: rawPath.slice(arrow + 4) })
        } else {
          entries.push({ status: x === ' ' ? y : x, path: rawPath })
        }
      }
      sendJson(res, 200, { ok: true, root, branch, unborn, upstream, ahead, behind, entries })
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