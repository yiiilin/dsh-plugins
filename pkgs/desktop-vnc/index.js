/**
 * dsh-desktop-vnc — Host half of the desktop-vnc plugin.
 *
 * Adds a right-sidebar tab that embeds a noVNC client, plus every host-side
 * dependency that tab needs so nothing is fetched from a CDN and no external VNC
 * server has to exist first:
 *
 * - `/_dsh/desktop-vnc/asset/**` serves the vendored noVNC ESM tree (`core/` and
 *   `vendor/`) straight from this package. noVNC imports its own modules with
 *   relative specifiers, so the browser resolves `./util/int.js` against the
 *   asset URL and only a prefix route serving the tree verbatim can answer it.
 * - `/_dsh/desktop-vnc/sessions` is the **browser instance** table over HTTP: a
 *   `GET` list, a `POST` create that answers before the browser is up, and a
 *   `DELETE /<id>` close. One prefix route serves all three because route
 *   registration throws on a duplicate path and ids are minted at runtime.
 * - `/_dsh/desktop-vnc/sessions/<id>/ws` bridges one instance's RFB server. Each
 *   instance also gets its own exact upgrade route: upgrade dispatch is an exact
 *   pathname lookup, so there is no prefix form to share.
 * - `/_dsh/desktop-vnc/frame.jpg` and `/_dsh/desktop-vnc/stream.mjpg` capture the
 *   root window with ImageMagick for the thumbnail and degraded-preview paths.
 *   They are v1-compatible and address the first instance in the table.
 * - `/_dsh/desktop-vnc/state` reports what the panel needs to show an honest
 *   status instead of a blank canvas. Its shape is frozen; the first instance is
 *   projected into it rather than widening the document.
 * - `/_dsh/desktop-vnc/ws` is a hand-written RFC 6455 server that pumps
 *   WebSocket frames to the x11vnc TCP port. The workspace has no usable `ws`
 *   dependency, so {@link ./ws.js} implements the framing itself.
 * - Three **agent tools** ({@link ./tools.js}) manage the same table: list,
 *   create for an owning session, and close by id. They call the table directly
 *   rather than the HTTP endpoints, so an agent's change appears in the panel at
 *   once; an id that does not exist is an error, never a fallback.
 *
 * v2 layering: {@link ./instances.js} is the table, and each entry owns a whole
 * stack. {@link ./browser.js} owns a nested Xephyr display with a single Chromium
 * inside it, and that Xephyr window is simultaneously a real window on the host
 * desktop — so the same browser is visible on the desktop and in the panel. x11vnc
 * therefore mirrors the **nested** display, which is only known once
 * `browser.ensure()` has run; the capture service and the x11vnc controller are
 * retargeted to it through their `setDisplay()` seams. With
 * `browser.enabled=false` the whole stack is bypassed and the panel mirrors
 * `config.display` exactly as v1 did.
 *
 * Four properties are load-bearing and tested:
 *
 * - **Same-origin only.** The upgrade handler refuses an `Origin` whose host is
 *   not the one this request was addressed to. Without that check any web page
 *   the user visits could borrow their browser to reach this machine's desktop.
 * - **Own only what we started.** x11vnc is reused only when it is *this
 *   instance's* server and is never killed by pattern; unloading the plugin stops
 *   exactly the processes each instance spawned, and each browser stack stops
 *   exactly the Xephyr/Chromium pids it recorded.
 * - **Ports are claimed before they are bound.** The table reserves a port when
 *   the instance is created, so two concurrent creates cannot both pick the same
 *   free-looking port and race for the bind.
 * - **Ownership is the session's.** `session/disposed` closes that session's
 *   instances; `agent/disposed` deliberately closes nothing, because an agent can
 *   end while its session stays open and keeps driving the browser.
 *
 * @module @yiln-dsh/dsh-desktop-vnc
 */

import { readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'

import { createBrowserStack } from './browser.js'
import { createCaptureService, streamMjpeg } from './capture.js'
import { createInstanceRegistry, isInstanceId } from './instances.js'
import { browserInstanceTools } from './tools.js'
import { createX11VncController, portCandidates } from './x11vnc.js'
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
  /** v1 single port. Preferred first when `rfbPortRange` is not configured. */
  rfbPort: z.number().default(5900),
  /**
   * The RFB port pool one browser instance allocates from, lowest first. A port
   * that already answers belongs to somebody else and is skipped, never adopted.
   */
  rfbPortRange: z.array(z.number()).default([5900, 5999]),
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
    /** 'auto' picks the first free `:200`..`:999`; an explicit `:N` is used verbatim. */
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
/**
 * The instance collection. One **prefix** route owns the whole subtree — list,
 * create and `/<id>` close — because route registration throws on a duplicate
 * (kind, path) and instance ids are minted at runtime, so a route per id is
 * impossible. The handler parses the trailing segment itself.
 */
const SESSIONS_PATH = `${PREFIX}/sessions`
/** The per-instance VNC upgrade path, exact because upgrade routes have no prefix form. */
const instanceWsPath = (id) => `${SESSIONS_PATH}/${id}/ws`

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
  // The pool an instance allocates its RFB port from. Unset falls back to the v1
  // single value first, then the default pool (see `portCandidates`).
  const rfbPortRange = config.rfbPortRange
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

  /**
   * The directory identity handed to each browser stack.
   *
   * `createBrowserStack` names its temp directory `dsh-desktop-vnc-<pid>`, and the
   * field exists to give each stack a directory of its own. A monotonically
   * increasing number is used rather than a hash of the instance id because
   * uniqueness has to be guaranteed, not merely likely: two instances sharing a
   * directory share a Chromium SingletonLock and an Xauthority cookie, which
   * silently locks one of them out of its own display. Starting at 1 keeps it
   * distinct from the process id default a v1 profile would have used.
   */
  let instanceSequence = 0
  const nextInstancePid = () => {
    instanceSequence += 1
    return instanceSequence
  }

  /**
   * Build the browser/vnc/capture trio for one browser instance.
   *
   * Every instance gets its own identity in the temp directory. That is what keeps
   * two instances in one process from sharing a Chromium profile (SingletonLock)
   * or an Xauthority cookie (last writer wins, first instance locked out of its own
   * display) — and the port it binds was already claimed by the registry.
   *
   * @param {{id: string, port: number}} context the registry's claim for this instance.
   * @returns {{browser: object, vnc: object, capture: object, dispose: () => Promise<void>}} the trio.
   */
  const createBackend = ({ id, port }) => {
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
      tmpDir: tmpdir(),
      // The instance identity, not the process id: two stacks in one process must
      // land in different directories.
      pid: nextInstancePid(),
    })

    const vnc = createX11VncController({
      spawn,
      resolveExecutable,
      // The registry claimed `port`; pin the controller to exactly that one so its
      // own pool walk cannot pick a port another instance holds.
      config: { enabled, display, rfbPort: port, rfbPortRange: [port, port] },
      log,
    })

    const capture = createCaptureService({
      spawn,
      resolveExecutable,
      config: { display, jpegQuality },
      log,
    })

    return {
      browser,
      vnc,
      capture,
      // Reverse order of construction: the RFB server and the browser must both be
      // gone before the plugin forgets the instance, and neither stop may throw.
      dispose: async () => {
        await Promise.allSettled([capture.dispose?.(), vnc.dispose(), browser.dispose()])
      },
    }
  }

  /**
   * Resolve the display for one instance and retarget its backend.
   *
   * With `browser.enabled=false` this is the v1 path verbatim: `config.display`, no
   * Xephyr and no Chromium. Otherwise the nested display is only known after
   * `browser.ensure()`, which {@link resolvePanelDisplay} runs.
   *
   * @param {{browser: object, vnc: object, capture: object}} backend the instance's trio.
   * @returns {Promise<{display: string}|{error: string}>} the display to mirror, or a readable failure.
   */
  const prepareDisplay = (backend) => resolvePanelDisplay({
    browser: backend.browser,
    vnc: backend.vnc,
    capture: backend.capture,
    browserEnabled,
    hostDisplay: display,
  })

  /**
   * The browser instance table.
   *
   * `config.instanceRegistry` is the test seam: the routes are exercised against a
   * fake table without spawning Xephyr, exactly like `resolvePanelDisplay` is
   * injected to unit-test the display choice.
   */
  const registry = config.instanceRegistry ?? createInstanceRegistry({
    createBackend,
    prepareDisplay,
    ports: portCandidates({ rfbPortRange, rfbPort }),
    viewport,
    log,
  })

  // Every route is registered as an effect so unloading the plugin releases it.
  const registerRoute = (route) => {
    ctx.effect(() => webServer.register(route))
  }

  // --- instance ownership ----------------------------------------------------
  // A browser instance belongs to the session that created it, and when that
  // session goes away its instances do too. Only `session/disposed` is listened
  // to: `agent/disposed` fires while the session is still open and still able to
  // drive the browser it opened, so closing on it would collect live instances.
  if (typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('session/disposed', (session) => {
      const sessionId = typeof session === 'string' ? session : session?.id
      if (typeof sessionId !== 'string' || sessionId === '') return
      void Promise.resolve(registry.disposeSession?.(sessionId)).catch((error) => {
        log('warn', `desktop-vnc: could not close the instances of session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`)
      })
    }))
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

  /**
   * The instance the legacy single-panel routes address.
   *
   * v1 had exactly one browser, so `frame.jpg`, `stream.mjpg` and `ws` keep
   * working by projecting the first instance in the table — and, when the table is
   * empty, by starting one, which is what those routes did in v1 too. A new
   * instance is not created when one exists: the legacy path never picks a second
   * browser behind the caller's back.
   *
   * @returns {Promise<{entry: object, display: string}|{error: string}>} the instance or a readable failure.
   */
  const ensureLegacyInstance = async () => {
    let entry = registry.first()
    if (entry === undefined) {
      const created = createInstance({ ownerSessionId: null })
      entry = registry.get(created.id)
    }
    await entry.ready
    if (entry.state === 'failed') {
      return { error: typeof entry.error === 'string' && entry.error !== '' ? entry.error : 'desktop browser is unavailable' }
    }
    return { entry, display: entry.display ?? display }
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
        // The legacy thumbnail belongs to the single panel v1 had, so it projects
        // the first instance in the table rather than choosing a browser itself.
        const target = await ensureLegacyInstance()
        if (target.error !== undefined) {
          log('warn', `desktop-vnc: frame.jpg unavailable: ${target.error}`)
          sendText(res, 503, target.error)
          return
        }
        const url = new URL(req.url ?? '/', 'http://dsh.local')
        const body = await target.entry.capture.capture({ quality: url.searchParams.get('quality') })
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
      const target = await ensureLegacyInstance()
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
        capture: (options) => target.entry.capture.capture(options),
        fps,
        quality,
        log,
      })
      streams.add(stream)
      // The client owns teardown through close/aborted; the set only tracks it.
      res.on('close', () => streams.delete(stream))
    },
  })

  // --- 4.4 browser instances -------------------------------------------------
  // One prefix route serves list, create and `/<id>` close. Route registration
  // throws on a duplicate (kind, path) and instance ids are minted at runtime, so
  // a route per id is impossible: the trailing segment is parsed here instead.
  registerRoute({
    kind: 'prefix',
    path: SESSIONS_PATH,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://dsh.local')
      const pathname = url.pathname
      const rest = pathname.startsWith(`${SESSIONS_PATH}/`)
        ? pathname.slice(SESSIONS_PATH.length + 1)
        : ''

      // `/sessions` itself: the collection.
      if (rest === '') {
        if (req.method === 'GET' || req.method === 'HEAD') {
          // A flat array, in table order. No focus (that is per client) and no
          // total/limit (the port pool is the only cap).
          sendJson(res, 200, registry.list())
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, HEAD, POST' })
          res.end()
          return
        }
        let body = {}
        try {
          body = await readJsonBody(req)
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
          return
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { error: 'request body must be an object' })
          return
        }
        try {
          // Answers immediately with `{id, state: 'starting'}`: the stack boots on
          // a promise nobody here awaits.
          sendJson(res, 200, createInstance({
            ownerSessionId: typeof body.ownerSessionId === 'string' && body.ownerSessionId !== ''
              ? body.ownerSessionId
              : null,
          }))
        } catch (error) {
          const status = Number.isInteger(error?.status) ? error.status : 500
          log('warn', `desktop-vnc: cannot create a browser instance: ${error instanceof Error ? error.message : String(error)}`)
          sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      // `/sessions/<id>`: one instance. Anything deeper is not a route we serve
      // here (the per-instance WS path is an upgrade route, never an HTTP one).
      const [id, ...trailing] = rest.split('/')
      if (trailing.length > 0) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      if (!isInstanceId(id)) {
        sendJson(res, 404, { error: `no such browser instance: ${id}` })
        return
      }
      if (req.method !== 'DELETE') {
        res.writeHead(405, { allow: 'DELETE' })
        res.end()
        return
      }
      try {
        sendJson(res, 200, await registry.close(id))
      } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : 500
        sendJson(res, status, { error: error instanceof Error ? error.message : String(error) })
      }
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
      // The shape of this document is frozen: the existing client reads these
      // fields and `test/index.test.js` asserts the `browser` object in full. The
      // instance table is projected into it — the first instance stands in for the
      // one browser v1 had — rather than widening the document.
      const entry = registry.first()
      const status = entry?.vnc?.status?.() ?? { running: false, port: rfbPort }
      const browserStatus = entry?.browser?.status?.() ?? {
        display: entry?.display ?? display,
        xephyr: false,
        chromium: false,
        running: false,
        mode: 'none',
        degraded: false,
        pids: {},
      }
      sendJson(res, 200, {
        enabled,
        display,
        // The display the panel actually shows: the nested one in v2, or the
        // host display under the v1-compatible `browser.enabled=false` path.
        vncDisplay: entry?.vnc?.display?.() ?? display,
        rfbHost: '127.0.0.1',
        // The instance's allocated port once it has one; the configured
        // preference before that, so the field stays a number.
        rfbPort: Number.isInteger(entry?.port) ? entry.port : rfbPort,
        vncRunning: status.running === true,
        clients: sessions.size + streams.size,
        viewport: { width: viewport.width, height: viewport.height },
        browser: {
          enabled: browserEnabled,
          display: browserStatus.display ?? display,
          xephyr: browserStatus.xephyr === true,
          chromium: browserStatus.chromium === true,
          running: browserStatus.running === true,
          mode: browserStatus.mode ?? 'none',
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

  /**
   * Bridge one WebSocket to one browser instance's RFB server.
   *
   * Shared by the v1-compatible `ws` route and the per-instance `sessions/<id>/ws`
   * route: the difference is only which instance is resolved, and every step after
   * that is identical.
   *
   * @param {object} req the upgrade request.
   * @param {object} socket the raw WebSocket socket.
   * @param {Buffer} head bytes already read past the request line.
   * @param {() => Promise<{entry?: object, error?: string, status?: number}>} resolveEntry
   *   the instance this route addresses: `{entry}` when it exists, `{error, status}`
   *   when it cannot be addressed at all.
   */
  const handleUpgrade = async (req, socket, head, resolveEntry) => {
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

    const resolved = await resolveEntry()
    if (resolved?.entry === undefined) {
      const status = Number.isInteger(resolved?.status) ? resolved.status : 404
      writeHttpError(socket, status, resolved?.error ?? 'no such browser instance')
      return
    }
    const entry = resolved.entry
    // The instance's own start may still be in flight; awaiting it is what turns a
    // failed boot into an HTTP error the panel can explain instead of a dead socket.
    await entry.ready
    if (entry.state !== 'ready') {
      const message = typeof entry.error === 'string' && entry.error !== '' ? entry.error : 'browser instance is unavailable'
      log('warn', `desktop-vnc: refusing websocket for instance ${entry.id}: ${message}`)
      writeHttpError(socket, 503, message.slice(0, 200))
      return
    }

    // The RFB server starts lazily, on the first viewer: starting one per instance
    // up front would burn a process on every browser nobody looks at. It is
    // started here, before the connect, because connecting first would always find
    // nothing listening.
    if (entry.vnc !== null && entry.vnc !== undefined) {
      let started
      try {
        started = await entry.vnc.ensure()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log('warn', `desktop-vnc: refusing websocket for instance ${entry.id}: ${message}`)
        writeHttpError(socket, 503, message.slice(0, 200))
        return
      }
      if (started?.running !== true) {
        const message = typeof started?.error === 'string' ? started.error : 'x11vnc is unavailable'
        log('warn', `desktop-vnc: refusing websocket for instance ${entry.id}: ${message}`)
        writeHttpError(socket, 503, message.slice(0, 200))
        return
      }
      // The allocated port, never the configured preference: `status()` answers
      // the preferred port before the first allocation, so only ensure()'s return
      // value names the port that actually bound.
      if (Number.isInteger(started.port)) entry.port = started.port
    }

    let tcp
    try {
      // The instance's allocated port, never the configured preference: with a
      // pool the two differ and the diagnostic is worthless if it names the wrong one.
      tcp = await openTcp({ port: entry.port })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('warn', `desktop-vnc: cannot reach x11vnc on 127.0.0.1:${entry.port}: ${message}`)
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
    // Viewers are counted per instance, and the count is what the sidebar shows:
    // two clients watching one browser is `viewers: 2`, not two instances.
    registry.attachViewer?.(entry.id)
    // Both transports close, and whichever goes first must not decrement twice.
    let released = false
    const release = () => {
      sessions.delete(bridge)
      if (released) return
      released = true
      registry.detachViewer?.(entry.id)
    }
    socket.once('close', release)
    tcp.once('close', release)
  }

  // v1-compatible single-panel route: the first instance in the table.
  ctx.effect(() => webServer.registerUpgrade({
    path: WS_PATH,
    handler: async (req, socket, head) => {
      await handleUpgrade(req, socket, head, async () => {
        const target = await ensureLegacyInstance()
        // The legacy route never 404s: with no instance it starts one, so a
        // failure here is always "the browser could not come up" (503).
        if (target.error !== undefined) {
          log('warn', `desktop-vnc: refusing websocket: ${target.error}`)
          return { error: target.error, status: 503 }
        }
        return { entry: target.entry }
      })
    },
  }))

  // Per-instance routes are registered and released as instances come and go,
  // because an upgrade route is matched by exact path only — there is no prefix
  // form — while ids are minted at runtime.
  const upgradeDisposers = new Map()

  /**
   * Register the exact upgrade route for one instance.
   *
   * Upgrade routes have no prefix form in the host web server (dispatch is an exact
   * `Map.get` on the pathname), so each instance needs its own route. They are
   * added on create and removed on close, which also keeps a closed instance from
   * answering on its old path.
   *
   * @param {string} id the instance whose route to add.
   */
  const mountInstanceUpgrade = (id) => {
    if (upgradeDisposers.has(id)) return
    const path = instanceWsPath(id)
    // Kept here as well as handed to the effect: closing one instance must release
    // its route immediately, not only when the whole plugin unloads.
    let disposeRoute = null
    try {
      ctx.effect(() => {
        disposeRoute = webServer.registerUpgrade({
          path,
          handler: (req, socket, head) => handleUpgrade(req, socket, head, async () => {
            const entry = registry.get(id)
            return entry === undefined
              ? { error: `no such browser instance: ${id}`, status: 404 }
              : { entry }
          }),
        })
        return disposeRoute
      })
      upgradeDisposers.set(id, () => {
        try {
          disposeRoute?.()
        } catch {
          // Already released.
        }
      })
    } catch (error) {
      log('warn', `desktop-vnc: cannot mount the upgrade route for ${id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Remove one instance's upgrade route once it is closed. */
  const unmountInstanceUpgrade = (id) => {
    const dispose = upgradeDisposers.get(id)
    if (dispose === undefined) return
    upgradeDisposers.delete(id)
    dispose()
  }

  // The registry reports every close, whichever path caused it (an explicit
  // DELETE, a disposed session, or unload), so the route is released exactly once.
  registry.subscribeClose?.(unmountInstanceUpgrade)

  /**
   * The registry's create, with this plugin's route bookkeeping around it.
   *
   * Every instance that appears gets its own WS upgrade route, and the registry's
   * close hook takes it away again. Wrapping here (rather than teaching the
   * registry about routes) keeps the table free of web-server concerns.
   *
   * @param {{ownerSessionId?: string|null}} [options] the owning session.
   * @returns {{id: string, state: 'starting'}} the new instance's address.
   */
  const createInstance = (options) => {
    const created = registry.create(options)
    mountInstanceUpgrade(created.id)
    return created
  }

  // --- 4.6 agent tools -------------------------------------------------------
  // `tools` is optional: a profile can mount this plugin for its panel alone, and
  // a deployment without the tool registry must still get the routes. Injection is
  // therefore requested here rather than declared in `inject`, so an absent service
  // simply means no tools instead of an unmounted plugin. The method guard is the
  // same one the `session/disposed` wiring above uses, so a duck-typed Host context
  // without the registry still mounts the routes.
  //
  // The tools drive the same table the routes do — never the HTTP endpoints — and
  // create goes through `createInstance` so a tool-created instance also gets its
  // own viewer route.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolCtx) => {
      for (const definition of browserInstanceTools({
        list: () => registry.list(),
        create: (options) => createInstance(options),
        close: (id) => registry.close(id),
      })) {
        toolCtx.tools.register(definition)
      }
    })
  }

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

  // Every instance is its own effect: closing one stops exactly the Xephyr/Xvfb,
  // Chromium and x11vnc pids that instance recorded (never by name) and removes
  // its own profile directory. Unload therefore closes the whole table.
  ctx.effect(() => () => {
    void Promise.resolve(registry.disposeAll?.()).catch(() => {})
  })
}

/**
 * Read one JSON request body.
 *
 * Bounded on purpose: a request body is the only unbounded input on these routes,
 * and an instance create carries at most an owner id.
 *
 * @param {object} req the request stream.
 * @param {number} [limit] byte cap.
 * @returns {Promise<unknown>} the parsed body, `{}` when empty.
 */
async function readJsonBody(req, limit = 64 * 1024) {
  let body = ''
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    body += chunk
  }
  if (body.length === 0) return {}
  return JSON.parse(body)
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
