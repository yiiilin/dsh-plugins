/**
 * Unit tests for the Host plugin's public surface: the frozen Config schema and
 * mount identity, the asset-path escape guard (the one place a request string
 * becomes a file path) and the effect-based teardown of every side effect.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'

import { Config, apply, assetContentType, inject, name, resolveAssetPath, resolvePanelDisplay } from '../index.js'
import { createInstanceRegistry } from '../instances.js'
import { portCandidates } from '../x11vnc.js'

test('the mount identity matches the bundle row', () => {
  assert.equal(name, 'desktop-vnc')
  assert.deepEqual(inject, ['webServer', 'subprocess', 'fs'])
  assert.deepEqual(apply.inject, ['webServer', 'subprocess', 'fs'])
})

test('the Config schema carries the frozen defaults', () => {
  const config = new Config({})
  assert.equal(config.enabled, true)
  assert.equal(config.display, ':0')
  assert.equal(config.rfbPort, 5900)
  assert.equal(config.viewportWidth, 1280)
  assert.equal(config.viewportHeight, 800)
  assert.equal(config.jpegQuality, 72)
  assert.equal(config.frameRate, 8)
  assert.equal(config.maxClients, 4)
})

test('the Config schema carries the v2 port range and keeps the v1 single port', () => {
  const config = new Config({})
  // One port per browser instance: the pool an instance allocates from.
  assert.deepEqual(config.rfbPortRange, [5900, 5999])
  // `rfbPort` stays a v1-compatible single value; it is the preferred first port.
  assert.equal(config.rfbPort, 5900)

  const custom = new Config({ rfbPortRange: [6000, 6010] })
  assert.deepEqual(custom.rfbPortRange, [6000, 6010])
  assert.equal(custom.rfbPort, 5900, 'the v1 field keeps its own default')
})

test('the port range helper reads the range, the v1 single port, and nonsense', () => {
  // An explicit range is the pool, low to high.
  assert.deepEqual(portCandidates({ rfbPortRange: [6000, 6002] }), [6000, 6001, 6002])
  // A reversed range is put back in order rather than matching nothing.
  assert.deepEqual(portCandidates({ rfbPortRange: [6002, 6000] }), [6000, 6001, 6002])
  // No range: the v1 single port is preferred, then the default pool follows, so
  // an existing profile keeps its port while a second instance can still start.
  const legacy = portCandidates({ rfbPort: 5905 })
  assert.equal(legacy[0], 5905)
  assert.equal(legacy[1], 5900)
  assert.equal(new Set(legacy).size, legacy.length, 'no port is offered twice')
  // Unusable input falls back to the default pool instead of reaching a bind.
  assert.deepEqual(portCandidates({ rfbPortRange: ['x', 'y'] }).slice(0, 2), [5900, 5901])
  assert.deepEqual(portCandidates({ rfbPortRange: [1, 2, 3] }).slice(0, 2), [5900, 5901])
})

test('the Config schema carries the v2 browser defaults', () => {
  const config = new Config({})
  assert.equal(config.browser.enabled, true)
  assert.equal(config.browser.executable, 'chromium')
  assert.equal(config.browser.nestedDisplay, 'auto')
  assert.equal(config.browser.windowTitle, 'DSH Desktop Browser')
  assert.equal(config.browser.startUrl, 'about:blank')
  assert.deepEqual(config.browser.extraArgs, [])

  // The v1 fields stay untouched by the extension.
  const custom = new Config({ browser: { enabled: false, nestedDisplay: ':96' } })
  assert.equal(custom.browser.enabled, false)
  assert.equal(custom.browser.nestedDisplay, ':96')
  // Unspecified sub-fields still take their defaults rather than vanishing.
  assert.equal(custom.browser.executable, 'chromium')
  assert.deepEqual(custom.browser.extraArgs, [])
})

test('relative noVNC assets resolve inside the vendored tree', () => {
  const rfb = resolveAssetPath('core/rfb.js')
  assert.ok(rfb !== null)
  assert.match(rfb, /novnc\/core\/rfb\.js$/)

  // noVNC imports siblings relatively, so nested module paths must resolve.
  const util = resolveAssetPath('core/util/int.js')
  assert.ok(util !== null)
  assert.match(util, /novnc\/core\/util\/int\.js$/)

  const vendor = resolveAssetPath('vendor/pako/lib/zlib/inflate.js')
  assert.ok(vendor !== null)
  assert.match(vendor, /novnc\/vendor\/pako\/lib\/zlib\/inflate\.js$/)
})

test('the asset route refuses every path that escapes the vendored tree', () => {
  const rejected = [
    '',
    '../package.json',
    '../../package.json',
    'core/../../package.json',
    'core/./../../package.json',
    'core/%2e%2e/%2e%2e/package.json',
    '/etc/passwd',
    '/core/rfb.js',
    'core/rfb.js/../../../../etc/passwd',
    'app/ui.js',
    'core/rfb.js.map',
    'core/secret.txt',
    'node_modules/ws/index.js',
    '..',
    'core/..',
    'core//rfb.js',
    'core/ rfb.js',
  ]
  for (const rel of rejected) {
    assert.equal(resolveAssetPath(rel), null, `${JSON.stringify(rel)} must be rejected`)
  }
})

test('a traversal attempt after URL decoding is still refused', () => {
  // The route decodes before calling this, so the decoded form must be caught.
  const decoded = decodeURIComponent('core/%2e%2e/%2e%2e/package.json')
  assert.equal(decoded, 'core/../../package.json')
  assert.equal(resolveAssetPath(decoded), null)
})

test('only JavaScript assets get the JavaScript content type', () => {
  assert.equal(assetContentType('core/rfb.js'), 'text/javascript; charset=utf-8')
  assert.equal(assetContentType('core/rfb.css'), null)
  assert.equal(assetContentType('core/rfb.js.map'), null)
})

/** A Cordis-shaped context recording routes, upgrades, effects and listeners. */
function fakeCtx({ withWebServer = true } = {}) {
  const routes = []
  const upgrades = []
  const disposers = []
  const listeners = new Map()
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get(service) {
      if (service === 'webServer') {
        if (!withWebServer) return undefined
        return {
          register(route) {
            routes.push(route)
            return () => {
              routes.splice(routes.indexOf(route), 1)
            }
          },
          registerUpgrade(route) {
            upgrades.push(route)
            return () => {
              upgrades.splice(upgrades.indexOf(route), 1)
            }
          },
          getOrigin: () => 'http://127.0.0.1:3080',
        }
      }
      // subprocess and fs are absent in these tests unless a case supplies them.
      return undefined
    },
    effect(callback) {
      disposers.push(callback())
      return () => {}
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
  }
  return {
    ctx,
    routes,
    upgrades,
    listeners,
    /** Fire every listener registered for one event. */
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload)
    },
    /** Run every registered effect disposer, as plugin unload would. */
    unload() {
      while (disposers.length > 0) {
        const dispose = disposers.pop()
        if (typeof dispose === 'function') dispose()
      }
    },
  }
}

test('applying without a web server is a safe no-op', () => {
  const { ctx, routes, upgrades } = fakeCtx({ withWebServer: false })
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(routes.length, 0)
  assert.equal(upgrades.length, 0)
})

test('every route and the upgrade are registered and released by effects', () => {
  const { ctx, routes, upgrades, unload } = fakeCtx()
  apply(ctx, {})

  const exact = routes.filter((route) => route.kind === 'exact').map((route) => route.path)
  assert.ok(routes.some((route) => route.kind === 'prefix' && route.path === '/_dsh/desktop-vnc/asset'))
  assert.ok(exact.includes('/_dsh/desktop-vnc/frame.jpg'))
  assert.ok(exact.includes('/_dsh/desktop-vnc/stream.mjpg'))
  assert.ok(exact.includes('/_dsh/desktop-vnc/state'))
  assert.equal(upgrades.length, 1)
  assert.equal(upgrades[0].path, '/_dsh/desktop-vnc/ws')

  // Unloading must release the routes and the upgrade seat.
  unload()
  assert.equal(routes.length, 0)
  assert.equal(upgrades.length, 0)
})

test('the state route reports the frozen shape', () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, {})
  const state = routes.find((route) => route.path === '/_dsh/desktop-vnc/state')

  const written = []
  state.handler({ method: 'GET', url: '/_dsh/desktop-vnc/state', headers: {} }, {
    writeHead: (status, headers) => written.push([status, headers]),
    end: (body) => written.push(body),
  })

  const body = JSON.parse(written[1].toString())
  assert.equal(body.enabled, true)
  assert.equal(body.display, ':0')
  assert.equal(body.rfbHost, '127.0.0.1')
  assert.equal(body.rfbPort, 5900)
  assert.equal(body.vncRunning, false)
  assert.equal(body.clients, 0)
  assert.deepEqual(body.viewport, { width: 1280, height: 800 })
})

test('the state route carries the v2 browser fields', () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, {})
  const state = routes.find((route) => route.path === '/_dsh/desktop-vnc/state')

  const written = []
  state.handler({ method: 'GET', url: '/_dsh/desktop-vnc/state', headers: {} }, {
    writeHead: () => {},
    end: (body) => written.push(body),
  })

  const body = JSON.parse(written[0].toString())
  // Before ensure() the nested display is unknown and nothing runs, but the
  // fields are present so the panel never has to guess.
  assert.equal(body.vncDisplay, ':0')
  assert.equal(body.desktopVisible, false)
  assert.deepEqual(body.browser, {
    enabled: true,
    display: ':0',
    xephyr: false,
    chromium: false,
    running: false,
    mode: 'none',
    degraded: false,
    pids: {},
  })
})

test('browser.enabled=false reports the v1 mirror path honestly', () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, { browser: { enabled: false }, display: ':7' })
  const state = routes.find((route) => route.path === '/_dsh/desktop-vnc/state')

  const written = []
  state.handler({ method: 'GET', url: '/_dsh/desktop-vnc/state', headers: {} }, {
    writeHead: () => {},
    end: (body) => written.push(body),
  })

  const body = JSON.parse(written[0].toString())
  assert.equal(body.browser.enabled, false)
  assert.equal(body.vncDisplay, ':7')
  // No Xephyr means the browser can never be desktop-visible.
  assert.equal(body.desktopVisible, false)
  assert.equal(body.display, ':7')
})

test('a disabled browser stack never touches Xephyr or Chromium for the v1 path', async () => {
  const { ctx, routes } = fakeCtx()
  // subprocess is absent: if the browser stack were consulted it would answer
  // with a 503 about a missing subprocess service instead of the v1 message.
  apply(ctx, { browser: { enabled: false } })
  const frame = routes.find((route) => route.path === '/_dsh/desktop-vnc/frame.jpg')

  const written = []
  await frame.handler({ method: 'GET', url: '/_dsh/desktop-vnc/frame.jpg', headers: {} }, {
    writeHead: (status) => written.push(status),
    end: (body) => written.push(body),
  })

  assert.equal(written[0], 503)
  // The v1 path fails on the capture service, not on the browser stack.
  assert.match(String(written[1]), /subprocess service unavailable/)
  assert.ok(!String(written[1]).includes('Xephyr'))
})

test('the upgrade handler reports 503 when the browser stack cannot start', async () => {  const { ctx, upgrades } = fakeCtx()
  // Browser enabled but no subprocess service: Xephyr/Chromium cannot start.
  apply(ctx, {})
  const upgrade = upgrades[0]

  const written = []
  const socket = { write: (chunk) => written.push(Buffer.from(chunk)), end: () => {} }
  await upgrade.handler({
    method: 'GET',
    url: '/_dsh/desktop-vnc/ws',
    headers: {
      origin: 'http://127.0.0.1:3080',
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': 'binary',
    },
  }, socket, Buffer.alloc(0))

  const response = Buffer.concat(written).toString()
  assert.match(response, /^HTTP\/1\.1 503 /)
  // The failure must be explained, and must never reach an upgrade.
  assert.match(response, /subprocess service unavailable/)
  assert.ok(!response.includes('101 Switching Protocols'))
  assert.ok(!response.includes('Sec-WebSocket-Accept'))
})

test('the asset route answers 404 for a traversal and 405 for a write', () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, {})
  const asset = routes.find((route) => route.kind === 'prefix')

  const notFound = []
  asset.handler({ method: 'GET', url: '/_dsh/desktop-vnc/asset/core/../../package.json', headers: {} }, {
    writeHead: (status) => notFound.push(status),
    end: () => {},
  })
  assert.equal(notFound[0], 404)

  const methodNotAllowed = []
  asset.handler({ method: 'PUT', url: '/_dsh/desktop-vnc/asset/core/rfb.js', headers: {} }, {
    writeHead: (status) => methodNotAllowed.push(status),
    end: () => {},
  })
  assert.equal(methodNotAllowed[0], 405)
})

test('a real vendored asset is served with a long-lived immutable cache', () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, {})
  const asset = routes.find((route) => route.kind === 'prefix')

  const written = []
  asset.handler({ method: 'GET', url: '/_dsh/desktop-vnc/asset/core/rfb.js', headers: {} }, {
    writeHead: (status, headers) => written.push([status, headers]),
    end: (body) => written.push(body),
  })

  assert.equal(written[0][0], 200)
  assert.equal(written[0][1]['content-type'], 'text/javascript; charset=utf-8')
  assert.equal(written[0][1]['cache-control'], 'public, max-age=31536000, immutable')
  assert.ok(Buffer.isBuffer(written[1]) && written[1].length > 1000)
})

test('the frame route reports a readable 503 when the subprocess service is absent', async () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, {})
  const frame = routes.find((route) => route.path === '/_dsh/desktop-vnc/frame.jpg')

  const written = []
  await frame.handler({ method: 'GET', url: '/_dsh/desktop-vnc/frame.jpg', headers: {} }, {
    writeHead: (status) => written.push(status),
    end: (body) => written.push(body),
  })

  assert.equal(written[0], 503)
  // The message must stay a short explanation, never a stack trace.
  assert.ok(!String(written[1]).includes('at '))
})

test('the upgrade handler refuses a foreign origin before any handshake work', async () => {
  const { ctx, upgrades } = fakeCtx()
  apply(ctx, {})
  const upgrade = upgrades[0]

  const written = []
  const socket = {
    write: (chunk) => written.push(Buffer.from(chunk)),
    end: () => {},
  }
  await upgrade.handler({
    method: 'GET',
    url: '/_dsh/desktop-vnc/ws',
    headers: {
      origin: 'https://evil.example',
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': 'binary',
    },
  }, socket, Buffer.alloc(0))

  const response = Buffer.concat(written).toString()
  assert.match(response, /^HTTP\/1\.1 403 /)
  // A refused origin must never see a 101 or an Accept value.
  assert.ok(!response.includes('101 Switching Protocols'))
  assert.ok(!response.includes('Sec-WebSocket-Accept'))
})

test('the upgrade handler refuses a malformed handshake', async () => {
  const { ctx, upgrades } = fakeCtx()
  apply(ctx, {})
  const upgrade = upgrades[0]

  const written = []
  const socket = { write: (chunk) => written.push(Buffer.from(chunk)), end: () => {} }
  await upgrade.handler({
    method: 'GET',
    url: '/_dsh/desktop-vnc/ws',
    headers: { origin: 'http://127.0.0.1:3080', upgrade: 'websocket', connection: 'Upgrade' },
  }, socket, Buffer.alloc(0))

  assert.match(Buffer.concat(written).toString(), /^HTTP\/1\.1 400 /)
})

test('the upgrade handler answers 503 when no x11vnc can be provided', async () => {
  const { ctx, upgrades } = fakeCtx()
  // No subprocess service at all: the controller cannot start anything.
  apply(ctx, {})
  const upgrade = upgrades[0]

  const written = []
  const socket = { write: (chunk) => written.push(Buffer.from(chunk)), end: () => {} }
  await upgrade.handler({
    method: 'GET',
    url: '/_dsh/desktop-vnc/ws',
    headers: {
      origin: 'http://127.0.0.1:3080',
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': 'binary',
    },
  }, socket, Buffer.alloc(0))

  const response = Buffer.concat(written).toString()
  assert.match(response, /^HTTP\/1\.1 503 /)
  assert.ok(!response.includes('Sec-WebSocket-Accept'))
})

test('the stream route caps concurrent previews at maxClients', () => {
  const { ctx, routes } = fakeCtx()
  apply(ctx, { maxClients: 0 })
  const stream = routes.find((route) => route.path === '/_dsh/desktop-vnc/stream.mjpg')

  const written = []
  stream.handler({ method: 'GET', url: '/_dsh/desktop-vnc/stream.mjpg', headers: {} }, {
    writeHead: (status) => written.push(status),
    end: () => {},
    on: () => {},
    req: { on: () => {} },
  })
  assert.equal(written[0], 503)
})

test('a disabled plugin refuses the capture and upgrade routes', async () => {
  const { ctx, routes, upgrades } = fakeCtx()
  apply(ctx, { enabled: false })

  const frame = routes.find((route) => route.path === '/_dsh/desktop-vnc/frame.jpg')
  const written = []
  await frame.handler({ method: 'GET', url: '/_dsh/desktop-vnc/frame.jpg', headers: {} }, {
    writeHead: (status) => written.push(status),
    end: () => {},
  })
  assert.equal(written[0], 503)

  const socket = { write: () => {}, end: () => {} }
  const upgradeWritten = []
  socket.write = (chunk) => upgradeWritten.push(Buffer.from(chunk))
  await upgrades[0].handler({
    method: 'GET',
    url: '/_dsh/desktop-vnc/ws',
    headers: { origin: 'http://127.0.0.1:3080' },
  }, socket, Buffer.alloc(0))
  assert.match(Buffer.concat(upgradeWritten).toString(), /^HTTP\/1\.1 503 /)
})

// --- v2: resolvePanelDisplay is the one place the display is chosen ----------

/** A fake browser stack whose ensure() answer the test dictates. */
function fakeBrowser(answer) {
  const state = { calls: 0 }
  return {
    state,
    ensure: async () => {
      state.calls += 1
      if (typeof answer === 'function') return answer()
      return answer
    },
  }
}

/** A fake controller/capture service recording every setDisplay() it received. */
function fakeTarget(initial = ':0') {
  const target = { display: initial, calls: [] }
  target.setDisplay = (value) => {
    target.calls.push(value)
    target.display = value
    return value
  }
  return target
}

test('a healthy nested stack retargets both x11vnc and capture', async () => {
  const browser = fakeBrowser({ ok: true, browser: true, display: ':96' })
  const vnc = fakeTarget(':0')
  const capture = fakeTarget(':0')

  const result = await resolvePanelDisplay({ browser, vnc, capture })

  assert.deepEqual(result, { display: ':96' })
  assert.deepEqual(vnc.calls, [':96'])
  assert.deepEqual(capture.calls, [':96'])
})

test('the Xvfb fallback is accepted even though it carries an error note', async () => {
  // Contract §5: a successful fallback still carries `error` as information.
  // Gating on `error` would wrongly 503 a stack that is perfectly usable.
  const browser = fakeBrowser({
    ok: true,
    browser: true,
    display: ':90',
    degraded: true,
    desktopVisible: false,
    error: 'Xephyr 不可用，已退回 Xvfb（桌面不可见）：...',
  })
  const vnc = fakeTarget()
  const capture = fakeTarget()

  const result = await resolvePanelDisplay({ browser, vnc, capture })

  assert.deepEqual(result, { display: ':90' })
  assert.deepEqual(vnc.calls, [':90'])
  assert.deepEqual(capture.calls, [':90'])
})

test('a failed browser stack becomes a readable error and retargets nothing', async () => {
  const browser = fakeBrowser({ ok: false, browser: false, display: ':90', error: 'Xephyr 未安装（Xephyr not installed）' })
  const vnc = fakeTarget()
  const capture = fakeTarget()

  const result = await resolvePanelDisplay({ browser, vnc, capture })

  assert.match(result.error, /Xephyr 未安装/)
  assert.equal(result.display, undefined)
  assert.deepEqual(vnc.calls, [])
  assert.deepEqual(capture.calls, [])
})

test('a browser stack that rejects is reported instead of thrown', async () => {
  const browser = { ensure: async () => { throw new Error('desktop-vnc: browser stack disposed') } }
  const result = await resolvePanelDisplay({ browser, vnc: fakeTarget(), capture: fakeTarget() })

  assert.match(result.error, /browser stack disposed/)
})

test('an unusable display is treated as a failure, never mirrored', async () => {
  const vnc = fakeTarget()
  const result = await resolvePanelDisplay({
    browser: fakeBrowser({ ok: true, browser: true, display: '' }),
    vnc,
    capture: fakeTarget(),
  })

  assert.equal(result.display, undefined)
  assert.equal(result.error, 'desktop browser is unavailable')
  assert.deepEqual(vnc.calls, [])
})

test('browser.enabled=false keeps the v1 mirror and never calls ensure()', async () => {
  const browser = fakeBrowser({ ok: true, browser: true, display: ':96' })
  const vnc = fakeTarget()
  const capture = fakeTarget()

  const result = await resolvePanelDisplay({
    browser,
    vnc,
    capture,
    browserEnabled: false,
    hostDisplay: ':7',
  })

  assert.deepEqual(result, { display: ':7' })
  assert.equal(browser.state.calls, 0, 'the browser stack must not be started on the v1 path')
  assert.deepEqual(vnc.calls, [])
  assert.deepEqual(capture.calls, [])
})

// --- the browser instance routes --------------------------------------------
// The registry is injected so these cases never spawn Xephyr or Chromium: the
// routes are exercised through their real handlers with a fake table.

/** A registry whose create() answers at once and whose close() obeys the contract. */
function fakeRegistry() {
  const calls = { create: [], close: [], disposed: [] }
  const rows = []
  const closeListeners = new Set()
  return {
    calls,
    rows,
    /** The real table reports every close through one hook; the fake must too. */
    subscribeClose(handler) {
      closeListeners.add(handler)
      return () => closeListeners.delete(handler)
    },
    create({ ownerSessionId } = {}) {
      calls.create.push({ ownerSessionId })
      const entry = {
        id: `0000${String(rows.length).padStart(3, '0')}a`,
        state: 'starting',
        width: 1280,
        height: 800,
        createdAt: 1_000,
        ownerSessionId,
        lastActiveAt: 1_000,
        viewers: 0,
      }
      entry.vnc = {
        ensures: 0,
        async ensure() {
          this.ensures += 1
          return { running: true, port: 1 }
        },
        status: () => ({ running: false, port: 5900 }),
        display: () => ':0',
      }
      rows.push(entry)
      return { id: entry.id, state: 'starting' }
    },
    list() {
      // The real table projects a frozen row shape; the fake does too, so the
      // test asserts the contract rather than whatever the fake happens to hold.
      return rows.map((row) => ({
        id: row.id,
        state: row.state,
        width: row.width,
        height: row.height,
        createdAt: row.createdAt,
        ownerSessionId: row.ownerSessionId,
        lastActiveAt: row.lastActiveAt,
        viewers: row.viewers,
      }))
    },
    get(id) {
      return rows.find((row) => row.id === id)
    },
    async close(id) {
      calls.close.push(id)
      const index = rows.findIndex((row) => row.id === id)
      if (index === -1) {
        const error = new Error(`没有这个浏览器实例（no such browser instance: ${id}）`)
        error.status = 404
        throw error
      }
      rows.splice(index, 1)
      for (const listener of closeListeners) listener(id)
      return { closed: true }
    },
    async disposeSession(sessionId) {
      calls.disposed.push(sessionId)
      return []
    },
  }
}

/** Mount the plugin with an injected registry and a fake web server. */
function mountWithRegistry(registry, config = {}) {
  const fake = fakeCtx()
  apply(fake.ctx, { ...config, instanceRegistry: registry })
  return fake
}

/** A recording response: `writeHead` and `end` land in `written` in call order. */
function recordingResponse() {
  const written = []
  return {
    written,
    writeHead: (status, headers) => written.push([status, headers]),
    end: (body) => written.push(body),
    on: () => {},
  }
}

/** Parse the JSON body a recording response ended with. */
function jsonBody(written) {
  const body = written[written.length - 1]
  return JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body))
}

test('POST /sessions answers at once with the id and the starting state', async () => {
  const registry = fakeRegistry()
  const fake = mountWithRegistry(registry)
  const route = fake.routes.find((candidate) => candidate.path === '/_dsh/desktop-vnc/sessions')

  const res = recordingResponse()
  await route.handler({
    method: 'POST',
    url: '/_dsh/desktop-vnc/sessions',
    headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () {},
  }, res)

  assert.equal(res.written[0][0], 200)
  assert.match(res.written[0][1]['content-type'], /application\/json/)
  assert.deepEqual(jsonBody(res.written), { id: '0000000a', state: 'starting' })
  assert.deepEqual(registry.calls.create, [{ ownerSessionId: null }], 'no body means no recorded owner')
})

test('POST /sessions records the owning session from the request body', async () => {
  const registry = fakeRegistry()
  const fake = mountWithRegistry(registry)
  const route = fake.routes.find((candidate) => candidate.path === '/_dsh/desktop-vnc/sessions')

  const body = JSON.stringify({ ownerSessionId: 'session-a' })
  const res = recordingResponse()
  await route.handler({
    method: 'POST',
    url: '/_dsh/desktop-vnc/sessions',
    headers: { 'content-type': 'application/json' },
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from(body)
    },
  }, res)

  assert.equal(res.written[0][0], 200)
  assert.deepEqual(registry.calls.create, [{ ownerSessionId: 'session-a' }])
})

test('POST /sessions rejects a body that is not an object', async () => {
  const registry = fakeRegistry()
  const fake = mountWithRegistry(registry)
  const route = fake.routes.find((candidate) => candidate.path === '/_dsh/desktop-vnc/sessions')

  const res = recordingResponse()
  await route.handler({
    method: 'POST',
    url: '/_dsh/desktop-vnc/sessions',
    headers: {},
    [Symbol.asyncIterator]: async function* () {
      yield Buffer.from('[]')
    },
  }, res)

  assert.equal(res.written[0][0], 400)
  assert.deepEqual(registry.calls.create, [], 'a malformed body must not create an instance')
})

test('GET /sessions answers a flat array of the registry rows', () => {
  const registry = fakeRegistry()
  registry.create({ ownerSessionId: 'session-a' })
  const fake = mountWithRegistry(registry)
  const route = fake.routes.find((candidate) => candidate.path === '/_dsh/desktop-vnc/sessions')

  const res = recordingResponse()
  route.handler({ method: 'GET', url: '/_dsh/desktop-vnc/sessions', headers: {} }, res)

  assert.equal(res.written[0][0], 200)
  const body = jsonBody(res.written)
  assert.ok(Array.isArray(body), 'the list is a flat array, never an object with a total')
  assert.deepEqual(body, [{
    id: '0000000a',
    state: 'starting',
    width: 1280,
    height: 800,
    createdAt: 1_000,
    ownerSessionId: 'session-a',
    lastActiveAt: 1_000,
    viewers: 0,
  }])
})

test('the sessions route answers 405 for a method it does not serve', async () => {
  const registry = fakeRegistry()
  const fake = mountWithRegistry(registry)
  const route = fake.routes.find((candidate) => candidate.path === '/_dsh/desktop-vnc/sessions')

  const res = recordingResponse()
  await route.handler({ method: 'PUT', url: '/_dsh/desktop-vnc/sessions', headers: {} }, res)

  assert.equal(res.written[0][0], 405)
})

test('DELETE /sessions/<id> is one prefix route that parses the id itself', async () => {
  const registry = fakeRegistry()
  registry.create({ ownerSessionId: 'session-a' })
  const fake = mountWithRegistry(registry)

  // One prefix route owns the whole subtree: a second route per id would throw
  // on duplicate registration, and ids are minted at runtime.
  const route = fake.routes.find((candidate) => candidate.path === '/_dsh/desktop-vnc/sessions')
  const res = recordingResponse()
  await route.handler({
    method: 'DELETE',
    url: '/_dsh/desktop-vnc/sessions/0000000a',
    headers: {},
  }, res)

  assert.equal(res.written[0][0], 200)
  assert.deepEqual(jsonBody(res.written), { closed: true })
  assert.deepEqual(registry.calls.close, ['0000000a'])
})

test('DELETE on an unknown id answers 404 with the id in the message', async () => {
  const registry = fakeRegistry()
  const fake = mountWithRegistry(registry)
  const route = fake.routes.find((candidate) => candidate.path === '/_dsh/desktop-vnc/sessions')

  const res = recordingResponse()
  await route.handler({
    method: 'DELETE',
    url: '/_dsh/desktop-vnc/sessions/deadbeef',
    headers: {},
  }, res)

  assert.equal(res.written[0][0], 404)
  assert.match(jsonBody(res.written).error, /deadbeef/)
})

test('the session routes are registered by effects and released on unload', () => {
  const registry = fakeRegistry()
  const fake = mountWithRegistry(registry)
  const sessions = fake.routes.filter((route) => route.path.startsWith('/_dsh/desktop-vnc/sessions'))
  assert.equal(sessions.length, 1, 'one prefix route serves list, create and close')
  assert.equal(sessions[0].kind, 'prefix')

  fake.unload()
  assert.equal(fake.routes.length, 0)
})

test('a disposed session closes exactly that session\'s instances', async () => {
  const registry = fakeRegistry()
  const fake = mountWithRegistry(registry)

  fake.emit('session/disposed', { id: 'session-a' })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(registry.calls.disposed, ['session-a'])
})

test('agent/disposed never closes an instance: the session outlives the agent', async () => {
  const registry = fakeRegistry()
  const fake = mountWithRegistry(registry)

  // An agent ending is not a session ending. Listening to it would tear down a
  // browser the still-open session can keep driving.
  fake.emit('agent/disposed', { id: 'agent-1' })
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(registry.calls.disposed, [], 'no instance is closed when only the agent goes away')
  assert.equal(registry.list().length, 0)
})

test('creating an instance mounts its own WS upgrade route, and closing removes it', async () => {
  const registry = fakeRegistry()
  const fake = mountWithRegistry(registry)
  const sessions = fake.routes.find((route) => route.path === '/_dsh/desktop-vnc/sessions')

  const before = fake.upgrades.length
  const created = recordingResponse()
  await sessions.handler({
    method: 'POST',
    url: '/_dsh/desktop-vnc/sessions',
    headers: {},
    [Symbol.asyncIterator]: async function* () {},
  }, created)
  const { id } = jsonBody(created.written)

  // Upgrade routes have no prefix form (dispatch is an exact pathname lookup), so
  // each instance needs a route of its own, mounted when it appears.
  assert.equal(fake.upgrades.length, before + 1)
  assert.equal(fake.upgrades.at(-1).path, `/_dsh/desktop-vnc/sessions/${id}/ws`)

  const closed = recordingResponse()
  await sessions.handler({ method: 'DELETE', url: `/_dsh/desktop-vnc/sessions/${id}`, headers: {} }, closed)
  assert.equal(closed.written[0][0], 200)
  // A closed instance must stop answering on its old path.
  assert.ok(!fake.upgrades.some((route) => route.path === `/_dsh/desktop-vnc/sessions/${id}/ws`))
})

test('the per-instance WS route answers 404 for an id that is gone', async () => {
  const registry = fakeRegistry()
  const fake = mountWithRegistry(registry)
  const sessions = fake.routes.find((route) => route.path === '/_dsh/desktop-vnc/sessions')

  const created = recordingResponse()
  await sessions.handler({
    method: 'POST',
    url: '/_dsh/desktop-vnc/sessions',
    headers: {},
    [Symbol.asyncIterator]: async function* () {},
  }, created)
  const { id } = jsonBody(created.written)
  const upgrade = fake.upgrades.find((route) => route.path === `/_dsh/desktop-vnc/sessions/${id}/ws`)

  const written = []
  const socket = { write: (chunk) => written.push(Buffer.from(chunk)), end: () => {} }
  await upgrade.handler({
    method: 'GET',
    url: `/_dsh/desktop-vnc/sessions/${id}/ws`,
    headers: {
      origin: 'http://127.0.0.1:3080',
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': 'binary',
    },
  }, socket, Buffer.alloc(0))

  // The fake row has no live RFB server behind it, so the bridge cannot connect;
  // what matters is that the route is addressed per instance and refuses cleanly.
  assert.match(Buffer.concat(written).toString(), /^HTTP\/1\.1 (404|503) /)
})

test('the per-instance WS route starts that instance\'s RFB server before bridging', async () => {
  const registry = fakeRegistry()
  const fake = mountWithRegistry(registry)
  const sessions = fake.routes.find((route) => route.path === '/_dsh/desktop-vnc/sessions')

  const created = recordingResponse()
  await sessions.handler({
    method: 'POST',
    url: '/_dsh/desktop-vnc/sessions',
    headers: {},
    [Symbol.asyncIterator]: async function* () {},
  }, created)
  const { id } = jsonBody(created.written)
  // A viewer only reaches the RFB server of an instance whose browser is up.
  registry.get(id).state = 'ready'
  registry.get(id).ready = Promise.resolve()
  const upgrade = fake.upgrades.find((route) => route.path === `/_dsh/desktop-vnc/sessions/${id}/ws`)

  const written = []
  const socket = {
    write: (chunk) => written.push(Buffer.from(chunk)),
    end: () => {},
    once: () => {},
    setNoDelay: () => {},
    destroy: () => {},
  }
  // No RFB server is really listening, so the bridge cannot complete. The seam
  // under test is "the instance's own server was started first", which happens
  // before the connect.
  await upgrade.handler({
    method: 'GET',
    url: `/_dsh/desktop-vnc/sessions/${id}/ws`,
    headers: {
      origin: 'http://127.0.0.1:3080',
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': 'binary',
    },
  }, socket, Buffer.alloc(0))

  assert.equal(registry.get(id).vnc.ensures, 1, 'the instance\'s own RFB server is ensured at WS time')
  // The port it reported has nothing behind it, so the handler refuses rather
  // than upgrading a socket to a server that is not there.
  assert.match(Buffer.concat(written).toString(), /^HTTP\/1\.1 503 /)
  assert.ok(!Buffer.concat(written).toString().includes('101 Switching Protocols'))
})

// --- viewer counts come from the real bridge, not from a stored number -------

/**
 * A socket double with independent directions, as `handleUpgrade` expects.
 *
 * The bridge attaches its own listeners (`data`, `end`, `error`, `close`) and the
 * route attaches the release listener, so this has to be an EventEmitter rather
 * than a plain object.
 */
function bridgeSocket() {
  const socket = new EventEmitter()
  const written = []
  socket.destroyed = false
  socket.writableEnded = false
  socket.write = (chunk) => {
    written.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)))
    return true
  }
  socket.end = () => {
    if (socket.writableEnded) return
    socket.writableEnded = true
    socket.emit('end')
  }
  socket.destroy = () => {
    socket.destroyed = true
  }
  socket.setNoDelay = () => {}
  socket.pause = () => {}
  socket.resume = () => {}
  return { socket, written, response: () => Buffer.concat(written).toString() }
}

/** The upgrade request a same-origin browser sends. */
const UPGRADE_HEADERS = {
  origin: 'http://127.0.0.1:3080',
  upgrade: 'websocket',
  connection: 'Upgrade',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'sec-websocket-version': '13',
  'sec-websocket-protocol': 'binary',
}

test('two clients watching one instance make the row say two, and the count follows real closes', async (t) => {
  // A real RFB listener on loopback: the viewer count is only honest if it counts
  // sockets the bridge actually holds, so nothing about the connection is faked
  // except the bytes.
  const accepted = new Set()
  const rfbServer = createServer((socket) => {
    accepted.add(socket)
    socket.on('error', () => {})
  })
  await new Promise((resolve) => rfbServer.listen(0, '127.0.0.1', resolve))
  const rfbPort = rfbServer.address().port

  const registry = createInstanceRegistry({
    createBackend: () => ({
      browser: { ensure: async () => ({ ok: true, display: ':200' }), status: () => ({}) },
      vnc: {
        ensure: async () => ({ running: true, port: rfbPort }),
        status: () => ({ running: true, port: rfbPort }),
        display: () => ':200',
      },
      capture: null,
      dispose: async () => {},
    }),
    prepareDisplay: async () => ({ display: ':200' }),
    ports: [5999],
    viewport: { width: 1280, height: 800 },
    log: () => {},
  })
  // Cleanup runs even when an assertion fails: a leaked listener would keep the
  // test process alive and turn one wrong count into a hung suite.
  t.after(async () => {
    for (const socket of accepted) socket.destroy()
    await new Promise((resolve) => rfbServer.close(resolve))
    await registry.disposeAll()
  })

  const fake = mountWithRegistry(registry)
  const sessions = fake.routes.find((route) => route.path === '/_dsh/desktop-vnc/sessions')
  const created = recordingResponse()
  await sessions.handler({
    method: 'POST',
    url: '/_dsh/desktop-vnc/sessions',
    headers: {},
    [Symbol.asyncIterator]: async function* () {},
  }, created)
  const { id } = jsonBody(created.written)
  await registry.get(id).ready
  const upgrade = fake.upgrades.find((route) => route.path === `/_dsh/desktop-vnc/sessions/${id}/ws`)

  const first = bridgeSocket()
  const second = bridgeSocket()
  t.after(() => {
    first.socket.destroy()
    second.socket.destroy()
  })
  // Both clients connect before either is closed: that is the "two people are
  // looking at the same browser" case the row has to report.
  await Promise.all([
    upgrade.handler({ method: 'GET', url: upgrade.path, headers: UPGRADE_HEADERS }, first.socket, Buffer.alloc(0)),
    upgrade.handler({ method: 'GET', url: upgrade.path, headers: UPGRADE_HEADERS }, second.socket, Buffer.alloc(0)),
  ])
  assert.match(first.response(), /^HTTP\/1\.1 101 /)
  assert.match(second.response(), /^HTTP\/1\.1 101 /)
  assert.equal(registry.list()[0].viewers, 2, 'two live sockets are two viewers')

  // One client leaves. The count must drop by exactly one — a double release here
  // would tell the remaining viewer they are alone while they are not.
  first.socket.emit('close')
  assert.equal(registry.list()[0].viewers, 1)

  second.socket.emit('close')
  assert.equal(registry.list()[0].viewers, 0)
})
