/**
 * Tests for the code-server plugin.
 *
 * The Host routes are driven through a fake Cordis context and a fake web
 * server whose routes are real registered handlers. The loopback "child" is a
 * real HTTP/TCP listener on the claimed port, so the proxy is exercised
 * against actual sockets rather than a copy of its logic.
 */
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { PassThrough, Readable } from 'node:stream'
import test from 'node:test'
import vm from 'node:vm'

import { apply, Config, inject as hostInject, name as hostName, workbenchStaticPrefix } from '../index.js'
import { detect, resolveExecutablePath, readVersion } from '../detect.js'
import {
  codeServerArgs, configYaml, createInstanceRegistry, isInstanceId, workspaceDirName,
} from '../instances.js'
import {
  isSameOriginRequest, proxyHttp, proxyUpgrade, scopeLocation, scopeSetCookie, upstreamPath,
} from '../proxy.js'

// ---------------------------------------------------------------------------
// URL / header helpers
// ---------------------------------------------------------------------------

test('upstreamPath strips the instance prefix and keeps the query', () => {
  const prefix = '/_dsh/code-server/i/cs-1'
  assert.equal(upstreamPath(`${prefix}/`, prefix), '/')
  assert.equal(upstreamPath(`${prefix}/?folder=/w&x=1`, prefix), '/?folder=/w&x=1')
  assert.equal(upstreamPath(`${prefix}/_static/out/main.js?v=2`, prefix), '/_static/out/main.js?v=2')
  assert.equal(upstreamPath(prefix, prefix), '/')
  assert.equal(upstreamPath(undefined, prefix), '/')
})

test('scopeSetCookie scopes only an unscoped Path=/ and leaves narrower paths', () => {
  const prefix = '/_dsh/code-server/i/cs-1'
  assert.equal(scopeSetCookie('a=b; Path=/; HttpOnly', prefix), `a=b; Path=${prefix}/; HttpOnly`)
  assert.equal(scopeSetCookie('a=b; Path=/api', prefix), 'a=b; Path=/api')
  assert.equal(scopeSetCookie('a=b; HttpOnly', prefix), `a=b; HttpOnly; Path=${prefix}`)
})

test('scopeLocation keeps relative redirects and prefixes absolute ones', () => {
  const prefix = '/_dsh/code-server/i/cs-1'
  assert.equal(scopeLocation('./?folder=/w', prefix), './?folder=/w')
  assert.equal(scopeLocation('/healthz', prefix), `${prefix}/healthz`)
  assert.equal(scopeLocation(`${prefix}/already`, prefix), `${prefix}/already`)
  assert.equal(scopeLocation('https://example.com/x', prefix), 'https://example.com/x')
  assert.equal(scopeLocation('//example.com/x', prefix), '//example.com/x')
})

test('isSameOriginRequest accepts an origin-less request and rejects a foreign one', () => {
  assert.equal(isSameOriginRequest(undefined, '127.0.0.1:56789'), true)
  assert.equal(isSameOriginRequest('http://127.0.0.1:56789', '127.0.0.1:56789'), true)
  assert.equal(isSameOriginRequest('http://evil.example', '127.0.0.1:56789'), false)
  assert.equal(isSameOriginRequest('not a url', '127.0.0.1:56789'), false)
})

// ---------------------------------------------------------------------------
// Instance argv / identity
// ---------------------------------------------------------------------------

test('configYaml pins loopback, no auth and no TLS', () => {
  assert.equal(configYaml(14003), 'bind-addr: 127.0.0.1:14003\nauth: none\ncert: false\n')
})

test('codeServerArgs opens the workspace and points at a shared extensions dir', () => {
  const argv = codeServerArgs({
    executable: '/usr/bin/code-server',
    port: 14003,
    dir: '/state/workspaces/abc',
    folder: '/workspace/project',
    extensionsDir: '/state/extensions',
    sharedDataDir: '/state/workspaces/abc/shared',
    extraArgs: ['--locale', 'zh-cn'],
  })
  assert.equal(argv[0], '/usr/bin/code-server')
  assert.equal(argv[argv.length - 1], '/workspace/project')
  assert.deepEqual(argv.slice(-3, -1), ['--locale', 'zh-cn'])
  assert.equal(argv[argv.indexOf('--extensions-dir') + 1], '/state/extensions')
  // VS Code's shared storage has no code-server flag; it is passed through so
  // each workspace keeps its own `sharedStorage/state.vscdb` inside DSH_HOME
  // instead of the machine-wide `~/.vscode-oss-shared`.
  const passthrough = argv[argv.indexOf('--vscode-option') + 1]
  assert.equal(passthrough, 'shared-data-dir=/state/workspaces/abc/shared')
  // code-server's default would put extensions under --user-data-dir; the
  // shared path must be outside this workspace's directory.
  assert.equal(argv[argv.indexOf('--user-data-dir') + 1], '/state/workspaces/abc/user-data')
  assert.ok(argv.includes('--auth'))
  assert.ok(argv.includes('none'))
  // Deliberately absent: code-server records the opened folder in `coder.json`
  // and reading it back is what restores the workspace after a restart. The
  // `?folder=` URL still wins because the last-opened branch only runs when no
  // folder/workspace query is present.
  assert.ok(!argv.includes('--ignore-last-opened'))
  assert.ok(argv.some((part) => part === '127.0.0.1:14003'))
})

test('workspaceDirName is stable, safe and collision-resistant', () => {
  const a = workspaceDirName('workspace/one')
  assert.equal(a, workspaceDirName('workspace/one'))
  assert.ok(!a.includes('/'))
  assert.notEqual(a, workspaceDirName('workspace/one/other'))
  assert.notEqual(workspaceDirName('a/b'), workspaceDirName('a_b'))
  assert.equal(isInstanceId('cs-1'), true)
  assert.equal(isInstanceId('cs-0'), false)
  assert.equal(isInstanceId('../cs-1'), false)
})

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test('detect reports a missing binary instead of throwing', async () => {
  const result = await detect({
    executable: 'code-server',
    resolveExecutable: async () => { throw new Error('not found') },
  })
  assert.deepEqual(result, { installed: false, executable: 'code-server', path: null, version: null })
  assert.equal(await resolveExecutablePath({ resolveExecutable: undefined, executable: 'x' }), null)
})

test('detect reads the version from the resolved binary', async () => {
  const seen = []
  const result = await detect({
    executable: 'code-server',
    resolveExecutable: async (command) => `/usr/bin/${command}`,
    spawn: (spec) => {
      seen.push(spec.argv)
      return {
        done: Promise.resolve({ exitCode: 0 }),
        collected: {
          stdout: { readFrom: () => ({ text: '4.100.0 abc1234def with Code 1.100.0\n' }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
      }
    },
  })
  assert.equal(result.installed, true)
  assert.equal(result.path, '/usr/bin/code-server')
  assert.equal(result.version, '4.100.0 abc1234def with Code 1.100.0')
  assert.deepEqual(seen, [['/usr/bin/code-server', '--version']])
})

test('workbenchStaticPrefix reads the static directory VS Code builds its socket path from', () => {
  // Real shape served by code-server 4.145.0: the workbench script is a
  // path-relative reference to the versioned static directory, and
  // `patches/base-path.diff` appends exactly that directory to the page path.
  const html = '<script type="module" src="stable-2cb3ad3e258891fbb51001ba465c2348d5021644/static/out/vs/code/browser/workbench/workbench.js"></script>'
  // The socket URL is built as `location.pathname + "/" + <server root>`, and
  // a live instance connected to `<prefix>/stable-<commit>` — the versioned
  // root only, NOT the deeper workbench directory.
  assert.equal(workbenchStaticPrefix(html), 'stable-2cb3ad3e258891fbb51001ba465c2348d5021644')
  assert.equal(workbenchStaticPrefix("'stable-abc123/static/out/vs/code/browser/workbench/x.js'"),
    'stable-abc123')
  // Anything that is not that shape must report "unknown" rather than guess:
  // a wrong upgrade path would silently break every WebSocket.
  assert.equal(workbenchStaticPrefix('<html>nothing here</html>'), null)
  assert.equal(workbenchStaticPrefix(undefined), null)
  assert.equal(workbenchStaticPrefix('stable-abc/static/other/'), null)
})

test('readVersion ignores a first-run info line and returns the version', async () => {
  // `code-server --version` writes "Wrote default config file…" on first run
  // before the version. Taking the first non-empty line reported that log line
  // as the version (observed on a real install).
  const handle = (text) => ({
    done: Promise.resolve({ exitCode: 0 }),
    collected: {
      stdout: { readFrom: () => ({ text }) },
      stderr: { readFrom: () => ({ text: '' }) },
    },
  })
  const withInfo = await readVersion({
    spawn: () => handle('[2026-11-05T06:55:06.463Z] info  Wrote default config file to /root/.config/code-server/config.yaml\n4.145.0 2cb3ad3e258891fbb51001ba465c2348d5021644 with Code 1.145.0\n'),
    executablePath: '/bin/code-server',
  })
  assert.equal(withInfo, '4.145.0 2cb3ad3e258891fbb51001ba465c2348d5021644 with Code 1.145.0')

  const clean = await readVersion({
    spawn: () => handle('4.145.0 2cb3ad3e258891fbb51001ba465c2348d5021644 with Code 1.145.0\n'),
    executablePath: '/bin/code-server',
  })
  assert.equal(clean, '4.145.0 2cb3ad3e258891fbb51001ba465c2348d5021644 with Code 1.145.0')

  const noiseOnly = await readVersion({
    spawn: () => handle('[2026-11-05T06:55:06.463Z] info  Wrote default config file\n'),
    executablePath: '/bin/code-server',
  })
  assert.equal(noiseOnly, null, 'a log line alone is not a version')
})

test('readVersion tolerates a failing probe', async () => {
  assert.equal(await readVersion({ spawn: undefined, executablePath: '/bin/x' }), null)
  const result = await readVersion({
    spawn: () => { throw new Error('spawn failed') },
    executablePath: '/bin/x',
  })
  assert.equal(result, null)
})

// ---------------------------------------------------------------------------
// Real loopback upstream for the proxy
// ---------------------------------------------------------------------------

/** Start an echo server on a free port owned by the test. */
async function startEchoServer() {
  const seen = []
  const server = createHttpServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: { ...req.headers } })
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': ['session=abc; Path=/; HttpOnly'],
      location: '/healthz',
      'service-worker-allowed': '/',
    })
    res.end(JSON.stringify({ ok: true, url: req.url }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    seen,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    }),
  }
}

function fakeReq({ url, method = 'GET', headers = {} }) {
  const req = Readable.from([])
  req.method = method
  req.url = url
  req.headers = headers
  req.socket = { remoteAddress: '127.0.0.1' }
  req.rawHeaders = Object.entries(headers).flatMap(([key, value]) => [key, value])
  return req
}

function fakeRes() {
  const res = new PassThrough()
  const chunks = []
  let status = null
  let responseHeaders = null
  res.on('data', (chunk) => chunks.push(chunk))
  res.writeHead = (code, headers) => {
    status = code
    responseHeaders = headers
    res.headersSent = true
    return res
  }
  return {
    res,
    finished: new Promise((resolve) => res.once('end', resolve)),
    result: () => ({ status, headers: responseHeaders, body: Buffer.concat(chunks).toString() }),
  }
}

test('proxyHttp strips the prefix, rewrites Host/Origin and scopes cookies', async () => {
  const upstream = await startEchoServer()
  try {
    const prefix = '/_dsh/code-server/i/cs-1'
    const req = fakeReq({
      url: `${prefix}/_static/main.js?v=1`,
      headers: {
        host: 'gui.example:56789',
        origin: 'http://gui.example:56789',
        cookie: 'dsh-auth-x=secret',
        'x-custom': 'kept',
      },
    })
    const out = fakeRes()
    proxyHttp({
      req,
      res: out.res,
      port: upstream.port,
      path: upstreamPath(req.url, prefix),
      prefix,
    })
    await out.finished
    const result = out.result()
    assert.equal(result.status, 200)
    assert.equal(upstream.seen.length, 1)
    assert.equal(upstream.seen[0].url, '/_static/main.js?v=1')
    assert.equal(upstream.seen[0].headers.host, `127.0.0.1:${upstream.port}`)
    assert.equal(upstream.seen[0].headers.origin, `http://127.0.0.1:${upstream.port}`)
    assert.equal(upstream.seen[0].headers['x-custom'], 'kept')
    // The Harness's own cookie is not leaked to the child.
    assert.equal(upstream.seen[0].headers.cookie, undefined)
    assert.deepEqual(result.headers['set-cookie'], [`session=abc; Path=${prefix}/; HttpOnly`])
    assert.equal(result.headers.location, `${prefix}/healthz`)
    assert.equal(result.headers['service-worker-allowed'], undefined)
    assert.match(result.body, /"url":"\/_static\/main\.js\?v=1"/u)
  } finally {
    await upstream.close()
  }
})

test('proxyUpgrade replays the handshake with a loopback Host/Origin and a stripped path', async () => {
  const captured = []
  const server = createNetServer((socket) => {
    socket.once('data', (chunk) => {
      captured.push(chunk.toString('utf8'))
      socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const prefix = '/_dsh/code-server/i/cs-1'
    const req = fakeReq({
      url: `${prefix}/?reconnectionToken=t`,
      headers: {
        host: 'gui.example:56789',
        origin: 'http://gui.example:56789',
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    })
    const socket = new PassThrough()
    try {
      proxyUpgrade({ req, socket, head: Buffer.alloc(0), port, path: upstreamPath(req.url, prefix) })
      await Promise.race([
        new Promise((resolve) => {
          const timer = setInterval(() => { if (captured.length > 0) { clearInterval(timer); resolve() } }, 10)
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('upgrade handshake never arrived')), 2000)),
      ])
      const handshake = captured[0]
      assert.match(handshake, /^GET \/\?reconnectionToken=t HTTP\/1\.1\r\n/u)
      assert.match(handshake, new RegExp(`Host: 127\\.0\\.0\\.1:${port}`, 'iu'))
      assert.match(handshake, new RegExp(`Origin: http://127\\.0\\.0\\.1:${port}`, 'iu'))
      // Hop-by-hop headers must survive: without them this is not an upgrade.
      assert.match(handshake, /Connection: Upgrade/iu)
      assert.match(handshake, /Upgrade: websocket/iu)
      // The Harness session cookie must not be replayed to the child.
      assert.doesNotMatch(handshake, /cookie:/iu)
    } finally {
      socket.destroy()
    }
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})

// ---------------------------------------------------------------------------
// Host routes through a fake Cordis context
// ---------------------------------------------------------------------------

let harnessSequence = 0

function makeHarness({ installed = true, installSucceeds = false } = {}) {
  // A disjoint port pool per harness: tests in this file must never race for
  // the same loopback port even if the runner schedules them concurrently.
  const portBase = 14100 + (harnessSequence += 1) * 20
  const routes = []
  const upgrades = []
  const disposers = []
  const listeners = new Map()
  const launched = []
  const servers = []

  /**
   * Offset reader over one fixed text, like the subprocess service's collected
   * streams: `readFrom(n)` returns only the bytes after `n`.
   */
  const offsetReader = (text) => ({
    readFrom: (from) => ({ text: text.slice(from), nextOffset: text.length, lossy: false }),
  })

  /** Set once the fake install "succeeds", so re-detection finds the binary. */
  let installedByJob = false

  const spawn = (spec) => {
    if (spec.argv.includes('--version')) {
      return {
        done: Promise.resolve({ exitCode: 0 }),
        collected: {
          stdout: { readFrom: () => ({ text: '4.100.0 abc1234def with Code 1.100.0\n' }) },
          stderr: { readFrom: () => ({ text: '' }) },
        },
        terminate() {},
      }
    }
    // The guided install: not a code-server instance. It reports one line on
    // stdout and exits after a moment, so the panel's live poll has something
    // to observe.
    if (spec.argv.some((part) => part === 'install')) {
      const output = 'added 1 package\ninstalled code-server\n'
      return {
        done: new Promise((resolve) => setTimeout(() => {
          if (installSucceeds) installedByJob = true
          resolve({ exitCode: installSucceeds ? 0 : 1 })
        }, 40)),
        collected: { stdout: offsetReader(output), stderr: offsetReader('') },
        terminate() {},
      }
    }
    launched.push(spec)
    const bind = spec.argv[spec.argv.indexOf('--bind-addr') + 1]
    const port = Number(bind.split(':')[1])
    const server = createHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`upstream ${req.url}`)
    })
    server.listen(port, '127.0.0.1')
    servers.push(server)
    return {
      done: new Promise(() => {}),
      collected: {
        stdout: { readFrom: () => ({ text: '' }) },
        stderr: { readFrom: () => ({ text: '' }) },
      },
      terminate() { try { server.close() } catch { /* already closed */ } },
    }
  }

  const services = {
    webServer: {
      getOrigin: () => 'http://127.0.0.1:56789',
      register(route) {
        routes.push(route)
        return () => { const at = routes.indexOf(route); if (at !== -1) routes.splice(at, 1) }
      },
      registerUpgrade(route) {
        upgrades.push(route)
        return () => { const at = upgrades.indexOf(route); if (at !== -1) upgrades.splice(at, 1) }
      },
    },
    subprocess: {
      resolveExecutable: async (command) => {
        // `installed` flips true once the fake guided install has run, which is
        // what the Host re-detects before calling the install a success.
        if (command === 'code-server' ? !installed && !installedByJob : !installed) throw new Error('not found')
        return `/usr/bin/${command}`
      },
      spawn,
    },
    workspaceRegistry: {
      get: (id) => (id === 'w-1'
        ? { id: 'w-1', path: '/workspace/project', title: 'Project' }
        : undefined),
      list: () => [{ id: 'w-1', path: '/workspace/project', title: 'Project' }],
    },
  }

  const ctx = {
    get(name) { return services[name] },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name) },
    logger: { info() {}, warn() {}, error() {} },
  }

  const routeFor = (path) => routes.find((route) => route.path === path)
  return {
    ctx, routes, upgrades, disposers, listeners, launched, servers, routeFor,
    config: {
      enabled: true,
      executable: 'code-server',
      installCommand: ['npm', 'install', '-g', 'code-server'],
      portRange: [portBase, portBase + 9],
      extraArgs: [],
      stateDir: '/tmp/dsh-code-server-test-state',
      extensionsDir: '/tmp/dsh-code-server-test-shared-extensions',
      startupTimeoutMs: 3000,
      installTimeoutMs: 3000,
    },
    cleanup: () => {
      for (const dispose of disposers.splice(0).reverse()) {
        try { dispose() } catch { /* best effort */ }
      }
      for (const server of servers) {
        try { server.closeAllConnections?.(); server.close() } catch { /* best effort */ }
      }
    },
  }
}

function req({ method = 'GET', url = '/', body = '', headers = {} }) {
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body)
    },
  }
}

function res() {
  const out = {
    status: null,
    headers: null,
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) { out.status = status; out.headers = headers; out.headersSent = true; return out },
    end(chunk) { if (chunk !== undefined) out.body += String(chunk); out.writableEnded = true; return out },
    json() { return JSON.parse(out.body) },
    on() { return out },
    once() { return out },
    destroy() { return out },
  }
  return out
}

test('the Host module is a mountable plugin with a declared inject list', () => {
  assert.equal(hostName, 'code-server')
  assert.deepEqual([...hostInject].sort(), ['subprocess', 'webServer'])
  assert.ok(Config !== undefined)
  assert.equal(typeof apply, 'function')
})

test('apply registers the four fixed routes and /state reports detection', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)
  apply(h.ctx, h.config)
  for (const path of [
    '/_dsh/code-server/state',
    '/_dsh/code-server/detect',
    '/_dsh/code-server/install',
    '/_dsh/code-server/sessions',
  ]) {
    assert.ok(h.routeFor(path), `missing route ${path}`)
  }
  const response = res()
  await h.routeFor('/_dsh/code-server/state').handler(req({ url: '/_dsh/code-server/state' }), response)
  assert.equal(response.status, 200)
  assert.equal(response.json().installed, true)
  assert.equal(response.json().version, '4.100.0 abc1234def with Code 1.100.0')
  assert.equal(response.json().installCommand, 'npm install -g code-server')
  assert.equal(response.json().extensionsDir, '/tmp/dsh-code-server-test-shared-extensions')
  assert.deepEqual(response.json().instances, [])
})

test('a missing binary produces the setup-guide state, not a mount failure', async (t) => {
  const h = makeHarness({ installed: false })
  t.after(h.cleanup)
  apply(h.ctx, h.config)
  const response = res()
  await h.routeFor('/_dsh/code-server/state').handler(req({ url: '/_dsh/code-server/state' }), response)
  assert.equal(response.json().installed, false)
  assert.equal(response.json().executablePath, null)
})

/** Wait for a predicate without hanging a failed assertion forever. */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('POST /sessions creates one instance per workspace and shares extensions', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)
  apply(h.ctx, h.config)
  const sessions = h.routeFor('/_dsh/code-server/sessions')

  const first = res()
  await sessions.handler(req({
    method: 'POST',
    url: '/_dsh/code-server/sessions',
    body: JSON.stringify({
      workspaceId: 'w-1',
      workspacePath: '/untrusted/path',
      workspaceTitle: 'Ignored title',
    }),
  }), first)
  assert.equal(first.status, 200)
  const created = first.json()
  assert.equal(created.state, 'starting')
  assert.equal(created.workspaceId, 'w-1')
  // `workspaceRegistry` is authoritative: a forged Client path/title cannot
  // point the editor at another directory.
  assert.equal(created.cwd, '/workspace/project')
  assert.equal(created.workspacePath, '/workspace/project')
  assert.equal(created.workspaceTitle, 'Project')
  assert.equal(created.url, `_dsh/code-server/i/${created.id}/`)

  // `create` answers while the child boots on a promise nobody awaits.
  await waitFor(() => h.launched.length === 1)
  assert.equal(h.launched.length, 1)
  const argv = h.launched[0].argv
  assert.equal(argv.at(-1), '/workspace/project', 'VS Code opens the workspace path')
  assert.equal(argv[argv.indexOf('--extensions-dir') + 1], h.config.extensionsDir)

  const prefix = `/_dsh/code-server/i/${created.id}`
  assert.ok(h.routeFor(prefix), 'the HTTP prefix route must be mounted')
  assert.equal(h.upgrades.filter((entry) => entry.path === prefix || entry.path === `${prefix}/`).length, 2)

  // A second session in the SAME workspace reuses the one instance.
  const second = res()
  await sessions.handler(req({
    method: 'POST',
    url: '/_dsh/code-server/sessions',
    body: JSON.stringify({ workspaceId: 'w-1' }),
  }), second)
  assert.equal(second.json().id, created.id)
  assert.equal(h.launched.length, 1)

  // A different workspace gets its own instance, but the SAME extensions dir.
  const third = res()
  await sessions.handler(req({
    method: 'POST',
    url: '/_dsh/code-server/sessions',
    body: JSON.stringify({ workspaceId: 'w-2', workspacePath: '/workspace/other' }),
  }), third)
  assert.equal(third.status, 200)
  assert.notEqual(third.json().id, created.id)
  assert.equal(third.json().cwd, '/workspace/other')
  await waitFor(() => h.launched.length === 2)
  assert.equal(h.launched.length, 2)
  const argv2 = h.launched[1].argv
  assert.equal(argv2.at(-1), '/workspace/other')
  assert.equal(argv2[argv2.indexOf('--extensions-dir') + 1], h.config.extensionsDir)
  // Settings stay per-workspace: only the extensions directory is shared.
  assert.notEqual(
    argv[argv.indexOf('--user-data-dir') + 1],
    argv2[argv2.indexOf('--user-data-dir') + 1],
  )

  const closed = res()
  await sessions.handler(req({
    method: 'DELETE',
    url: `/_dsh/code-server/sessions/${created.id}`,
  }), closed)
  assert.equal(closed.status, 200)
  assert.equal(h.routeFor(prefix), undefined, 'closing releases the HTTP prefix route')
  assert.equal(h.upgrades.filter((entry) => entry.path.startsWith(prefix)).length, 0)
})

test('mutations refuse a foreign Origin and /install requires confirmation', async (t) => {
  const h = makeHarness({ installed: false })
  t.after(h.cleanup)
  apply(h.ctx, h.config)

  const foreign = res()
  await h.routeFor('/_dsh/code-server/detect').handler(req({
    method: 'POST',
    url: '/_dsh/code-server/detect',
    headers: { host: '127.0.0.1:56789', origin: 'http://evil.example' },
  }), foreign)
  assert.equal(foreign.status, 403)

  const unconfirmed = res()
  await h.routeFor('/_dsh/code-server/install').handler(req({
    method: 'POST',
    url: '/_dsh/code-server/install',
    body: '{}',
  }), unconfirmed)
  assert.equal(unconfirmed.status, 400)
  assert.equal(h.launched.length, 0, 'nothing is spawned without confirm: true')
})

test('/install answers 202 at once and streams live output through /install/log', async (t) => {
  const h = makeHarness({ installed: false, installSucceeds: true })
  t.after(h.cleanup)
  apply(h.ctx, h.config)

  const started = res()
  await h.routeFor('/_dsh/code-server/install').handler(req({
    method: 'POST',
    url: '/_dsh/code-server/install',
    body: JSON.stringify({ confirm: true }),
  }), started)
  // 202, not 200: the process is started, the work is not finished. A panel
  // that awaited completion would sit on a blank screen for minutes.
  assert.equal(started.status, 202)
  assert.equal(started.json().started, true)

  // /state carries the job so a reconnecting panel can pick it up.
  const during = res()
  await h.routeFor('/_dsh/code-server/state').handler(req({ url: '/_dsh/code-server/state' }), during)
  assert.equal(during.json().install.running, true)
  assert.equal(during.json().installed, false)

  // The log route reports the running job and its command.
  const log = res()
  await h.routeFor('/_dsh/code-server/install/log').handler(req({ url: '/_dsh/code-server/install/log' }), log)
  assert.equal(log.status, 200)
  assert.equal(log.json().running, true)
  assert.equal(log.json().command, 'npm install -g code-server')
  assert.equal(typeof log.json().text, 'string')

  // Wait for the fake install to settle.
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const check = res()
    await h.routeFor('/_dsh/code-server/install/log').handler(req({ url: '/_dsh/code-server/install/log' }), check)
    if (check.json().running !== true) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const settled = res()
  await h.routeFor('/_dsh/code-server/install/log').handler(req({ url: '/_dsh/code-server/install/log' }), settled)
  assert.equal(settled.json().running, false)
  assert.equal(settled.json().phase, 'succeeded')
  assert.equal(settled.json().exitCode, 0)
  // The captured output is what the panel displays as the live log.
  assert.match(settled.json().text, /installed code-server/u)
})

test('a disposed session does not tear down the workspace editor', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)
  apply(h.ctx, h.config)
  const created = res()
  await h.routeFor('/_dsh/code-server/sessions').handler(req({
    method: 'POST',
    url: '/_dsh/code-server/sessions',
    body: JSON.stringify({ workspaceId: 'w-1' }),
  }), created)
  const id = created.json().id
  // Ownership is the Workspace's, so a session ending must not close an editor
  // its neighbours are still using. No session/disposed listener at all.
  assert.equal(h.listeners.get('session/disposed'), undefined)
  const list = res()
  await h.routeFor('/_dsh/code-server/sessions').handler(req({ url: '/_dsh/code-server/sessions' }), list)
  assert.equal(list.json().length, 1)
  assert.equal(list.json()[0].id, id)
  assert.ok(h.routeFor(`/_dsh/code-server/i/${id}`))
})

test('the instance prefix route proxies once the child is listening', async (t) => {
  const h = makeHarness()
  t.after(h.cleanup)
  apply(h.ctx, h.config)
  const created = res()
  await h.routeFor('/_dsh/code-server/sessions').handler(req({
    method: 'POST',
    url: '/_dsh/code-server/sessions',
    body: JSON.stringify({ workspaceId: 'w-1' }),
  }), created)
  const prefix = `/_dsh/code-server/i/${created.json().id}`
  const route = h.routeFor(prefix)
  assert.ok(route)

  // Wait for the registry's readiness probe to observe the loopback listener.
  const deadline = Date.now() + 2500
  while (Date.now() < deadline) {
    const state = res()
    await h.routeFor('/_dsh/code-server/state').handler(req({ url: '/_dsh/code-server/state' }), state)
    if (state.json().instances[0]?.state === 'ready') break
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  const check = res()
  await h.routeFor('/_dsh/code-server/state').handler(req({ url: '/_dsh/code-server/state' }), check)
  assert.equal(check.json().instances[0].state, 'ready')

  // The route handler is a real proxy; drive it with a readable req and a
  // writable res, and confirm the upstream saw the prefix stripped.
  const upstreamReq = fakeReq({ url: `${prefix}/`, headers: { host: '127.0.0.1:56789' } })
  const out = fakeRes()
  await route.handler(upstreamReq, out.res)
  await out.finished
  assert.equal(out.result().status, 200)
  assert.match(out.result().body, /^upstream \/$/u)
})

test('createInstanceRegistry releases its claimed port on close', async () => {
  let spawned = 0
  const registry = createInstanceRegistry({
    spawn: () => {
      spawned += 1
      return {
        done: new Promise(() => {}),
        collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } },
        terminate() {},
      }
    },
    resolveExecutable: async () => '/usr/bin/code-server',
    executable: 'code-server',
    stateDir: '/tmp/dsh-code-server-registry-test',
    portRange: [14900, 14900],
    startupTimeoutMs: 0,
    stopGraceMs: 0,
  })
  assert.throws(() => registry.create({ cwd: '/tmp' }), /workspaceId is required/u)
  const first = registry.create({ workspaceId: 'w-1', cwd: '/tmp' })
  assert.equal(first.state, 'starting', 'create answers before the child is up')
  assert.equal(first.workspaceId, 'w-1')
  await registry.get(first.id).ready
  assert.equal(registry.get(first.id).state, 'failed', 'a zero startup deadline is an honest failure')
  assert.throws(() => registry.create({ workspaceId: 'w-2', cwd: '/tmp' }), /no free port/u)
  await registry.close(first.id)
  const second = registry.create({ workspaceId: 'w-2', cwd: '/tmp' })
  assert.equal(second.port, 14900, 'the port is reusable after close')
  await registry.get(second.id).ready
  await registry.disposeAll()
  assert.equal(spawned, 2)
})

test('a dispose in flight never leaves a child spawned after unload', async () => {
  let spawned = 0
  const registry = createInstanceRegistry({
    spawn: () => {
      spawned += 1
      return {
        done: new Promise(() => {}),
        collected: { stdout: { readFrom: () => ({ text: '' }) }, stderr: { readFrom: () => ({ text: '' }) } },
        terminate() {},
      }
    },
    // Deliberate delay so disposeAll() lands while boot() is awaiting.
    resolveExecutable: () => new Promise((resolve) => setTimeout(() => resolve('/usr/bin/code-server'), 30)),
    executable: 'code-server',
    stateDir: '/tmp/dsh-code-server-race-test',
    portRange: [14920, 14920],
    startupTimeoutMs: 0,
    stopGraceMs: 0,
  })
  registry.create({ workspaceId: 'w-1', cwd: '/tmp' })
  await registry.disposeAll()
  // Let the in-flight resolveExecutable settle and boot() resume.
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(spawned, 0, 'a closed entry must not spawn a child after unload')
})

// ---------------------------------------------------------------------------
// Client half
// ---------------------------------------------------------------------------

const CLIENT_SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function loadClient(baseURI = 'http://127.0.0.1:56789/main/') {
  const result = {}
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ id, factory }) => {
          const React = { createElement: () => null, Fragment: 'Fragment', useState: () => [null, () => {}], useEffect: () => {}, useRef: () => ({}) }
          result.id = id
          result.module = factory((name) => (name === 'react' ? React : undefined))
        },
      },
    },
    document: { baseURI, head: { append() {} }, createElement: () => ({ style: {}, dataset: {}, remove() {} }) },
    URL,
    setInterval,
    clearInterval,
    console,
  }
  vm.runInNewContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' })
  return result
}

test('the Client module is self-registering and its dictionaries match', () => {
  const { id, module } = loadClient()
  assert.equal(id, '@yiln-dsh/dsh-code-server')
  assert.equal(module.name, 'code-server-client')
  assert.deepEqual([...module.inject].sort(), ['locale', 'sidebarRightTabs', 'slots'])
  const zh = Object.keys(module.__test.ZH_DICT).sort()
  const en = Object.keys(module.__test.EN_DICT).sort()
  assert.deepEqual(zh, en, 'Chinese and English dictionaries must carry the same keys')
  assert.ok(zh.includes('setup.install'))
  assert.ok(zh.includes('editor.start'))
  assert.ok(zh.includes('editor.autoStarting'))
  // The install log must be dismissible and re-openable; both keys are part
  // of the dictionary contract.
  assert.ok(zh.includes('setup.logHide'))
  assert.ok(zh.includes('setup.logShow'))
  assert.ok(zh.includes('editor.noWorkspace'))
  assert.ok(zh.includes('editor.retry'))
})

test('Client URLs resolve against document.baseURI and open the workspace folder', () => {
  const { module } = loadClient('http://127.0.0.1:56789/env-6-13/')
  const x = module.__test
  assert.equal(x.STATE_PATH(), 'http://127.0.0.1:56789/env-6-13/_dsh/code-server/state')
  assert.equal(x.SESSIONS_PATH(), 'http://127.0.0.1:56789/env-6-13/_dsh/code-server/sessions')
  assert.equal(x.sessionPath('cs-1'), 'http://127.0.0.1:56789/env-6-13/_dsh/code-server/sessions/cs-1')
  assert.equal(x.instanceUrl({ url: '_dsh/code-server/i/cs-1/' }), 'http://127.0.0.1:56789/env-6-13/_dsh/code-server/i/cs-1/')
  // `?folder=` is code-server's URL API and takes precedence over its
  // last-opened behaviour, so every shared tab opens the same workspace.
  const withFolder = new URL(x.instanceUrl({
    url: '_dsh/code-server/i/cs-1/',
    workspacePath: '/workspace/project',
  }))
  assert.equal(withFolder.pathname, '/env-6-13/_dsh/code-server/i/cs-1/')
  assert.equal(withFolder.searchParams.get('folder'), '/workspace/project')
})

test('Client helpers parse rows defensively and select this workspace instance', () => {
  const { module } = loadClient()
  const x = module.__test
  const rows = x.parseInstances([
    { id: 'cs-1', state: 'ready', workspaceId: 'w-1' },
    { id: 'cs-2', state: 'bogus', workspaceId: 'w-2' },
    null,
    { state: 'ready' },
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[1].state, 'unknown')
  assert.equal(x.instanceFor(rows, 'w-2').id, 'cs-2')
  assert.equal(x.instanceFor(rows, 'w-9'), null)
  assert.equal(x.instanceFor(rows, ''), null, 'no workspace means no instance')
  assert.equal(x.parseInstances(null).length, 0)
  assert.equal(x.stateKeyFor('ready'), 'state.ready')
  assert.equal(x.applyParams('a {x} b', { x: 1 }), 'a 1 b')
  assert.equal(x.errorMessage(new Error('boom')), 'boom')
})

test('Client resolves the current Workspace from useWorkspaces items', () => {
  const { module } = loadClient()
  const x = module.__test
  const items = [
    { workspaceId: 'w-1', path: '/workspace/a', title: 'A', sessionIds: ['s-1', 's-2'] },
    { workspaceId: 'w-2', path: '/workspace/b', title: 'B', sessionIds: [] },
  ]
  const bySession = x.findWorkspace(items, 's-2', '/workspace/elsewhere')
  assert.equal(bySession.workspaceId, 'w-1')
  assert.equal(bySession.path, '/workspace/a')
  assert.equal(bySession.title, 'A')
  // A session not yet attached to its Workspace still resolves by canonical cwd.
  assert.equal(x.findWorkspace(items, 's-9', '/workspace/b').workspaceId, 'w-2')
  assert.equal(x.findWorkspace(items, 's-9', '/workspace/missing'), null)
  assert.equal(x.findWorkspace(null, 's-1', ''), null)
  assert.equal(x.findWorkspace([{ workspaceId: '', path: '/x' }], 's-1', ''), null)
  assert.equal(x.findWorkspace([{ workspaceId: 'w-3' }], 's-1', ''), null, 'a path is required')
})

test('the workspace empty fallback is one shared reference', () => {
  const { module } = loadClient()
  // Regression: `snapshot?.items ?? []` allocated a new array inside the
  // selector on every render. The hook compares snapshots by reference, so it
  // saw a change every time, re-rendered forever, and threw out of the whole
  // tab body — which is why the pane rendered blank with no toolbar.
  const first = module.__test.EMPTY_WORKSPACES
  const second = module.__test.EMPTY_WORKSPACES
  assert.equal(first, second, 'the fallback must not be re-allocated')
  assert.ok(Array.isArray(first))
  assert.equal(first.length, 0)
})

test('apply() registers the guarded body instead of the raw shell', () => {
  const { module } = loadClient()
  // A body that throws is dropped by the renderer and the pane goes blank, so
  // the registered component must be the boundary, not `createShell` itself.
  assert.equal(typeof module.__test.createShell, 'function')
  assert.equal(typeof module.__test.createGuardedShell, 'function')
  const t = (key) => module.__test.ZH_DICT[key] ?? key
  assert.equal(typeof module.__test.createGuardedShell(t), 'function')
})

test('the tab definition is a localized right-sidebar extension', () => {
  const { module } = loadClient()
  const t = (key) => module.__test.ZH_DICT[key] ?? key
  const tab = module.__test.createTabDefinition(t)
  assert.equal(tab.id, module.__test.TAB_ID)
  assert.equal(tab.kind, module.__test.TAB_KIND)
  assert.equal(tab.priority, 'extension')
  assert.equal(tab.title(), '代码编辑器')
  assert.equal(tab.guide[0].description(), t('guide.description'))
  assert.equal(typeof tab.guide[0].icon, 'function')
})
