import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, sep } from 'node:path'

/**
 * dsh-plugin-git-graph — Host half (static DSH bundle).
 *
 * Serves the browser bundle's read-only git API under /_dsh/git-graph:
 * git-log, git-commit, git-diff and git-status. Every route runs `git` through
 * the Host's subprocess service in the repository that contains the requested
 * path and answers JSON only.
 *
 * The bundle's libraries are served from this plugin too — the monaco editor
 * tree at /_dsh/git-graph/monaco/vs and markdown-it at
 * /_dsh/git-graph/vendor/markdown-it.mjs — so installing this plugin installs
 * everything its pages need and it never depends on dsh-plugin-file-explorer
 * being present alongside it.
 */

const require = createRequire(import.meta.url)

// monaco-editor ships pre-built AMD chunks under min/vs: the loader plus hashed
// editor/language/worker files that reference each other with module ids rooted
// at "vs/". Serving the whole tree verbatim under a stable URL prefix lets the
// browser-side AMD loader (baseUrl = that prefix) resolve every chunk with zero
// rewriting.
const MONACO_URL = '/_dsh/git-graph/monaco/vs'
const MONACO_MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

// markdown-it's standalone ESM build (the package's "./browser" import export),
// also served verbatim: no CDN, no bundler step. The ESM build is used
// deliberately: unlike the UMD build it has no AMD wrapper, so the monaco
// loader's global `define` can never hijack it.
const MARKDOWN_IT_URL = '/_dsh/git-graph/vendor/markdown-it.mjs'

// Resolution is lazy and cached: a missing library must degrade to one failing
// asset route (plus the page's own error message), never to a plugin row that
// fails to load.
let monacoDir
let monacoDirError
let markdownItPath
let markdownItPathError
let markdownItBody = null
const MONACO_CACHE = new Map()

function resolveMonacoDir() {
  if (monacoDir !== undefined || monacoDirError !== undefined) return monacoDir
  try {
    // monaco-editor >= 0.56 maps every subpath export to esm/vs/*, which makes
    // require.resolve('monaco-editor/package.json') resolve to a non-existent
    // esm/vs/package.json.js. Resolve the package root via the main entry instead.
    monacoDir = join(dirname(dirname(dirname(require.resolve('monaco-editor')))), 'min', 'vs')
  } catch (error) {
    monacoDirError = error && typeof error.message === 'string' ? error.message : String(error)
  }
  return monacoDir
}

function resolveMarkdownItPath() {
  if (markdownItPath !== undefined || markdownItPathError !== undefined) return markdownItPath
  try {
    markdownItPath = join(dirname(require.resolve('markdown-it/package.json')), 'dist', 'browser', 'markdown-it.esm.min.mjs')
  } catch (error) {
    markdownItPathError = error && typeof error.message === 'string' ? error.message : String(error)
  }
  return markdownItPath
}

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

export const name = 'git-graph'

/** Hard dependency: the active web server (which the auth webserver also provides). */
export const inject = ['webServer']

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  const disposers = []
  const addRoute = (path, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path, handler }))
  }






  // --- bundled editor assets -----------------------------------------------
  // Longest-prefix route: the browser's AMD loader fetches any file under
  // /_dsh/git-graph/monaco/vs/<module path>, and only ever from inside the
  // installed monaco-editor package. Registered as a prefix route, not "exact":
  // the exact table only matches the bare path, so every asset request would 404.
  const loadMonacoAsset = (file) => {
    let record = MONACO_CACHE.get(file)
    if (record === undefined) {
      const root = resolveMonacoDir()
      if (root === undefined) {
        record = { error: `monaco-editor is not installed: ${monacoDirError}` }
      } else {
        const path = join(root, file)
        const rel = relative(root, path)
        if (rel.startsWith('..') || rel.startsWith(sep) || path.split(sep).includes('..')) {
          record = { error: 'invalid monaco asset path' }
        } else {
          try {
            const body = readFileSync(path)
            const ext = file.slice(file.lastIndexOf('.'))
            record = { body, type: MONACO_MIME[ext] || 'application/octet-stream' }
          } catch (error) {
            record = { error: error && typeof error.message === 'string' ? error.message : String(error) }
          }
        }
      }
      MONACO_CACHE.set(file, record)
    }
    return record
  }

  disposers.push(webServer.register({
    kind: 'prefix',
    path: '/_dsh/git-graph/monaco',
    handler: (req, res) => {
      const pathname = new URL(req.url || '/', 'http://dsh.local').pathname
      const file = pathname.startsWith(`${MONACO_URL}/`)
        ? pathname.slice(MONACO_URL.length + 1)
        : null
      if (file === null || file === '') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end()
        return
      }
      const asset = loadMonacoAsset(file)
      if (asset.error) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(asset.error)
        return
      }
      res.writeHead(200, {
        'content-type': asset.type,
        'content-length': asset.body.length,
        // Hashed chunk names are immutable per release; loader.js and the
        // nls/lang files are release-stable too, so a long cache is safe.
        'cache-control': 'public, max-age=31536000, immutable',
      })
      if (req.method === 'HEAD') res.end()
      else res.end(asset.body)
    },
  }))

  addRoute(MARKDOWN_IT_URL, (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    if (markdownItBody === null) {
      const path = resolveMarkdownItPath()
      try {
        if (path === undefined) throw new Error(`markdown-it is not installed: ${markdownItPathError}`)
        markdownItBody = readFileSync(path)
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(error && typeof error.message === 'string' ? error.message : String(error))
        return
      }
    }
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': markdownItBody.length,
      // Bundled file name is stable per plugin version; same long-cache policy
      // as the monaco tree.
      'cache-control': 'public, max-age=31536000, immutable',
    })
    if (req.method === 'HEAD') res.end()
    else res.end(markdownItBody)
  })

  // --- git plumbing --------------------------------------------------------
  // Every route resolves the repository root from the requested directory
  // first, then runs git with machine-readable separators; nothing but JSON
  // crosses the boundary.
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

  addRoute('/_dsh/git-graph/git-log', async (req, res) => {
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

  addRoute('/_dsh/git-graph/git-commit', async (req, res) => {
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

  addRoute('/_dsh/git-graph/git-diff', async (req, res) => {
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

  addRoute('/_dsh/git-graph/git-status', async (req, res) => {
    if (req.method === 'POST') req = await readJson(req)
    try {
      const { git, root } = await resolveRepo(req.path)
      const status = await runGit(git, root, ['status', '--porcelain=v1', '-b', '-uall'], 1024 * 1024)
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