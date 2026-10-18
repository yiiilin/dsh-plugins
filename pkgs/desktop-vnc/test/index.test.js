/**
 * Unit tests for the Host plugin's public surface: the frozen Config schema and
 * mount identity, the asset-path escape guard (the one place a request string
 * becomes a file path) and the effect-based teardown of every side effect.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Config, apply, assetContentType, inject, name, resolveAssetPath, resolvePanelDisplay } from '../index.js'

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

/** A Cordis-shaped context recording routes, upgrades and effects. */
function fakeCtx({ withWebServer = true } = {}) {
  const routes = []
  const upgrades = []
  const disposers = []
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
  }
  return {
    ctx,
    routes,
    upgrades,
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
