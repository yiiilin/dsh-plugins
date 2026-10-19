/**
 * dsh-plugin desktop-vnc — browser bundle (static DSH client module).
 *
 * Contributes the Desktop VNC page to the official right Sidebar: one tab kind
 * (`ctx.sidebarRightTabs`) and its body in the `sidebar.right.pane.tab` seat.
 * The product owns the column, its panes, and its tab strip; this bundle adds
 * only the tab kind, the page body, and the guide capsule that opens it.
 *
 * The body embeds noVNC's `core/rfb.js`, which the Host half serves verbatim
 * from `src/desktop-vnc/novnc/` under `/_dsh/desktop-vnc/asset`. The page is a
 * thin client: it never spawns x11vnc itself. It connects as soon as the tab is
 * revealed, because revealing the tab *is* the user asking to see the desktop
 * (contract §8.1). The Host remains the thing that starts x11vnc/Xephyr on
 * demand, and the automation is bounded: one automatic attempt per reveal plus
 * a single retry, so a missing x11vnc cannot make the page hammer the Host.
 *
 * Connection state is a small reducer ({@link reduceVncState}) so the page's
 * transitions are testable without a browser; connect/disconnect of the real
 * RFB object and the teardown that keeps connections from leaking live in the
 * component effect below.
 */
window.__ModuleLoader__.load({
  id: '@yiln-dsh/dsh-desktop-vnc',
  factory: (require) => {
    const React = require('react')

    const LOCALE_NS = 'desktop-vnc'
    /** Tab-system identity: unique across every registration in the tab system. */
    const VNC_TAB_ID = '@yiln-dsh/dsh-desktop-vnc'
    /** The tab type discriminator, also the pane-body registration key. */
    const VNC_TAB_KIND = 'desktop-vnc'
    /** Host route prefix (contract §1); no other prefix may be used. */
    const ASSET_BASE = '/_dsh/desktop-vnc/asset'
    /**
     * noVNC's RFB entry module. The Host serves only `core/**` and `vendor/**`,
     * and noVNC resolves its own `./util/*.js` imports relatively, so the loader
     * URL must be this exact path — not an `app/` bundle.
     */
    const RFB_MODULE_PATH = `${ASSET_BASE}/core/rfb.js`
    const WS_PATH = '/_dsh/desktop-vnc/ws'
    const STATE_PATH = '/_dsh/desktop-vnc/state'

    const ZH_DICT = {
      'title': '桌面 VNC',
      'guide.description': '查看并操作本机 X 桌面',
      'action.connect': '连接桌面',
      'action.reconnect': '重新连接',
      'action.disconnect': '断开',
      'action.fullscreen': '全屏',
      'action.exitFullscreen': '退出全屏',
      'action.scale': '自适应缩放',
      'action.readOnly': '只读',
      'action.clipboard': '粘贴剪贴板',
      'status.idle': '未连接',
      'status.loading': '正在加载 VNC 客户端…',
      'status.connecting': '正在连接桌面…',
      'status.autoConnecting': '自动连接中…',
      'status.connected': '已连接',
      'status.disconnected': '连接已断开',
      'status.error': '连接失败',
      'password.prompt': '该桌面需要密码',
      'password.placeholder': '密码',
      'password.submit': '确定',
      'password.cancel': '取消',
      'error.hint': '请确认 x11vnc 已安装且端口未被占用',
      'error.asset': '无法加载 VNC 客户端资源',
      'error.state': '无法读取桌面服务状态',
      'clipboard.pasted': '已粘贴剪贴板内容',
      'clipboard.unavailable': '无法读取本机剪贴板',
    }
    const EN_DICT = {
      'title': 'Desktop VNC',
      'guide.description': 'View and control the local X desktop',
      'action.connect': 'Connect desktop',
      'action.reconnect': 'Reconnect',
      'action.disconnect': 'Disconnect',
      'action.fullscreen': 'Fullscreen',
      'action.exitFullscreen': 'Exit fullscreen',
      'action.scale': 'Scale to fit',
      'action.readOnly': 'Read-only',
      'action.clipboard': 'Paste clipboard',
      'status.idle': 'Not connected',
      'status.loading': 'Loading VNC client…',
      'status.connecting': 'Connecting to desktop…',
      'status.autoConnecting': 'Connecting automatically…',
      'status.connected': 'Connected',
      'status.disconnected': 'Disconnected',
      'status.error': 'Connection failed',
      'password.prompt': 'This desktop requires a password',
      'password.placeholder': 'Password',
      'password.submit': 'Submit',
      'password.cancel': 'Cancel',
      'error.hint': 'Check that x11vnc is installed and the port is free',
      'error.asset': 'Could not load the VNC client assets',
      'error.state': 'Could not read the desktop service state',
      'clipboard.pasted': 'Clipboard content pasted',
      'clipboard.unavailable': 'Could not read the local clipboard',
    }

    // ===== connection state machine =====

    /** Every state the page can be in; each one has a `status.<state>` label. */
    const VNC_STATES = ['idle', 'loading', 'connecting', 'connected', 'disconnected', 'error']
    /** First mount is `idle`: the page connects only once the pane shows it. */
    const VNC_INITIAL_STATE = 'idle'
    /**
     * How many extra automatic attempts one reveal may make after the first.
     * Exceeding it parks the page in `error` for the user's own Reconnect click:
     * an automatic loop against a missing x11vnc or Xephyr would otherwise
     * hammer the Host (contract §8.1).
     */
    const AUTO_RETRY_LIMIT = 1
    /**
     * Pure transition table: state → event → next state. An event with no entry
     * leaves the state unchanged, so a late RFB callback cannot resurrect a
     * page the user already left.
     *
     * - `connect`  — the user asked to connect (idle/error/disconnected only).
     * - `ready`    — the RFB module loaded and the socket is being opened.
     * - `connected`— the RFB handshake completed.
     * - `closed`   — the socket closed or the viewer disconnected on purpose.
     * - `failed`   — the RFB reported a security/protocol failure.
     * - `lost`     — the Host connection generation was replaced, so the
     *                bridge this socket used is gone.
     */
    const VNC_STATE_TRANSITIONS = {
      idle: { connect: 'loading', lost: 'idle' },
      loading: { ready: 'connecting', closed: 'disconnected', failed: 'error', lost: 'error' },
      connecting: { connected: 'connected', closed: 'disconnected', failed: 'error', lost: 'error' },
      connected: { closed: 'disconnected', failed: 'error', lost: 'disconnected' },
      disconnected: { connect: 'loading', lost: 'disconnected' },
      error: { connect: 'loading' },
    }

    /** @returns whether `state` is one of the six known page states. */
    function isVncState(state) {
      return VNC_STATES.indexOf(state) !== -1
    }

    /**
     * Advance the page state. Unknown states/events are inert rather than
     * throwing: this runs from socket callbacks that may arrive after teardown.
     * @param state - current page state.
     * @param event - one of the events documented on the transition table.
     * @returns the next state, or `state` when the event does not apply.
     */
    function reduceVncState(state, event) {
      const row = Object.prototype.hasOwnProperty.call(VNC_STATE_TRANSITIONS, state)
        ? VNC_STATE_TRANSITIONS[state]
        : undefined
      const next = row === undefined ? undefined : row[event]
      return typeof next === 'string' ? next : state
    }

    /**
     * The locale key of a state's status line.
     * @param state - current page state.
     * @returns a key present in both dictionaries.
     */
    function statusKeyFor(state) {
      return `status.${isVncState(state) ? state : 'error'}`
    }

    /**
     * What the status line shows for a page that is connecting without the user
     * having pressed anything, so the automatic attempt is not mistaken for a
     * manual one (contract §8.2).
     * @param state - current page state.
     * @param automatic - whether the in-flight attempt was started automatically.
     * @returns `status.autoConnecting` while an automatic attempt runs, else the
     *          state's own ordinary label.
     */
    function connectionStatusKeyFor(state, automatic) {
      if (automatic === true && (state === 'loading' || state === 'connecting')) return 'status.autoConnecting'
      return statusKeyFor(state)
    }

    /**
     * Decide whether the page may start another attempt without a user gesture.
     *
     * This is the whole retry policy in one pure function so the bound is
     * provable, and it separates the two ways an automatic attempt can happen:
     *
     * - A **fresh reveal** (`revealFresh`) is the user opening or re-opening the
     *   tab. That is the request the whole feature answers (contract §8.1), so it
     *   always starts, whatever startable state the body was left in.
     * - A **retry** happens while the tab stays shown, and only after a failure:
     *   at most {@link AUTO_RETRY_LIMIT} of those follow the first attempt. Past
     *   that the error state waits for the user's own Reconnect button, so a
     *   missing x11vnc or Xephyr cannot make the page hammer the Host.
     *
     * A session that connected and then dropped is deliberately not retried: a
     * settled disconnect is not resource jitter, and silently re-opening a socket
     * the server just closed would fight the server.
     * @param input - visibility, state, automatic attempts spent, and whether this
     *                is the first attempt of a fresh reveal.
     * @returns `true` when an automatic `connect` may be issued now.
     */
    function shouldAutoConnect(input) {
      if (input?.visible !== true) return false
      if (isVncState(input?.state) !== true) return false
      if (input.state !== 'idle' && input.state !== 'disconnected' && input.state !== 'error') return false
      if (input.revealFresh === true) return true
      if (input.state !== 'error') return false
      const attempts = typeof input.attempts === 'number' && input.attempts > 0 ? input.attempts : 0
      return attempts <= AUTO_RETRY_LIMIT
    }

    /**
     * Decide what a closed RFB socket means for the page.
     * @param input - the three facts that distinguish the cases.
     * @returns `ignore` when the close is our own teardown (or a superseded
     *          socket), `disconnected` after a session that had connected, and
     *          `error` when the connection never came up.
     */
    function classifyDisconnect(input) {
      if (input?.intentional === true || input?.superseded === true) return 'ignore'
      return input?.connectedOnce === true ? 'disconnected' : 'error'
    }

    // ===== URL helpers =====

    /**
     * The VNC WebSocket URL for the page's origin.
     * @param location - `window.location` (or any `{protocol, host}`).
     * @param path - the Host upgrade path.
     * @returns `ws(s)://<host><path>`, following the page's own scheme.
     */
    function wsUrlFor(location, path) {
      const protocol = location?.protocol === 'https:' ? 'wss:' : 'ws:'
      const host = typeof location?.host === 'string' && location.host !== '' ? location.host : 'localhost'
      return `${protocol}//${host}${path}`
    }

    /** @returns the absolute URL of noVNC's RFB module, as served by the Host. */
    function rfbModuleUrl() {
      return RFB_MODULE_PATH
    }

    // ===== locale fallback =====

    function applyParams(template, params) {
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    // ===== icons (original paths; not copied from another plugin) =====

    /**
     * Draw one of this page's glyphs.
     * @param name - key into {@link ICON_PATHS}.
     * @param size - pixel box; the viewBox is always 24x24.
     */
    function icon(name, size) {
      const paths = ICON_PATHS[name] ?? []
      return React.createElement('svg', {
        viewBox: '0 0 24 24',
        width: size || 16,
        height: size || 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      }, paths.map(([tag, props], index) => React.createElement(tag, { key: index, ...props })))
    }

    const ICON_PATHS = {
      // Toolbar actions.
      connect: [['path', { d: 'M8 5.5v13l11-6.5z' }]],
      disconnect: [['path', { d: 'M7 7l10 10' }], ['path', { d: 'M17 7L7 17' }]],
      reconnect: [
        ['path', { d: 'M20 12a8 8 0 1 1-2.4-5.7' }],
        ['path', { d: 'M20 4.5V10h-5.5' }],
      ],
      scale: [
        ['path', { d: 'M4 9V4h5' }],
        ['path', { d: 'M20 15v5h-5' }],
        ['path', { d: 'M4 4l6.5 6.5' }],
        ['path', { d: 'M20 20l-6.5-6.5' }],
      ],
      readOnly: [
        ['path', { d: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z' }],
        ['circle', { cx: '12', cy: '12', r: '2.6' }],
      ],
      clipboard: [
        ['rect', { x: '5', y: '4.5', width: '14', height: '16', rx: '2' }],
        ['path', { d: 'M9 4.5h6v3H9z' }],
        ['path', { d: 'M8.5 12h7' }],
        ['path', { d: 'M8.5 15.5h5' }],
      ],
      expand: [
        ['path', { d: 'M4 9V4h5' }],
        ['path', { d: 'M15 4h5v5' }],
        ['path', { d: 'M20 15v5h-5' }],
        ['path', { d: 'M9 20H4v-5' }],
      ],
      collapse: [
        ['path', { d: 'M9 4v5H4' }],
        ['path', { d: 'M20 9h-5V4' }],
        ['path', { d: 'M15 20v-5h5' }],
        ['path', { d: 'M4 15h5v5' }],
      ],
      // Guide capsule: a monitor with a pointer — this module's own mark.
      tab: [
        ['rect', { x: '2.5', y: '4', width: '19', height: '12.5', rx: '2' }],
        ['path', { d: 'M9 20.5h6' }],
        ['path', { d: 'M12 16.5v4' }],
        ['path', { d: 'M8.5 7.5l6 2.9-2.4 1-1 2.4z' }],
      ],
    }

    /** Guide-capsule glyph; the product draws it at its own size. */
    function VncTabGlyph({ size }) {
      return icon('tab', size || 20)
    }

    // ===== stylesheet =====

    function installStyle() {
      if (typeof document === 'undefined') return () => {}
      const style = document.createElement('style')
      // Distinct identity from every other plugin's sheet in this suite.
      style.id = 'dsh-plugin-desktop-vnc-style'
      style.dataset.plugin = '@yiln-dsh/dsh-plugins'
      style.textContent = `
.dsh-vnc-page {
  position: relative;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f5f5f4));
  color: var(--dsw-alias-label-primary, #111827);
  font-size: 13px;
  overflow: hidden;
}
.dsh-vnc-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding: 6px 10px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
}
.dsh-vnc-status {
  flex: 1 1 auto;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--dsw-alias-label-secondary, #57534e);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-vnc-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary, #9ca3af);
}
.dsh-vnc-dot[data-state="loading"],
.dsh-vnc-dot[data-state="connecting"] {
  background: var(--dsw-alias-state-warn-primary, #d97706);
  animation: dsh-vnc-pulse 1.2s ease-in-out infinite;
}
.dsh-vnc-dot[data-state="connected"] {
  background: var(--dsw-alias-state-success-primary, #16a34a);
}
.dsh-vnc-dot[data-state="error"] {
  background: var(--dsw-alias-state-error-primary, #dc2626);
}
.dsh-vnc-dot[data-state="disconnected"] {
  background: var(--dsw-alias-state-idle-primary, #9ca3af);
}
@keyframes dsh-vnc-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.dsh-vnc-actions {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.dsh-vnc-tool {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #4b5563);
  cursor: pointer;
}
.dsh-vnc-tool:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2, #e7e5e4));
  color: var(--dsw-alias-label-primary, #111827);
}
.dsh-vnc-tool:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #2563eb));
}
.dsh-vnc-tool:disabled {
  opacity: 0.35;
  cursor: default;
}
.dsh-vnc-tool[aria-pressed="true"] {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
  color: var(--dsw-alias-brand-primary, #4f46e5);
}
.dsh-vnc-stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  background: #111318;
}
.dsh-vnc-canvas {
  position: absolute;
  inset: 0;
  min-height: 0;
}
.dsh-vnc-canvas canvas {
  outline: none;
}
.dsh-vnc-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 16px;
  box-sizing: border-box;
  text-align: center;
  background: var(--dsw-alias-bg-base, #f5f5f4);
  color: var(--dsw-alias-label-secondary, #57534e);
}
.dsh-vnc-overlay-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #111827);
}
.dsh-vnc-overlay-hint {
  max-width: 300px;
  font-size: 12px;
  line-height: 17px;
  color: var(--dsw-alias-label-secondary, #57534e);
  overflow-wrap: anywhere;
}
.dsh-vnc-primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-brand-primary, #4f46e5);
  color: var(--dsw-alias-label-primary-inverted, #ffffff);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.dsh-vnc-primary:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-accent, var(--dsw-alias-brand-primary, #4f46e5));
}
.dsh-vnc-primary:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #2563eb));
}
.dsh-vnc-primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsh-vnc-secondary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.18));
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-primary, #111827);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.dsh-vnc-secondary:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2, #e7e5e4));
}
.dsh-vnc-secondary:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #2563eb));
}
.dsh-vnc-secondary:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsh-vnc-password {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: stretch;
  width: 220px;
  max-width: 100%;
  padding: 12px;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  text-align: left;
}
.dsh-vnc-input {
  height: 28px;
  padding: 0 8px;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.18));
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-base, #ffffff);
  color: var(--dsw-alias-label-primary, #111827);
  font: inherit;
  font-size: 13px;
}
.dsh-vnc-input:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #2563eb));
}
.dsh-vnc-password-row {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.dsh-vnc-note {
  flex: 0 0 auto;
  padding: 6px 10px;
  border-top: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  color: var(--dsw-alias-label-secondary, #57534e);
  font-size: 11px;
  line-height: 15px;
}
`
      document.head.append(style)
      return () => style.remove()
    }

    // ===== noVNC loading =====

    /**
     * Resolve noVNC's `RFB` constructor once per page load.
     *
     * A failure clears the cache so a later retry can fetch again instead of
     * re-throwing a stale rejection forever.
     * @returns a promise for the RFB class.
     */
    function loadRfbModule() {
      if (rfbModulePromise === null) {
        rfbModulePromise = Promise.resolve().then(() => rfbImport(RFB_MODULE_PATH)).then((mod) => {
          const RFB = mod?.default
          if (typeof RFB !== 'function') throw new Error('noVNC core/rfb.js did not export a constructor')
          return RFB
        }, (error) => {
          rfbModulePromise = null
          throw error
        })
      }
      return rfbModulePromise
    }
    let rfbModulePromise = null
    /** The one seam a unit test may swap: a VM has no document to import from. */
    let rfbImport = (path) => import(path)

    /**
     * Replace the noVNC importer and drop the cached module. Test-only: the
     * shipped page always dynamic-imports the Host's own asset route.
     * @param importer - replacement `(path) => Promise<module>`, or a falsy
     *                   value to restore the real dynamic import.
     */
    function setRfbModuleImporter(importer) {
      rfbImport = typeof importer === 'function' ? importer : (path) => import(path)
      rfbModulePromise = null
    }

    /**
     * Read the Host's desktop-service state (contract §4.4).
     *
     * The page treats this as the read-through probe for the "desktop service is
     * unreachable" diagnosis: if the state cannot be read, telling the user to
     * check x11vnc would be guesswork, so the page reports `error.state` instead.
     * @returns the parsed state document.
     */
    async function readDesktopState(fetchImpl) {
      const response = await fetchImpl(STATE_PATH, { headers: { accept: 'application/json' } })
      if (response?.ok !== true) throw new Error(`desktop-vnc state returned HTTP ${response?.status}`)
      const state = await response.json()
      if (state === null || typeof state !== 'object') throw new Error('desktop-vnc state was not an object')
      return state
    }

    /**
     * Disconnect a live viewer exactly once and drop the page's handle to it.
     * Nulling the ref first makes the RFB's own `disconnect` event a no-op, so a
     * deliberate teardown never reads as an unexpected failure.
     */
    function teardownRfb(rfbRef) {
      const rfb = rfbRef.current
      rfbRef.current = null
      if (rfb === null || rfb === undefined || typeof rfb.disconnect !== 'function') return
      try {
        rfb.disconnect()
      } catch (error) {
        console.warn('desktop-vnc: disconnecting the viewer failed', error)
      }
    }

    // ===== page component =====

    /** Placeholder tab reader for a render outside the seat (unit tests). */
    function noTabInfo() {
      return null
    }

    function createVncPage(t, connection) {
      return function VncPage(props) {
        const [state, setState] = React.useState(VNC_INITIAL_STATE)
        const [scale, setScale] = React.useState(true)
        const [viewOnly, setViewOnly] = React.useState(false)
        const [prompt, setPrompt] = React.useState(null)
        const [password, setPassword] = React.useState('')
        const [failure, setFailure] = React.useState(null)
        const [fullscreen, setFullscreen] = React.useState(false)
        const [note, setNote] = React.useState(null)

        const pageRef = React.useRef(null)
        const hostRef = React.useRef(null)
        const rfbRef = React.useRef(null)
        const passwordRef = React.useRef(null)
        const busyRef = React.useRef(false)
        /**
         * Automatic attempts spent since the current reveal. A ref, not state:
         * this is retry bookkeeping, and making it state would let the
         * auto-connect effect re-enter on its own bookkeeping update.
         */
        const autoAttemptsRef = React.useRef(0)
        /**
         * Whether the pane has already shown this body since the last hide. The
         * auto-connect effect keys off the false→true edge so a re-render while
         * visible cannot re-arm the budget. The lifetime effect resets both refs,
         * and a StrictMode re-run of that effect leaves the budget spent, so the
         * double-invocation cannot open a second automatic socket.
         */
        const revealedRef = React.useRef(false)
        /**
         * Per-session-lifetime guard: `live` and `sequence` fence late callbacks,
         * `automatic` records whether the attempt in flight was not user-started.
         */
        const lifeRef = React.useRef({ live: false, sequence: 0, connected: false, automatic: false })

        // The seat supplies this reader for every tab body; without it (a bare
        // unit render) the page simply treats itself as visible. Called
        // unconditionally so the hook order never depends on the prop.
        const useTabInfo = typeof props.useTabInfo === 'function' ? props.useTabInfo : noTabInfo
        const tabInfo = useTabInfo()
        const visible = tabInfo === null || tabInfo === undefined ? true : tabInfo?.tab?.visible !== false
        // The seat gives a tab body no session id, but it does give the tab itself, and
        // that identity changes when the pane rebinds to another session.
        const tabIdentity = tabInfo?.tab?.id ?? ''
        const sessionId = typeof props.sessionId === 'string' && props.sessionId !== ''
          ? props.sessionId
          : tabIdentity

        // One lifetime per mounted page (and per Session switch): leaving the
        // page releases the viewer, because the pane may remount the body
        // elsewhere and a stale RFB would keep the socket and its x11vnc
        // connection alive with nothing drawing it.
        React.useEffect(() => {
          lifeRef.current = { live: true, sequence: 0, connected: false, automatic: false }
          busyRef.current = false
          // A new lifetime starts with a full automatic budget. This body runs
          // once per Session (its only dependency), so a re-render cannot re-arm
          // it; StrictMode's dev double-invoke aborts the first, in-flight
          // attempt before it constructs a viewer (the await below yields), so
          // the re-armed second run still opens exactly one socket.
          autoAttemptsRef.current = 0
          revealedRef.current = false
          setState(VNC_INITIAL_STATE)
          setPrompt(null)
          setPassword('')
          setFailure(null)
          setNote(null)
          const life = lifeRef.current
          return () => {
            life.live = false
            life.sequence += 1
            busyRef.current = false
            teardownRfb(rfbRef)
          }
        }, [sessionId])

        // A new Host connection generation invalidates the bridge this socket
        // was using, so hold no viewer across it. The auto budget is exhausted in
        // the same step: a replaced generation is a deliberate host-side change,
        // not the resource jitter the one automatic retry exists for, so the page
        // waits for the user instead of racing the new bridge.
        React.useEffect(() => {
          if (typeof connection?.generation?.subscribe !== 'function') return undefined
          return connection.generation.subscribe(() => {
            teardownRfb(rfbRef)
            busyRef.current = false
            autoAttemptsRef.current = AUTO_RETRY_LIMIT + 1
            setPrompt(null)
            setFailure('error.state')
            setState((current) => reduceVncState(current, 'lost'))
          })
        }, [connection, sessionId])

        // A viewer the user cannot see must not keep the socket (and through it
        // x11vnc's client) alive: reconnecting costs one click, a leaked
        // desktop session costs the whole server's `-shared` client budget.
        //
        // The same effect owns the other half of the reveal: showing the tab is
        // the user's request to see the desktop (contract §8.1), so a revealed
        // page in a startable state connects on its own. Each reveal opens a
        // fresh automatic budget of one attempt plus {@link AUTO_RETRY_LIMIT}
        // retries; a manual attempt closes that budget so the user's own failure
        // never triggers a surprise automatic retry.
        React.useEffect(() => {
          if (!visible) {
            // Leaving the tab ends this reveal: the next one is a new user
            // request and may connect on its own again.
            revealedRef.current = false
            // Fence even an attempt that has no viewer yet — the module fetch
            // resolves after this and must not mount into a hidden pane. Bumping
            // the sequence is what makes that attempt abort at its next check.
            const life = lifeRef.current
            const hadViewer = rfbRef.current !== null
            life.sequence += 1
            life.connected = false
            busyRef.current = false
            teardownRfb(rfbRef)
            setPrompt(null)
            setFailure(null)
            if (hadViewer) {
              setState((current) => reduceVncState(current, 'closed'))
            } else {
              // An attempt fenced before it mounted anything leaves nothing to
              // report, so the page returns to its untouched look instead of a
              // "disconnected" it never reached. States that are already settled
              // when hidden are left exactly as they were.
              setState((current) => (current === 'loading' || current === 'connecting' ? VNC_INITIAL_STATE : current))
            }
            return
          }
          // A false→true edge is a fresh reveal (the user opened the tab); staying
          // visible across renders is not, or the retry bound would reset on
          // every re-render.
          const revealFresh = revealedRef.current !== true
          if (revealFresh) {
            revealedRef.current = true
            autoAttemptsRef.current = 0
          }
          if (!shouldAutoConnect({
            visible,
            state,
            revealFresh,
            attempts: autoAttemptsRef.current,
          })) return
          void startConnection({ automatic: true })
        }, [visible, state, sessionId])

        React.useEffect(() => {
          if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
          const onChange = () => setFullscreen(document.fullscreenElement !== null && document.fullscreenElement !== undefined)
          document.addEventListener('fullscreenchange', onChange)
          return () => document.removeEventListener('fullscreenchange', onChange)
        }, [sessionId])

        /**
         * Load noVNC and open one viewer. Idempotent per page lifetime: repeat
         * clicks while a connection is starting are ignored.
         * @param options - `automatic: true` marks an attempt the page started on
         *                  its own; anything else is a user gesture.
         */
        async function startConnection(options) {
          const life = lifeRef.current
          if (!life.live || busyRef.current) return
          const automatic = options?.automatic === true
          // Spending is recorded before the await so a failure cannot re-enter
          // the effect and start a second automatic attempt for the same slot. A
          // manual attempt exhausts the budget instead: the page never follows
          // the user's own click with an automatic retry.
          autoAttemptsRef.current = automatic ? autoAttemptsRef.current + 1 : AUTO_RETRY_LIMIT + 1
          life.automatic = automatic
          busyRef.current = true
          // A fresh attempt is a new session: the previous one's `connected`
          // flag must not make this attempt's early close look like a drop.
          life.connected = false
          const sequence = (life.sequence += 1)
          setFailure(null)
          setNote(null)
          setPrompt(null)
          setState(reduceVncState(VNC_INITIAL_STATE, 'connect'))

          let RFB
          try {
            RFB = await loadRfbModule()
          } catch (error) {
            console.warn('desktop-vnc: loading noVNC failed', error)
            if (life.live && sequence === life.sequence) {
              busyRef.current = false
              setFailure('error.asset')
              setState((current) => reduceVncState(current, 'failed'))
            }
            return
          }
          if (!life.live || sequence !== life.sequence || hostRef.current === null) {
            busyRef.current = false
            return
          }

          setState((current) => reduceVncState(current, 'ready'))

          // `resizeSession` stays false: the desktop is 1280x800 on :0 and the
          // sidebar must not resize the user's screen. `scaleViewport` fits the
          // frame to the pane; `credentials` only ever carries a password the
          // user already typed, so a password-protected server still raises
          // `credentialsrequired` on the first attempt.
          const credentials = typeof passwordRef.current === 'string' ? { password: passwordRef.current } : {}
          let rfb
          try {
            rfb = new RFB(hostRef.current, wsUrlFor(window.location, WS_PATH), {
              credentials,
              wsProtocols: ['binary', 'base64'],
              scaleViewport: scale,
              resizeSession: false,
              viewOnly,
            })
          } catch (error) {
            console.warn('desktop-vnc: creating the viewer failed', error)
            busyRef.current = false
            if (life.live && sequence === life.sequence) {
              setFailure('error.asset')
              setState((current) => reduceVncState(current, 'failed'))
            }
            return
          }
          rfbRef.current = rfb
          busyRef.current = false

          const current = () => life.live && sequence === life.sequence && rfbRef.current === rfb

          rfb.addEventListener('connect', () => {
            if (!current()) return
            life.connected = true
            setState((current2) => reduceVncState(current2, 'connected'))
          })
          rfb.addEventListener('disconnect', () => {
            const verdict = classifyDisconnect({
              intentional: !life.live,
              superseded: rfbRef.current !== rfb,
              connectedOnce: life.connected,
            })
            if (verdict === 'ignore') return
            rfbRef.current = null
            setPrompt(null)
            setFailure(verdict === 'error' ? 'error.hint' : null)
            setState((current2) => reduceVncState(current2, verdict === 'error' ? 'failed' : 'closed'))
            if (verdict === 'error') void diagnose()
          })
          rfb.addEventListener('credentialsrequired', (event) => {
            if (!current()) return
            const types = Array.isArray(event?.detail?.types) ? event.detail.types : ['password']
            setPrompt({ types })
          })
          rfb.addEventListener('securityfailure', () => {
            if (!current()) return
            rfbRef.current = null
            setPrompt(null)
            setFailure('error.hint')
            setState((current2) => reduceVncState(current2, 'failed'))
            teardownRfb(rfbRef)
          })
        }

        /**
         * Ask the Host whether the desktop service is reachable at all, so the
         * error state names the right cause: an unreadable state document means
         * the plugin's own routes are gone (`error.state`), while a readable one
         * with `vncRunning: false` leaves the x11vnc/port hint in place.
         */
        async function diagnose() {
          const life = lifeRef.current
          const sequence = life.sequence
          try {
            const desktop = await readDesktopState(
              typeof window !== 'undefined' && typeof window.fetch === 'function' ? window.fetch.bind(window) : fetch,
            )
            if (!life.live || sequence !== life.sequence) return
            if (desktop.vncRunning === false) setFailure('error.hint')
          } catch {
            if (!life.live || sequence !== life.sequence) return
            setFailure('error.state')
          }
        }

        function disconnect() {
          const life = lifeRef.current
          life.sequence += 1
          life.connected = false
          busyRef.current = false
          teardownRfb(rfbRef)
          setPrompt(null)
          setFailure(null)
          setState((current) => reduceVncState(current, 'closed'))
        }

        function submitPassword(event) {
          event?.preventDefault?.()
          const rfb = rfbRef.current
          passwordRef.current = password
          setPrompt(null)
          setPassword('')
          if (rfb !== null && typeof rfb.sendCredentials === 'function') rfb.sendCredentials({ password })
        }

        function cancelPassword() {
          passwordRef.current = null
          setPrompt(null)
          setPassword('')
          const life = lifeRef.current
          life.sequence += 1
          life.connected = false
          // Declining the password ends the automatic assistance: reopening the
          // prompt on its own would be a dialog the user just dismissed.
          autoAttemptsRef.current = AUTO_RETRY_LIMIT + 1
          teardownRfb(rfbRef)
          // Back to the connect button: the user declined to authenticate.
          setState(VNC_INITIAL_STATE)
        }

        function toggleScale() {
          const next = !scale
          setScale(next)
          const rfb = rfbRef.current
          if (rfb !== null) rfb.scaleViewport = next
        }

        function toggleViewOnly() {
          const next = !viewOnly
          setViewOnly(next)
          const rfb = rfbRef.current
          if (rfb !== null) rfb.viewOnly = next
        }

        function toggleFullscreen() {
          if (typeof document === 'undefined') return
          const node = pageRef.current
          if (node === null) return
          if (document.fullscreenElement !== null && document.fullscreenElement !== undefined) {
            document.exitFullscreen?.()
          } else {
            node.requestFullscreen?.()
          }
        }

        async function pasteClipboard() {
          const rfb = rfbRef.current
          if (rfb === null || viewOnly) return
          try {
            const text = await navigator.clipboard.readText()
            rfb.clipboardPasteFrom(text)
            setNote('clipboard.pasted')
          } catch {
            setNote('clipboard.unavailable')
          }
        }

        const busy = state === 'loading' || state === 'connecting'
        const connected = state === 'connected'
        const canConnect = !connected && !busy
        const automatic = lifeRef.current.automatic === true

        const statusText = t(connectionStatusKeyFor(state, automatic))
        const primaryLabel = connected ? t('action.disconnect') : t('action.connect')
        const overlayHint = state === 'idle'
          ? t('guide.description')
          : state === 'error'
            ? t(failure ?? 'error.hint')
            : null

        return React.createElement('div', {
          ref: pageRef,
          className: 'dsh-vnc-page',
          role: 'region',
          'aria-label': t('title'),
        },
        React.createElement('div', { className: 'dsh-vnc-toolbar' },
          React.createElement('span', { className: 'dsh-vnc-status' },
            React.createElement('span', { className: 'dsh-vnc-dot', 'data-state': state, 'aria-hidden': true }),
            React.createElement('span', { className: 'dsh-vnc-status-text' }, statusText)),
          React.createElement('div', { className: 'dsh-vnc-actions' },
            // Connect and disconnect share one seat: only one of them can apply.
            React.createElement('button', {
              type: 'button',
              className: 'dsh-vnc-tool',
              title: primaryLabel,
              'aria-label': primaryLabel,
              disabled: busy,
              onClick: () => { if (connected) disconnect(); else void startConnection({ automatic: false }) },
            }, icon(connected ? 'disconnect' : 'connect', 15)),
            React.createElement('button', {
              type: 'button',
              className: 'dsh-vnc-tool',
              title: t('action.reconnect'),
              'aria-label': t('action.reconnect'),
              // Reconnecting is meaningful once there is a session to replace:
              // it restarts a settled or failed connection, but a mid-flight or
              // never-started page has nothing for it to reconnect.
              disabled: busy || state === 'idle',
              onClick: () => { disconnect(); void startConnection({ automatic: false }) },
            }, icon('reconnect', 15)),
            React.createElement('button', {
              type: 'button',
              className: 'dsh-vnc-tool',
              title: t('action.scale'),
              'aria-label': t('action.scale'),
              'aria-pressed': scale,
              onClick: toggleScale,
            }, icon('scale', 15)),
            React.createElement('button', {
              type: 'button',
              className: 'dsh-vnc-tool',
              title: t('action.readOnly'),
              'aria-label': t('action.readOnly'),
              'aria-pressed': viewOnly,
              onClick: toggleViewOnly,
            }, icon('readOnly', 15)),
            React.createElement('button', {
              type: 'button',
              className: 'dsh-vnc-tool',
              title: t('action.clipboard'),
              'aria-label': t('action.clipboard'),
              disabled: !connected || viewOnly,
              onClick: () => { void pasteClipboard() },
            }, icon('clipboard', 15)),
            React.createElement('button', {
              type: 'button',
              className: 'dsh-vnc-tool',
              title: t(fullscreen ? 'action.exitFullscreen' : 'action.fullscreen'),
              'aria-label': t(fullscreen ? 'action.exitFullscreen' : 'action.fullscreen'),
              'aria-pressed': fullscreen,
              onClick: toggleFullscreen,
            }, icon(fullscreen ? 'collapse' : 'expand', 15)))),
        React.createElement('div', { className: 'dsh-vnc-stage' },
          React.createElement('div', { ref: hostRef, className: 'dsh-vnc-canvas' }),
          prompt !== null
            ? React.createElement('div', { className: 'dsh-vnc-overlay' },
                React.createElement('form', {
                  className: 'dsh-vnc-password',
                  onSubmit: submitPassword,
                },
                React.createElement('div', { className: 'dsh-vnc-overlay-title' }, t('password.prompt')),
                React.createElement('input', {
                  className: 'dsh-vnc-input',
                  type: 'password',
                  autoComplete: 'off',
                  'aria-label': t('password.placeholder'),
                  placeholder: t('password.placeholder'),
                  value: password,
                  onChange: (event) => setPassword(event.target.value),
                }),
                React.createElement('div', { className: 'dsh-vnc-password-row' },
                  React.createElement('button', {
                    type: 'button',
                    className: 'dsh-vnc-secondary',
                    onClick: cancelPassword,
                  }, t('password.cancel')),
                  React.createElement('button', {
                    type: 'submit',
                    className: 'dsh-vnc-primary',
                  }, t('password.submit')))))
            : connected
              ? null
              : React.createElement('div', { className: 'dsh-vnc-overlay' },
                  React.createElement('div', { className: 'dsh-vnc-overlay-title' }, statusText),
                  overlayHint === null
                    ? null
                    : React.createElement('div', { className: 'dsh-vnc-overlay-hint' }, overlayHint),
                  state === 'idle' || state === 'disconnected' || state === 'error'
                    ? React.createElement('button', {
                        type: 'button',
                        className: 'dsh-vnc-primary',
                        disabled: !canConnect,
                        onClick: () => { void startConnection({ automatic: false }) },
                      }, icon('connect', 14), t(state === 'idle' ? 'action.connect' : 'action.reconnect'))
                    : null)),
        note === null
          ? null
          : React.createElement('div', { className: 'dsh-vnc-note', role: 'status' }, t(note)))
      }
    }

    // ===== registration =====

    /**
     * The tab-type definition contributed to the product's registry.
     * @param t - the module's locale-bound translator.
     */
    function createTabDefinition(t) {
      return {
        id: VNC_TAB_ID,
        kind: VNC_TAB_KIND,
        priority: 'extension',
        title: () => t('title'),
        guide: [{
          id: VNC_TAB_KIND,
          order: 24,
          title: () => t('title'),
          description: () => t('guide.description'),
          icon: VncTabGlyph,
        }],
      }
    }

    const inject = ['slots', 'locale', 'sidebarRightTabs', 'connection']

    function apply(ctx) {
      const slots = ctx.get('slots')
      const sidebarRightTabs = ctx.get('sidebarRightTabs')
      const locale = ctx.get('locale')
      const connection = ctx.get('connection')
      // The right Sidebar arrived in a later DSH than this plugin; without its
      // registry and the pane seat there is nowhere to contribute a page, and
      // registering would throw. Staying silent is the compatible behavior.
      if (slots === undefined || sidebarRightTabs === undefined) return

      if (locale !== undefined) {
        ctx.effect(() => locale.register(LOCALE_NS, { zh: ZH_DICT, en: EN_DICT }), 'desktop-vnc: locale')
      }
      ctx.effect(() => installStyle(), 'desktop-vnc: stylesheet')

      const t = locale !== undefined
        ? locale.bind(LOCALE_NS)
        : (key, params) => applyParams(ZH_DICT[key] ?? EN_DICT[key] ?? key, params)

      const VncPage = createVncPage(t, connection)

      ctx.effect(() => {
        const disposeType = sidebarRightTabs.register(createTabDefinition(t))
        // The body registers under the type's own id, which is the key the pane
        // seat dispatches with for every tab of this kind.
        const disposeBody = slots.inject('sidebar.right.pane.tab', () => slots.register({
          name: 'sidebar.right.pane.tab',
          key: VNC_TAB_ID,
          locale: LOCALE_NS,
        }, VncPage))
        return () => {
          disposeBody()
          disposeType()
        }
      }, 'desktop-vnc: right sidebar tab')
    }

    return {
      name: 'desktop-vnc-client',
      inject,
      apply,
      __test: {
        LOCALE_NS,
        VNC_TAB_ID,
        VNC_TAB_KIND,
        ASSET_BASE,
        RFB_MODULE_PATH,
        WS_PATH,
        STATE_PATH,
        ZH_DICT,
        EN_DICT,
        VNC_STATES,
        VNC_INITIAL_STATE,
        AUTO_RETRY_LIMIT,
        VNC_STATE_TRANSITIONS,
        isVncState,
        reduceVncState,
        statusKeyFor,
        connectionStatusKeyFor,
        shouldAutoConnect,
        classifyDisconnect,
        wsUrlFor,
        rfbModuleUrl,
        applyParams,
        setRfbModuleImporter,
        createTabDefinition,
        createVncPage,
      },
    }
  },
})
