/**
 * dsh-desktop-vnc — Host half of the desktop-vnc plugin.
 *
 * Adds a right-sidebar tab that embeds a noVNC client for **one browser**, plus
 * every host-side dependency that tab needs so nothing is fetched from a CDN and
 * no external VNC server has to exist first:
 *
 * - `/_dsh/desktop-vnc/asset/**` serves the vendored noVNC ESM tree (`core/` and
 *   `vendor/`) straight from this package. noVNC imports its own modules with
 *   relative specifiers, so the browser resolves `./util/int.js` against the
 *   asset URL and only a prefix route serving the tree verbatim can answer it.
 * - `/_dsh/desktop-vnc/frame.jpg` and `/_dsh/desktop-vnc/stream.mjpg` capture the
 *   root window with ImageMagick for the thumbnail and degraded-preview paths.
 * - `/_dsh/desktop-vnc/state` reports what the panel needs to show an honest
 *   status instead of a blank canvas.
 * - `/_dsh/desktop-vnc/ws` is a hand-written RFC 6455 server that pumps
 *   WebSocket frames to the x11vnc TCP port. The workspace has no usable `ws`
 *   dependency, so {@link ./ws.js} implements the framing itself.
 *
 * v2 layering: {@link ./browser.js} owns a nested Xephyr display with a single
 * Chromium inside it, and that Xephyr window is simultaneously a real window on
 * the host desktop — so the same browser is visible on the desktop and in the
 * panel. x11vnc therefore mirrors the **nested** display, which is only known
 * once `browser.ensure()` has run; the capture service and the x11vnc controller
 * are retargeted to it through their `setDisplay()` seams. With
 * `browser.enabled=false` the whole stack is bypassed and the panel mirrors
 * `config.display` exactly as v1 did.
 *
 * Two safety properties are load-bearing and tested:
 *
 * - **Same-origin only.** The upgrade handler refuses an `Origin` whose host is
 *   not the one this request was addressed to. Without that check any web page
 *   the user visits could borrow their browser to reach this machine's desktop.
 * - **Own only what we started.** x11vnc is reused when the port already answers
 *   and is never killed by pattern; unloading the plugin stops exactly the
 *   process this controller spawned, and the browser stack stops exactly the
 *   Xephyr/Chromium pids it recorded.
 *
 * @module @yiln-dsh/dsh-desktop-vnc
 */

import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

import { createBrowserStack } from './browser.js'
import { createCaptureService, streamMjpeg } from './capture.js'
import { createX11VncController } from './x11vnc.js'
import {
  DEFAULT_MAX_FRAME_BYTES,
  createBridge,
  isSameOriginRequest,
  localOrigins,
  parseHandshake,
  writeHttpError,
  writeUpgrade,
} from './ws.js'

export const name = 'desktop-vnc'

/** Host services this module reads; every one is treated as optional at runtime. */
export const inject = ['webServer', 'subprocess', 'fs']

export const Config = z.object({
  // --- v1 fields (kept verbatim for compatibility) ---
  enabled: z.boolean().default(true),
  /** Host desktop: the Xephyr window lands here, and the v1 mirror when browser.enabled=false. */
  display: z.string().default(':0'),
  rfbPort: z.number().default(5900),
  viewportWidth: z.number().default(1280),
  viewportHeight: z.number().default(800),
  jpegQuality: z.number().default(72),
  frameRate: z.number().default(8),
  maxClients: z.number().default(4),
  // --- v2: the nested browser stack the panel actually shows ---
  browser: z.object({
    /** false reverts to v1: mirror `display` itself, no Xephyr/Chromium. */
    enabled: z.boolean().default(true),
    executable: z.string().default('chromium'),
    /** 'auto' picks the first free `:90`..`:120`; an explicit `:N` is used verbatim. */
    nestedDisplay: z.string().default('auto'),
    /** The desktop window's title, also used to identify/clean up. */
    windowTitle: z.string().default('DSH Desktop Browser'),
    /** Page opened at start; empty means about:blank. */
    startUrl: z.string().default('about:blank'),
    /** Extra browser arguments appended to the frozen set. */
    extraArgs: z.array(z.string()).default([]),
  }).default({}),
})

const PREFIX = '/_dsh/desktop-vnc'
const ASSET_PREFIX = `${PREFIX}/asset`
const WS_PATH = `${PREFIX}/ws`
const FRAME_PATH = `${PREFIX}/frame.jpg`
const STREAM_PATH = `${PREFIX}/stream.mjpg`
const STATE_PATH = `${PREFIX}/state`

const CORE_MIME = 'text/javascript; charset=utf-8'
const ASSET_CACHE = 'public, max-age=31536000, immutable'
const NO_STORE = 'no-store, no-cache, must-revalidate'

/** Vendored noVNC root, resolved from this module rather than the process cwd. */
const NOVNC_ROOT = fileURLToPath(new URL('./novnc/', import.meta.url))

/** Directories of the vendored tree the browser is allowed to import from. */
const ASSET_ROOTS = ['core', 'vendor']

/**
 * Resolve an asset request to an absolute path inside the vendored tree.
 *
 * The prefix route sees whatever the browser put after `/asset`, so this is the
 * only thing standing between a request and an arbitrary file read. `path.join`
 * would silently collapse `../`, so the check is explicit: only `core/` or
 * `vendor/` roots, only `.js` files, and no `..` segment anywhere.
 *
 * @param {string} rel request path relative to the asset prefix.
 * @returns {string|null} the absolute file path, or null when the request escapes.
 */
export function resolveAssetPath(rel) {
  if (typeof rel !== 'string' || rel === '') return null
  if (rel.startsWith('/') || rel.startsWith('\\')) return null
  // A doubled separator collapses to a legal path under `path.join`, but it is
  // not a path noVNC ever emits, so it is refused rather than normalized.
  if (rel.includes('//') || rel.includes('\\\\')) return null
  const parts = rel.split(/[/\\]+/)
  if (parts.length < 2) return null
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  if (!ASSET_ROOTS.includes(parts[0])) return null
  if (!parts[parts.length - 1].endsWith('.js')) return null
  if (!/^[A-Za-z0-9._-]+$/.test(parts[parts.length - 1])) return null
  const path = join(NOVNC_ROOT, ...parts)
  // Belt-and-braces: the joined path must still live under the vendored root.
  if (!path.startsWith(NOVNC_ROOT.endsWith(sep) ? NOVNC_ROOT : `${NOVNC_ROOT}${sep}`)) return null
  return path
}

/** The MIME type for one allowed asset (`.js` only) or null when it is not allowed. */
export function assetContentType(rel) {
  return typeof rel === 'string' && rel.endsWith('.js') ? CORE_MIME : null
}

/**
 * Point the whole panel at the display it should mirror.
 *
 * With `browser.enabled=false` this is the v1 path verbatim: `hostDisplay`, no
 * Xephyr and no Chromium. Otherwise the nested display is only known after
 * `browser.ensure()`, so both the x11vnc controller and the capture service are
 * retargeted to it through their `setDisplay()` seams.
 *
 * Exported (and injected) so the wiring is unit-testable without a real X
 * server, exactly like {@link resolveAssetPath} is for the asset guard.
 *
 * @param {object} options
 * @param {{ensure: () => Promise<object>}} options.browser the nested browser stack.
 * @param {{setDisplay: (display: string) => string}} [options.vnc] x11vnc controller to retarget.
 * @param {{setDisplay: (display: string) => string}} [options.capture] capture service to retarget.
 * @param {boolean} [options.browserEnabled] false selects the v1 mirror path.
 * @param {string} [options.hostDisplay] the desktop display, used when disabled.
 * @returns {Promise<{display: string}|{error: string}>} the display to mirror, or a readable failure.
 */
export async function resolvePanelDisplay({
  browser,
  vnc,
  capture,
  browserEnabled = true,
  hostDisplay = ':0',
} = {}) {
  if (!browserEnabled) return { display: hostDisplay }
  let result
  try {
    result = await browser.ensure()
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  // Gate on `ok`, never on the absence of `error`: the Xephyr→Xvfb fallback is a
  // usable stack that still carries the Xephyr reason as an informational
  // `error`, while `ok:false` is a real failure.
  const nested = typeof result?.display === 'string' && result.display !== '' ? result.display : null
  if (result?.ok !== true || nested === null) {
    return {
      error: typeof result?.error === 'string' && result.error !== ''
        ? result.error
        : 'desktop browser is unavailable',
    }
  }
  vnc?.setDisplay?.(nested)
  capture?.setDisplay?.(nested)
  // The display's access control is on: the screenshot tool presents the same
  // cookie the browser does, or every frame is refused.
  if (typeof result?.authority === 'string') {
    capture?.setAuthority?.(result.authority)
    // The RFB server draws from the same display, so it needs the same cookie.
    vnc?.setAuthority?.(result.authority)
  }
  return { display: nested }
}

export function apply(ctx, config = {}) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  const enabled = config.enabled !== false
  const display = typeof config.display === 'string' && config.display !== '' ? config.display : ':0'
  const rfbPort = Number.isInteger(config.rfbPort) ? config.rfbPort : 5900
  // Zero is a legitimate "no concurrent preview" setting; only nonsense falls back.
  const maxClients = Number.isInteger(config.maxClients) && config.maxClients >= 0 ? config.maxClients : 4
  const frameRate = Number.isFinite(config.frameRate) ? config.frameRate : 8
  const jpegQuality = Number.isFinite(config.jpegQuality) ? config.jpegQuality : 72
  const viewport = {
    width: Number.isFinite(config.viewportWidth) ? config.viewportWidth : 1280,
    height: Number.isFinite(config.viewportHeight) ? config.viewportHeight : 800,
  }

  const log = (level, message) => {
    try {
      const logger = ctx.logger
      if (logger === undefined) return
      if (level === 'warn' && typeof logger.warn === 'function') logger.warn(message)
      else if (level === 'error' && typeof logger.error === 'function') logger.error(message)
      else if (typeof logger.info === 'function') logger.info(message)
    } catch {
      // Diagnostics must never break a request.
    }
  }

  /** Live WS bridges, so unload can tear every session down. */
  const sessions = new Set()
  /** Live MJPEG streams, so unload can clear every interval. */
  const streams = new Set()

  const subprocess = ctx.get('subprocess')
  const spawn = subprocess === undefined ? undefined : (spec) => subprocess.spawn(spec)
  const resolveExecutable = subprocess === undefined
    ? undefined
    : (command) => subprocess.resolveExecutable(command)

  const browserConfig = config.browser !== null && typeof config.browser === 'object' ? config.browser : {}
  const browserEnabled = browserConfig.enabled !== false

  // The v2 stack: one nested Xephyr display holding one Chromium, whose Xephyr
  // window is simultaneously a real window on `display`. Created even when
  // disabled so `state` can report `enabled: false` and stop() is a no-op.
  const browser = createBrowserStack({
    spawn,
    resolveExecutable,
    config: {
      display,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      browser: browserConfig,
    },
    log,
  })

  const vnc = createX11VncController({
    spawn,
    resolveExecutable,
    // v2 retargets this to the nested display once the browser stack is up; the
    // host desktop is only the initial/v1 value.
    config: { enabled, display, rfbPort },
    log,
  })

  const captureService = createCaptureService({
    spawn,
    resolveExecutable,
    config: { display, jpegQuality },
    log,
  })

  /**
   * Point the whole panel at the display it should mirror.
   *
   * With `browser.enabled=false` this is the v1 path verbatim: `config.display`,
   * no Xephyr and no Chromium. Otherwise the nested display is only known after
   * `browser.ensure()`, so both the x11vnc controller and the capture service
   * are retargeted to it here.
   *
   * @returns {Promise<{display: string}|{error: string}>} the display to mirror, or a readable failure.
   */
  const ensurePanelDisplay = () => resolvePanelDisplay({
    browser,
    vnc,
    capture: captureService,
    browserEnabled,
    hostDisplay: display,
  })

  // Every route is registered as an effect so unloading the plugin releases it.
  const registerRoute = (route) => {
    ctx.effect(() => webServer.register(route))
  }

  const sendText = (res, status, body) => {
    const payload = Buffer.from(String(body), 'utf8')
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': payload.length })
    res.end(payload)
  }

  const sendJson = (res, status, value) => {
    const payload = Buffer.from(JSON.stringify(value), 'utf8')
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length })
    res.end(payload)
  }

  // --- 4.1 asset route (prefix) ---------------------------------------------
  // noVNC imports siblings with relative specifiers, so the whole tree must be
  // reachable verbatim under one prefix; only the prebuilt ESM files are served.
  registerRoute({
    kind: 'prefix',
    path: ASSET_PREFIX,
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://dsh.local')
      const pathname = url.pathname
      const rel = pathname.startsWith(`${ASSET_PREFIX}/`) ? pathname.slice(ASSET_PREFIX.length + 1) : ''
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      let body
      try {
        const decoded = decodeURIComponent(rel)
        const path = resolveAssetPath(decoded)
        if (path === null) {
          sendText(res, 404, 'not found')
          return
        }
        body = readFileSync(path)
      } catch {
        // Both a rejected path and a read failure are "no such asset" to the
        // browser; distinguishing them would leak the layout of the install.
        sendText(res, 404, 'not found')
        return
      }
      res.writeHead(200, {
        'content-type': assetContentType(rel) ?? CORE_MIME,
        'content-length': body.length,
        'cache-control': ASSET_CACHE,
      })
      if (req.method === 'HEAD') res.end()
      else res.end(body)
    },
  })

  // --- 4.2 one-shot frame ----------------------------------------------------
  registerRoute({
    kind: 'exact',
    path: FRAME_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      if (!enabled) {
        sendText(res, 503, 'desktop-vnc disabled')
        return
      }
      try {
        // The panel mirrors the nested display in v2, so the stack must be up
        // before there is anything to screenshot. Shared in-flight promise: a
        // concurrent WS upgrade triggers the same single start.
        const target = await ensurePanelDisplay()
        if (target.error !== undefined) {
          log('warn', `desktop-vnc: frame.jpg unavailable: ${target.error}`)
          sendText(res, 503, target.error)
          return
        }
        const url = new URL(req.url ?? '/', 'http://dsh.local')
        const body = await captureService.capture({ quality: url.searchParams.get('quality') })
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'content-length': body.length,
          'cache-control': NO_STORE,
        })
        if (req.method === 'HEAD') res.end()
        else res.end(body)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log('warn', `desktop-vnc: frame.jpg failed: ${message}`)
        sendText(res, 503, message)
      }
    },
  })

  // --- 4.3 MJPEG preview ----------------------------------------------------
  registerRoute({
    kind: 'exact',
    path: STREAM_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      if (!enabled) {
        sendText(res, 503, 'desktop-vnc disabled')
        return
      }
      if (streams.size >= maxClients) {
        sendText(res, 503, 'too many desktop preview clients')
        return
      }
      // Resolve the nested display before the first frame so the degraded
      // preview shows the browser and not the locked host desktop. `streamMjpeg`
      // writes its 200 head itself, so a failure here can still be a clean 503.
      const target = await ensurePanelDisplay()
      if (target.error !== undefined) {
        log('warn', `desktop-vnc: stream.mjpg unavailable: ${target.error}`)
        sendText(res, 503, target.error)
        return
      }
      const url = new URL(req.url ?? '/', 'http://dsh.local')
      const quality = url.searchParams.get('quality') ?? jpegQuality
      const fps = url.searchParams.get('fps') ?? frameRate
      const stream = streamMjpeg({
        res,
        capture: (options) => captureService.capture(options),
        fps,
        quality,
        log,
      })
      streams.add(stream)
      // The client owns teardown through close/aborted; the set only tracks it.
      res.on('close', () => streams.delete(stream))
    },
  })

  // --- 4.4 state -------------------------------------------------------------
  registerRoute({
    kind: 'exact',
    path: STATE_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      const status = vnc.status()
      // `browserStatus` is the browser stack's own snapshot: `display` is the
      // nested display once ensure() has run, otherwise the host fallback.
      const browserStatus = browser.status()
      sendJson(res, 200, {
        enabled,
        display,
        // The display the panel actually shows: the nested one in v2, or the
        // host display under the v1-compatible `browser.enabled=false` path.
        vncDisplay: vnc.display(),
        rfbHost: '127.0.0.1',
        rfbPort,
        vncRunning: status.running === true,
        clients: sessions.size + streams.size,
        viewport: { width: viewport.width, height: viewport.height },
        browser: {
          enabled: browserEnabled,
          display: browserStatus.display,
          xephyr: browserStatus.xephyr === true,
          chromium: browserStatus.chromium === true,
          running: browserStatus.running === true,
          mode: browserStatus.mode,
          degraded: browserStatus.degraded === true,
          pids: browserStatus.pids ?? {},
          ...(browserStatus.warning === undefined ? {} : { warning: browserStatus.warning }),
        },
        // Only Xephyr mode puts the browser on the host desktop; the Xvfb
        // fallback keeps the panel working but nothing is desktop-visible.
        desktopVisible: browserStatus.desktopVisible === true,
      })
    },
  })

  // --- 4.5 WebSocket ↔ x11vnc bridge ----------------------------------------
  const allowedOrigins = () => {
    const origins = []
    try {
      const origin = webServer.getOrigin()
      if (typeof origin === 'string' && origin !== '') origins.push(...localOrigins(origin))
    } catch {
      // getOrigin throws before the listener binds; loopback defaults still apply.
    }
    if (origins.length === 0) origins.push(...localOrigins('http://127.0.0.1'))
    return origins
  }

  ctx.effect(() => webServer.registerUpgrade({
    path: WS_PATH,
    handler: async (req, socket, head) => {
      if (!enabled) {
        writeHttpError(socket, 503, 'desktop-vnc disabled')
        return
      }
      const origin = req.headers?.origin
      // Same-origin is decided against the Host the browser actually addressed,
      // because one listener is reachable as loopback, as a LAN address and as a
      // proxied public name — a literal address allow-list cannot cover those.
      if (!isSameOriginRequest(origin, req.headers?.host, allowedOrigins())) {
        log('warn', `desktop-vnc: refused websocket from origin ${origin} (host ${req.headers?.host})`)
        writeHttpError(socket, 403, 'forbidden origin')
        return
      }
      const handshake = parseHandshake(req)
      if (!handshake.ok) {
        log('warn', `desktop-vnc: rejected websocket handshake: ${handshake.error}`)
        writeHttpError(socket, handshake.status, handshake.error, handshake.version ? { 'sec-websocket-version': handshake.version } : {})
        return
      }
      if (sessions.size >= maxClients) {
        writeHttpError(socket, 503, 'too many desktop sessions')
        return
      }

      // v2: the panel shows one browser, so the nested display must exist before
      // x11vnc has anything worth mirroring. Both steps are in-flight-shared, so
      // two tabs opening at once still start one Xephyr/Chromium and one x11vnc.
      const target = await ensurePanelDisplay()
      if (target.error !== undefined) {
        log('warn', `desktop-vnc: refusing websocket: ${target.error}`)
        writeHttpError(socket, 503, target.error)
        return
      }

      // The RFB server must exist before the browser is told the socket is open,
      // so a failed start becomes an HTTP error the panel can explain.
      const started = await vnc.ensure()
      if (started.running !== true) {
        writeHttpError(socket, 503, started.error ?? 'x11vnc is unavailable')
        return
      }

      let tcp
      try {
        tcp = await openTcp({ port: started.port ?? rfbPort })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log('warn', `desktop-vnc: cannot reach x11vnc on 127.0.0.1:${rfbPort}: ${message}`)
        writeHttpError(socket, 503, `cannot reach the VNC server: ${message}`.slice(0, 200))
        return
      }

      writeUpgrade(socket, handshake)
      socket.setNoDelay?.(true)
      tcp.setNoDelay?.(true)

      const bridge = createBridge({
        wsSocket: socket,
        tcpSocket: tcp,
        subprotocol: handshake.subprotocol ?? 'binary',
        maxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
        head,
        log,
      })
      sessions.add(bridge)
      const release = () => sessions.delete(bridge)
      socket.once('close', release)
      tcp.once('close', release)
    },
  }))

  // --- teardown --------------------------------------------------------------
  ctx.effect(() => () => {
    for (const stream of streams) {
      try {
        stream.stop()
      } catch {
        // Teardown is best-effort during unload.
      }
    }
    streams.clear()
    for (const bridge of sessions) {
      try {
        bridge.dispose()
      } catch {
        // ignore
      }
    }
    sessions.clear()
  })

  // The x11vnc controller is its own effect: its disposer kills exactly the
  // process this plugin started and never touches a pre-existing server.
  ctx.effect(() => () => {
    void vnc.dispose().catch(() => {})
  })

  // The browser stack is a separate effect too: its disposer stops exactly the
  // Xephyr/Xvfb and Chromium pids it recorded (never by name) and removes the
  // per-instance Chromium profile directory.
  ctx.effect(() => () => {
    void browser.dispose().catch(() => {})
  })
}

/** Open `127.0.0.1:<port>` and resolve once connected. */
function openTcp({ port, timeoutMs = 3000 }) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      reject(error)
    }
    const timer = setTimeout(() => fail(new Error('connection timed out')), timeoutMs)
    timer.unref?.()
    socket.once('connect', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners('error')
      resolve(socket)
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      fail(error)
    })
  })
}

/** Attach inject on the default export too: the loader unwraps `default`. */
apply.inject = inject

export default apply
