/**
 * @yiln-dsh/dsh-plugin-web-browser — Host half.
 *
 * Drives a server-side Chromium (playwright-core) and streams its frames to
 * the Web GUI. Because the DSH host and the operator's browser are on
 * different networks, the browser itself must run where DSH runs: this plugin
 * opens pages inside the host's network, captures frames via CDP
 * `Page.startScreencast`, pushes JPEG frames over a WebSocket, and injects
 * mouse / keyboard / wheel input back into the real page.
 *
 * Security posture: scheme allowlist (http/https, optional file), optional
 * host allowlist, and private-network access is permitted by default because
 * reaching intranet content is the whole point of this panel.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'

export const name = 'web-browser'
export const inject = ['webServer', 'agents']

const API_PREFIX = '/_dsh/web-browser'
const WS_PATH = `${API_PREFIX}/ws`

// about: is allowed only for about:blank (the standard new-tab page), which
// loads no network content.
const SCHEMES_ALLOWED = ['http:', 'https:', 'file:', 'about:']
const MAX_TABS_PER_SESSION = 12
const MAX_FRAME_QUEUE = 64 // drop frames when the client is slower than Chromium
const SCREENCAST_QUALITY = 60
const SCREENCAST_MAX_WIDTH = 1280
const SCREENCAST_MAX_HEIGHT = 900
const IDLE_RECLAIM_MS = 10 * 60 * 1000

/** Well-known Chromium-family locations per platform, most stable first. */
const KNOWN_LOCATIONS = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  linux: [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

async function readJson(req, limit = 262144) {
  let body = ''
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    body += chunk
  }
  if (body.length === 0) return {}
  const value = JSON.parse(body)
  if (value === null || typeof value !== 'object') throw new Error('request body must be an object')
  return value
}

function rejectUpgrade(socket, status, reason) {
  const body = `${reason}\n`
  socket.end([
    `HTTP/1.1 ${status} ${reason}`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body,
  ].join('\r\n'))
}

/** True when the host is one of the configured allowlisted hosts (or the list is empty). */
function hostAllowed(hostname, allowedHosts) {
  if (allowedHosts.length === 0) return true
  const host = String(hostname || '').toLowerCase()
  for (const entry of allowedHosts) {
    const pattern = String(entry).toLowerCase()
    if (pattern === host) return true
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1)
      if (host.endsWith(suffix)) return true
    }
  }
  return false
}

export function requireLiveBrowserSession(agents, rawSessionId) {
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : ''
  if (sessionId === '') throw new Error('sessionId is required')
  if (typeof agents?.get !== 'function' || agents.get(sessionId) === undefined) {
    throw new Error('session is no longer live')
  }
  return sessionId
}

export function apply(ctx, config = {}) {
  const webServer = ctx.get('webServer')
  const agents = ctx.get('agents')
  if (webServer === undefined || agents === undefined) return
  const allowedHosts = Array.isArray(config.allowedHosts) ? config.allowedHosts.map(String) : []
  const allowPrivateNetwork = config.allowPrivateNetwork !== false
  const allowFile = config.allowFile === true
  const schemes = allowFile
    ? SCHEMES_ALLOWED
    : SCHEMES_ALLOWED.filter((scheme) => scheme !== 'file:')

  const wss = new WebSocketServer({ noServer: true })

  /** Map<live sessionId, BrowserRecord> */
  const browsers = new Map()
  let nextTabId = 0

  /** Lazy playwright-core import so composing the plugin costs nothing until a browser is needed. */
  let playwrightPromise = null
  const loadPlaywright = () => {
    if (playwrightPromise === null) {
      playwrightPromise = import('playwright-core').catch((error) => {
        playwrightPromise = null
        throw new Error(`playwright-core unavailable: ${error && error.message ? error.message : String(error)}`)
      })
    }
    return playwrightPromise
  }

  const resolveExecutable = () => {
    const configured = typeof config.executablePath === 'string' && config.executablePath.length > 0
      ? config.executablePath
      : undefined
    if (configured !== undefined) return configured
    const fromEnv = process.env.DSH_BROWSER_EXECUTABLE
    if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
    for (const candidate of KNOWN_LOCATIONS[process.platform] || []) {
      if (existsSync(candidate)) return candidate
    }
    return undefined
  }

  const validateUrl = (raw) => {
    if (typeof raw !== 'string' || raw.trim() === '') throw new Error('missing url')
    const input = raw.trim()
    let url
    try {
      url = new URL(input)
    } catch (_e) {
      throw new Error('invalid URL')
    }
    if (schemes.indexOf(url.protocol) < 0) throw new Error('scheme not allowed')
    if (url.protocol === 'about:') {
      // Only about:blank is acceptable as a new-tab page; never expose
      // browser internal pages (about:config, about:flags, ...).
      if (url.href !== 'about:blank') throw new Error('scheme not allowed')
      return url
    }
    if (url.protocol === 'file:') {
      if (!allowFile) throw new Error('file scheme not allowed')
      return url
    }
    const hostname = url.hostname
    if (hostname === '') throw new Error('missing host')
    if (!hostAllowed(hostname, allowedHosts)) throw new Error('host not allowed')
    if (!allowPrivateNetwork && isPrivateHost(hostname)) throw new Error('private network not allowed')
    return url
  }

  const isPrivateHost = (hostname) => {
    const host = String(hostname).toLowerCase()
    if (host === 'localhost' || host === 'localhost.localdomain' || host.endsWith('.local')) return true
    const ip = host
    const parts = ip.split('.').map(Number)
    if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
      const [a, b] = parts
      if (a === 10) return true
      if (a === 172 && b >= 16 && b <= 31) return true
      if (a === 192 && b === 168) return true
      if (a === 127) return true
      if (a === 169 && b === 254) return true
    }
    return false
  }

  const pageTitle = async (page) => {
    try {
      return await page.title()
    } catch (_e) {
      return ''
    }
  }

  const tabSnapshot = async (tab) => ({
    id: tab.id,
    url: tab.page.url(),
    title: tab.title,
    active: tab.active,
  })

  const recordSnapshot = async (record) => ({
    activeTabId: record.activeTab === null ? null : record.activeTab.id,
    tabs: await Promise.all(record.tabs.map(tabSnapshot)),
  })

  /** Attach CDP screencast and forward frames to every socket on this record. */
  const attachScreencast = async (record, tab) => {
    if (tab.cdp !== null) return
    const cdp = await tab.page.context().newCDPSession(tab.page)
    tab.cdp = cdp
    let pending = 0
    cdp.on('Page.screencastFrame', (message) => {
      if (record.activeTab !== tab) {
        cdp.send('Page.screencastFrameAck', { sessionId: message.sessionId }).catch(() => {})
        return
      }
      if (pending >= MAX_FRAME_QUEUE) {
        cdp.send('Page.screencastFrameAck', { sessionId: message.sessionId }).catch(() => {})
        return
      }
      pending += 1
      const buf = Buffer.from(message.data, 'base64')
      for (const socket of record.sockets) {
        if (socket.readyState === WebSocket.OPEN) socket.send(buf)
      }
      // Ack after forwarding so Chromium continues producing frames.
      cdp.send('Page.screencastFrameAck', { sessionId: message.sessionId })
        .catch(() => {})
        .finally(() => { pending -= 1 })
    })
    cdp.on('Page.frameNavigated', () => {
      void tab.page.title().then((title) => {
        tab.title = title || tab.page.url()
        void tabSnapshot(tab).then((snapshot) => {
          broadcast(record, { type: 'tab', tab: snapshot })
        }).catch(() => {})
      }).catch(() => {})
    })
    await cdp.send('Page.enable').catch(() => {})
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: SCREENCAST_QUALITY,
      maxWidth: SCREENCAST_MAX_WIDTH,
      maxHeight: SCREENCAST_MAX_HEIGHT,
      everyNthFrame: 1,
    }).catch((error) => {
      tab.cdp = null
      throw new Error(`screencast failed: ${error && error.message ? error.message : String(error)}`)
    })
  }

  const stopScreencast = async (tab) => {
    if (tab.cdp === null) return
    const cdp = tab.cdp
    tab.cdp = null
    try {
      await cdp.send('Page.stopScreencast')
    } catch (_e) { /* already stopped */ }
    try {
      await cdp.detach()
    } catch (_e) { /* already detached */ }
  }

  const broadcast = (record, value) => {
    const data = JSON.stringify(value)
    for (const socket of record.sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data)
    }
  }

  const sendTo = (socket, value) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
  }

  const broadcastLoading = (record, tab, loading) => {
    broadcast(record, { type: 'loading', tabId: tab.id, loading })
  }

  const createBrowserRecord = (key) => {
    const record = {
      key,
      browser: null,
      context: null,
      tabs: [],
      activeTab: null,
      sockets: new Set(),
      launching: null,
      reclaimTimer: null,
      inputChain: Promise.resolve(),
    }
    record.reclaim = () => {
      record.reclaimTimer = setTimeout(() => {
        if (record.tabs.length === 0 && record.sockets.size === 0) {
          void closeRecord(record).catch((error) => {
            ctx.logger?.warn?.('web-browser idle reclaim failed: %s', error && error.message ? error.message : String(error))
          })
        }
      }, IDLE_RECLAIM_MS)
      if (typeof record.reclaimTimer.unref === 'function') record.reclaimTimer.unref()
    }
    record.reclaim()
    return record
  }

  const ensureBrowser = async (record) => {
    if (record.browser !== null) return
    if (record.launching !== null) return record.launching
    record.launching = (async () => {
      const { chromium } = await loadPlaywright()
      const privateHome = mkdtempSync(join(tmpdir(), 'dsh-web-browser-'))
      const executablePath = resolveExecutable()
      const launchOptions = {
        headless: true,
        env: buildLaunchEnv(process.env, privateHome),
        ...(executablePath !== undefined ? { executablePath } : {}),
      }
      try {
        const browser = await chromium.launch(launchOptions)
        record.browser = browser
        record.privateHome = privateHome
        record.context = await browser.newContext({
          viewport: { width: SCREENCAST_MAX_WIDTH, height: SCREENCAST_MAX_HEIGHT },
        })
      } catch (error) {
        rmSync(privateHome, { recursive: true, force: true })
        throw new Error(`browser launch failed: ${error && error.message ? error.message : String(error)}`)
      }
    })()
    try {
      await record.launching
    } finally {
      record.launching = null
    }
  }

  const buildLaunchEnv = (base, privateHome) => {
    const env = {}
    for (const [key, value] of Object.entries(base)) {
      if (value !== undefined) env[key] = value
    }
    env.HOME = privateHome
    env.XDG_CONFIG_HOME = join(privateHome, '.config')
    env.XDG_CACHE_HOME = join(privateHome, '.cache')
    env.XDG_DATA_HOME = join(privateHome, '.local', 'share')
    return env
  }

  const recordFor = (sessionId) => {
    const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : 'default'
    let record = browsers.get(key)
    if (record === undefined) {
      record = createBrowserRecord(key)
      browsers.set(key, record)
    }
    return record
  }

  const closeRecord = async (record) => {
    if (record.reclaimTimer !== null) clearTimeout(record.reclaimTimer)
    record.reclaimTimer = null
    for (const socket of record.sockets) socket.terminate()
    record.sockets.clear()
    for (const tab of record.tabs) await stopScreencast(tab).catch(() => {})
    record.tabs = []
    record.activeTab = null
    const browser = record.browser
    record.browser = null
    record.context = null
    if (browser !== null) {
      try {
        await browser.close()
      } catch (_e) { /* already closed */ }
    }
    if (record.privateHome !== undefined) {
      rmSync(record.privateHome, { recursive: true, force: true })
      record.privateHome = undefined
    }
    if (browsers.get(record.key) === record) browsers.delete(record.key)
  }

  const openTab = async (record, rawUrl) => {
    if (record.tabs.length >= MAX_TABS_PER_SESSION) throw new Error('too many tabs')
    const url = validateUrl(rawUrl)
    await ensureBrowser(record)
    clearTimeout(record.reclaimTimer)
    record.reclaimTimer = null
    const page = await record.context.newPage()
    const tab = { id: `tab-${++nextTabId}`, page, cdp: null, title: '', active: false }
    record.tabs.push(tab)
    record.activeTab = tab
    for (const item of record.tabs) item.active = item === tab
    try {
      broadcastLoading(record, tab, true)
      await page.goto(url.href, { timeout: 30000, waitUntil: 'domcontentloaded' })
    } catch (error) {
      // Navigation errors still leave a usable page (error page); surface them softly.
      broadcast(record, { type: 'nav-error', tabId: tab.id, message: error && error.message ? error.message : String(error) })
    }
    broadcastLoading(record, tab, false)
    tab.title = await pageTitle(page) || url.href
    await attachScreencast(record, tab)
    broadcast(record, { type: 'tabs', ...await recordSnapshot(record) })
    return tab
  }

  const closeTab = async (record, id) => {
    const index = record.tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const [tab] = record.tabs.splice(index, 1)
    if (record.activeTab === tab) {
      record.activeTab = record.tabs[index] || record.tabs[index - 1] || null
    }
    if (record.activeTab !== null) {
      for (const item of record.tabs) item.active = item === record.activeTab
    }
    await stopScreencast(tab).catch(() => {})
    try {
      await tab.page.close()
    } catch (_e) { /* already closed */ }
    broadcast(record, { type: 'tabs', ...await recordSnapshot(record) })
    if (record.tabs.length === 0) record.reclaim()
  }

  const selectTab = async (record, id) => {
    const tab = record.tabs.find((item) => item.id === id)
    if (tab === undefined) throw new Error('no such tab')
    record.activeTab = tab
    for (const item of record.tabs) item.active = item === tab
    await attachScreencast(record, tab)
    broadcast(record, { type: 'tabs', ...await recordSnapshot(record) })
  }

  const navigateActive = async (record, action) => {
    const tab = record.activeTab
    if (tab === null) throw new Error('no active tab')
    broadcastLoading(record, tab, true)
    try {
      if (action === 'back') await tab.page.goBack({ timeout: 15000 })
      else if (action === 'forward') await tab.page.goForward({ timeout: 15000 })
      else if (action === 'reload') await tab.page.reload({ timeout: 15000 })
      else throw new Error('unknown navigation action')
    } finally {
      broadcastLoading(record, tab, false)
    }
    tab.title = await pageTitle(tab.page) || tab.page.url()
    broadcast(record, { type: 'tabs', ...await recordSnapshot(record) })
  }

  const gotoActive = async (record, rawUrl) => {
    const tab = record.activeTab
    if (tab === null) throw new Error('no active tab')
    const url = validateUrl(rawUrl)
    try {
      broadcastLoading(record, tab, true)
      await tab.page.goto(url.href, { timeout: 30000, waitUntil: 'domcontentloaded' })
    } catch (error) {
      broadcast(record, { type: 'nav-error', tabId: tab.id, message: error && error.message ? error.message : String(error) })
    }
    broadcastLoading(record, tab, false)
    tab.title = await pageTitle(tab.page) || url.href
    broadcast(record, { type: 'tabs', ...await recordSnapshot(record) })
  }

  /** Inject input via Playwright's high-level mouse/keyboard APIs. Playwright
   * wraps CDP internally and handles rawKeyDown, virtual key codes, modifier
   * state and click semantics, so no per-key special-casing is needed here. */
  const handleInput = async (record, message) => {
    const tab = record.activeTab
    if (tab === null) return
    const page = tab.page
    const type = message.subtype || message.type
    const x = Number(message.x)
    const y = Number(message.y)
    const key = message.key
    const text = message.text

    if (type === 'mousemove') {
      await page.mouse.move(x, y).catch(() => {})
    } else if (type === 'mousedown' || type === 'mouseup') {
      const button = message.button === 'right' ? 'right' : (message.button === 'middle' ? 'middle' : 'left')
      if (type === 'mousedown') {
        await page.mouse.move(x, y).catch(() => {})
        await page.mouse.down({ button, clickCount: Number(message.clickCount) || 1 }).catch(() => {})
      } else {
        await page.mouse.up({ button, clickCount: Number(message.clickCount) || 1 }).catch(() => {})
      }
    } else if (type === 'wheel') {
      await page.mouse.wheel(Number(message.deltaX) || 0, Number(message.deltaY) || 0).catch(() => {})
    } else if (type === 'keydown') {
      // Printable characters insert text directly (also handles CJK/IME);
      // control and modifier keys go through keyboard.down so Playwright
      // maintains modifier state (Ctrl+C etc. compose correctly).
      if (text !== undefined && text !== '') {
        await page.keyboard.insertText(text).catch(() => {})
      } else if (typeof key === 'string' && key.length > 0) {
        await page.keyboard.down(key).catch(() => {})
      }
    } else if (type === 'keyup') {
      if (typeof key === 'string' && key.length > 0) {
        await page.keyboard.up(key).catch(() => {})
      }
    }
  }

  const attachSocket = (record, socket) => {
    record.sockets.add(socket)
    clearTimeout(record.reclaimTimer)
    record.reclaimTimer = null
    sendTo(socket, { type: 'ready' })
    void recordSnapshot(record).then((snapshot) => sendTo(socket, { type: 'tabs', ...snapshot })).catch(() => {})

    socket.on('message', (raw) => {
      let message
      try {
        message = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'))
      } catch (_e) {
        sendTo(socket, { type: 'error', message: 'invalid websocket message' })
        return
      }
      if (!message || typeof message.type !== 'string') return
      if (message.type === 'input') {
        // Serialize input events: Playwright's mouse/keyboard are not
        // concurrency-safe, and mousedown/mouseup arriving close together
        // must execute in order or the click is lost.
        record.inputChain = record.inputChain
          .then(() => handleInput(record, message))
          .catch((error) => sendTo(socket, { type: 'error', message: errorMessage(error) }))
      } else if (message.type === 'open') {
        void openTab(record, message.url)
          .then(() => {})
          .catch((error) => sendTo(socket, { type: 'error', message: errorMessage(error) }))
      } else if (message.type === 'goto') {
        void gotoActive(record, message.url)
          .catch((error) => sendTo(socket, { type: 'error', message: errorMessage(error) }))
      } else if (message.type === 'close-tab') {
        void closeTab(record, message.id).catch((error) => sendTo(socket, { type: 'error', message: errorMessage(error) }))
      } else if (message.type === 'select-tab') {
        void selectTab(record, message.id).catch((error) => sendTo(socket, { type: 'error', message: errorMessage(error) }))
      } else if (message.type === 'navigate') {
        void navigateActive(record, message.action)
          .catch((error) => sendTo(socket, { type: 'error', message: errorMessage(error) }))
      }
    })
    socket.on('close', () => record.sockets.delete(socket))
    socket.on('error', () => record.sockets.delete(socket))
  }

  const errorMessage = (error) => (error && typeof error.message === 'string' ? error.message : String(error))

  const route = (path, handler) => {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const args = await readJson(req)
          const result = await handler(args)
          sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            error: error && typeof error.message === 'string' ? error.message : String(error),
          })
        }
      },
    }), `web-browser route ${path}`)
  }

  route(`${API_PREFIX}/open`, async (args) => {
    const sessionId = requireLiveBrowserSession(agents, args.sessionId)
    const record = recordFor(sessionId)
    const tab = await openTab(record, args.url)
    return { tab: await tabSnapshot(tab), ...await recordSnapshot(record) }
  })

  route(`${API_PREFIX}/list`, async (args) => {
    const sessionId = requireLiveBrowserSession(agents, args.sessionId)
    const record = browsers.get(sessionId)
    if (record === undefined) return { tabs: [], activeTabId: null }
    return await recordSnapshot(record)
  })

  route(`${API_PREFIX}/close`, async (args) => {
    const sessionId = requireLiveBrowserSession(agents, args.sessionId)
    const record = browsers.get(sessionId)
    if (record !== undefined) await closeRecord(record)
    return { closed: true }
  })

  ctx.effect(() => webServer.registerUpgrade({
    path: WS_PATH,
    handler: (req, socket, head) => {
      let sessionId
      try {
        url = new URL(req.url || '', 'http://127.0.0.1')
        sessionId = requireLiveBrowserSession(agents, url.searchParams.get('sessionId'))
      } catch (error) {
        rejectUpgrade(socket, 404, error && typeof error.message === 'string' ? error.message : 'Not Found')
        return
      }
      const record = recordFor(sessionId)
      wss.handleUpgrade(req, socket, head, (websocket) => attachSocket(record, websocket))
    },
  }), `web-browser WebSocket ${WS_PATH}`)

  ctx.effect(() => async () => {
    for (const record of browsers.values()) {
      if (record.reclaimTimer !== null) clearTimeout(record.reclaimTimer)
      for (const socket of record.sockets) socket.terminate()
      record.sockets.clear()
      for (const tab of record.tabs) await stopScreencast(tab).catch(() => {})
      const browser = record.browser
      record.browser = null
      record.context = null
      if (browser !== null) {
        try {
          await browser.close()
        } catch (_e) { /* already closed */ }
      }
      if (record.privateHome !== undefined) {
        rmSync(record.privateHome, { recursive: true, force: true })
        record.privateHome = undefined
      }
    }
    browsers.clear()
    await new Promise((resolve) => wss.close(() => resolve()))
  }, 'web-browser Chromium and WebSocket cleanup')
}
