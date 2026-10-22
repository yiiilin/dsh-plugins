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
    // Every one of these is resolved against `document.baseURI` rather than the site
    // root: the GUI is served under an environment prefix (`/main/`, `/env-6-13/`), and a
    // root-absolute path escapes it — the request lands on the prefix-less route and is
    // redirected to the login page, which reads as a broken panel.
    const BASE = () => (typeof document === 'undefined' ? 'http://localhost/' : document.baseURI)
    const ASSET_BASE = () => new URL('_dsh/desktop-vnc/asset', BASE()).href
    /**
     * noVNC's RFB entry module. The Host serves only `core/**` and `vendor/**`,
     * and noVNC resolves its own `./util/*.js` imports relatively, so the loader
     * URL must be this exact path — not an `app/` bundle.
     */
    const RFB_MODULE_PATH = () => `${ASSET_BASE()}/core/rfb.js`
    /**
     * The browser-instance table (contract §4.4). The sidebar list reads it; the
     * focus itself is never written back, because it is this client's own state.
     */
    const SESSIONS_PATH = () => new URL('_dsh/desktop-vnc/sessions', BASE()).href
    /**
     * The socket for one browser instance, or — with no id — the frozen v1 route
     * (`/_dsh/desktop-vnc/ws`), which the Host still serves for a single/legacy
     * deployment. The id is a path segment, so it is encoded rather than pasted in.
     */
    const WS_PATH = (instanceId = '') => {
      const id = typeof instanceId === 'string' ? instanceId.trim() : ''
      if (id === '') return new URL('_dsh/desktop-vnc/ws', BASE()).href
      return new URL(`_dsh/desktop-vnc/sessions/${encodeURIComponent(id)}/ws`, BASE()).href
    }
    const STATE_PATH = () => new URL('_dsh/desktop-vnc/state', BASE()).href

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
      'error.component': '依赖组件不健康：{detail}',
      'error.asset': '无法加载 VNC 客户端资源',
      'error.state': '无法读取桌面服务状态',
      'clipboard.pasted': '已粘贴剪贴板内容',
      'clipboard.unavailable': '无法读取本机剪贴板',
      'list.title': '浏览器实例',
      'list.refresh': '刷新列表',
      'list.loading': '正在读取实例列表…',
      'list.empty': '没有浏览器实例',
      'list.emptyHint': '点上方 + 新建一个，或让 agent 创建',
      'list.error': '无法读取浏览器实例列表',
      'list.retry': '重试',
      'list.rowLabel': '浏览实例 {id}（{state}）',
      'list.rowLabelDetail': '浏览实例 {id}（{state}）：{detail}',
      'list.size': '{width}×{height}',
      'list.owner': '会话 {id}',
      'list.ownerUnknown': '未知会话',
      'list.lastActive': '最后活动 {time}',
      'list.viewers': '{count} 人观看',
      'list.viewersNone': '无人观看',
      'list.unavailable': '暂不可用',
      'list.failureReason': '失败原因：{detail}',
      'list.failureUnknown': '失败原因未知',
      'list.create': '新建浏览器实例',
      'list.creating': '正在新建…',
      'list.createFailed': '新建失败：{detail}',
      'list.close': '关闭实例 {id}',
      'list.closing': '正在关闭…',
      'list.closeFailed': '关闭失败：{detail}',
      'viewer.empty': '选择一个浏览器实例',
      'viewer.emptyHint': '在左侧列表里点一个实例，就能看到它的画面',
      'state.starting': '启动中',
      'state.ready': '就绪',
      'state.failed': '失败',
      'state.unknown': '未知状态',
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
      'error.component': 'A required component is unhealthy: {detail}',
      'error.asset': 'Could not load the VNC client assets',
      'error.state': 'Could not read the desktop service state',
      'clipboard.pasted': 'Clipboard content pasted',
      'clipboard.unavailable': 'Could not read the local clipboard',
      'list.title': 'Browser instances',
      'list.refresh': 'Refresh list',
      'list.loading': 'Reading the instance list…',
      'list.empty': 'No browser instances',
      'list.emptyHint': 'Use + above to open one, or ask an agent',
      'list.error': 'Could not read the browser instance list',
      'list.retry': 'Retry',
      'list.rowLabel': 'Browser instance {id} ({state})',
      'list.rowLabelDetail': 'Browser instance {id} ({state}): {detail}',
      'list.size': '{width}×{height}',
      'list.owner': 'Session {id}',
      'list.ownerUnknown': 'Unknown session',
      'list.lastActive': 'Active {time}',
      'list.viewers': '{count} watching',
      'list.viewersNone': 'No viewers',
      'list.unavailable': 'Not available yet',
      'list.failureReason': 'Failed: {detail}',
      'list.failureUnknown': 'Failure reason unavailable',
      'list.create': 'New browser instance',
      'list.creating': 'Opening…',
      'list.createFailed': 'Could not open: {detail}',
      'list.close': 'Close instance {id}',
      'list.closing': 'Closing…',
      'list.closeFailed': 'Could not close: {detail}',
      'viewer.empty': 'Select a browser instance',
      'viewer.emptyHint': 'Pick an instance in the list on the left to see its screen',
      'state.starting': 'Starting',
      'state.ready': 'Ready',
      'state.failed': 'Failed',
      'state.unknown': 'Unknown state',
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
     * The VNC WebSocket URL for the page origin.
     *
     * Takes the absolute http(s) URL of the Host upgrade route and swaps the scheme, so
     * the environment prefix it was resolved with survives — building the URL from a bare
     * path dropped the prefix and connected to a route that answers with the login page.
     *
     * @param httpUrl - absolute http(s) URL of the upgrade route.
     * @returns the same URL over ws(s).
     */
    function wsUrlFor(httpUrl) {
      return String(httpUrl).replace(/^http/u, "ws")
    }

    /** @returns the absolute URL of noVNC's RFB module, as served by the Host. */
    function rfbModuleUrl() {
      return RFB_MODULE_PATH()
    }

    // ===== browser instance list =====

    /** The three states the Host reports for a browser instance. */
    const INSTANCE_STATES = ['starting', 'ready', 'failed']

    /**
     * How often the visible list re-reads the instance table.
     *
     * The table is the one shared thing about instances, and it changes without
     * this client doing anything: an agent creates or closes one, a boot moves
     * `starting` → `ready`, another viewer joins. Re-reading is also how a focus
     * finds out its instance closed (see {@link focusAfterList}), which is what
     * keeps a dead canvas off the screen.
     */
    const LIST_POLL_MS = 5000

    /**
     * Keep the row fields the Host sent, dropping anything without a usable id.
     *
     * The list is read defensively because it is the panel's only data source: a
     * malformed row must cost that row, not the whole page. An unknown `state` is
     * normalised to `unknown` so a row can style and label it rather than leaving
     * a raw value in the DOM.
     *
     * @param rows - the decoded JSON body of `GET /sessions`.
     * @returns the usable rows, in table order.
     */
    function parseInstanceList(rows) {
      if (!Array.isArray(rows)) return []
      const list = []
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue
        if (typeof row.id !== 'string' || row.id === '') continue
        const state = INSTANCE_STATES.indexOf(row.state) !== -1 ? row.state : 'unknown'
        list.push({ ...row, state })
      }
      return list
    }

    /**
     * Whether a row can be focused at all.
     *
     * Only a `ready` instance has a browser behind it: `starting` is still coming
     * up, and `failed` has no socket to show. Offering either as a target would
     * open a viewer the Host then refuses, so they are not offered at all.
     *
     * @param row - one parsed list row.
     * @returns whether clicking it may set the focus.
     */
    function isInstanceSelectable(row) {
      return row !== null && typeof row === 'object' && row.state === 'ready'
    }

    /** Two digits, so a clock never reads `9:5`. */
    const pad2 = (value) => String(value).padStart(2, '0')

    /**
     * Render an epoch-seconds timestamp as local wall-clock time.
     *
     * The list contract sends seconds (see the Host's `row()`), and a raw number
     * is unreadable. The same day gets `HH:MM`; anything older also carries its
     * date, so yesterday's activity cannot be mistaken for today's.
     *
     * @param seconds - the row's epoch-seconds field, or anything else.
     * @param nowMs - the reference instant, injectable for tests.
     * @returns the readable stamp, or null when there is nothing usable.
     */
    function formatLastActive(seconds, nowMs = Date.now()) {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null
      const at = new Date(seconds * 1000)
      if (Number.isNaN(at.getTime())) return null
      const now = new Date(nowMs)
      const clock = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`
      const sameDay = at.getFullYear() === now.getFullYear()
        && at.getMonth() === now.getMonth()
        && at.getDate() === now.getDate()
      return sameDay ? clock : `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${clock}`
    }

    /**
     * Reconcile the focus with a freshly read list.
     *
     * A focused instance that is no longer listed was closed. The page then goes
     * back to **unselected** rather than sliding to a neighbour: focus is the
     * user's choice, and silently retargeting the viewer would make them watch a
     * different browser than the one they picked. An unreadable list (`null`) is
     * not evidence of a close, so it keeps the focus — a failed poll must not tear
     * down a working stream.
     *
     * @param focused - the currently focused instance id, or null.
     * @param rows - the rows just read, or `null`/`undefined` when unreadable.
     * @returns the id to keep focused, or null.
     */
    function focusAfterList(focused, rows) {
      if (!Array.isArray(rows)) return focused
      if (typeof focused !== 'string' || focused === '') return null
      return rows.some((row) => row !== null && typeof row === 'object' && row.id === focused) ? focused : null
    }

    /**
     * Read the Host's browser instance table.
     * @param fetchImpl - the `fetch` to use (the page's own, or the sandbox's).
     * @returns the parsed rows.
     * @throws when the route is unreachable or does not answer with an array.
     */
    async function readInstanceList(fetchImpl) {
      const response = await fetchImpl(SESSIONS_PATH(), { headers: { accept: 'application/json' } })
      if (response?.ok !== true) throw new Error(`desktop-vnc sessions returned HTTP ${response?.status}`)
      const rows = await response.json()
      if (!Array.isArray(rows)) throw new Error('desktop-vnc sessions was not an array')
      return parseInstanceList(rows)
    }

    /**
     * One line for a failed create/close, for the row note and the aria label.
     * @param error - whatever the fetch path threw.
     * @returns a non-empty reason; never the empty string.
     */
    function errorMessage(error) {
      if (error instanceof Error && error.message !== '') return error.message
      if (typeof error === 'string' && error !== '') return error
      return 'unknown error'
    }

    /**
     * Ask the Host to open one browser instance owned by this session.
     *
     * The owner is the session the page is showing, so the instance is collected
     * when that session goes away — the same rule the agent's create tool follows.
     *
     * @param fetchImpl - the `fetch` to use.
     * @param ownerSessionId - the session that will own the instance.
     * @returns the new instance's address and initial state.
     * @throws when the Host refuses (an exhausted pool answers 503 with a reason).
     */
    async function createInstance(fetchImpl, ownerSessionId) {
      const response = await fetchImpl(SESSIONS_PATH(), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(ownerSessionId === null ? {} : { ownerSessionId }),
      })
      const body = await response.json().catch(() => null)
      if (response?.ok !== true) {
        const reason = typeof body?.error === 'string' && body.error !== ''
          ? body.error
          : `desktop-vnc sessions returned HTTP ${response?.status}`
        throw new Error(reason)
      }
      return body
    }

    /**
     * Ask the Host to close one browser instance.
     * @param fetchImpl - the `fetch` to use.
     * @param id - the instance to close.
     * @throws when the Host refuses (an unknown id answers 404).
     */
    async function closeInstance(fetchImpl, id) {
      const response = await fetchImpl(`${SESSIONS_PATH()}/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { accept: 'application/json' },
      })
      if (response?.ok === true) return
      const body = await response.json().catch(() => null)
      const reason = typeof body?.error === 'string' && body.error !== ''
        ? body.error
        : `desktop-vnc sessions returned HTTP ${response?.status}`
      throw new Error(reason)
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
.dsh-vnc-shell {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: row;
  box-sizing: border-box;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f5f5f4));
  color: var(--dsw-alias-label-primary, #111827);
  font-size: 13px;
  overflow: hidden;
}
.dsh-vnc-list {
  flex: 0 0 auto;
  width: 190px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  border-right: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
  overflow: hidden;
}
.dsh-vnc-list-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 32px;
  padding: 4px 6px 4px 10px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.1));
}
.dsh-vnc-list-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--dsw-alias-label-secondary, #57534e);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-vnc-list-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 4px;
  box-sizing: border-box;
}
.dsh-vnc-instance {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 2px 6px;
  width: 100%;
  padding: 5px 6px;
  box-sizing: border-box;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.dsh-vnc-instance:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2, #e7e5e4));
}
.dsh-vnc-instance:disabled {
  cursor: default;
  color: var(--dsw-alias-label-secondary, #57534e);
}
.dsh-vnc-instance-meta {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  min-width: 0;
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-label-secondary, #57534e);
}
.dsh-vnc-instance-meta > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-vnc-instance-note {
  grid-column: 1 / -1;
  font-size: 11px;
  line-height: 15px;
  color: var(--dsw-alias-label-secondary, #57534e);
  overflow-wrap: anywhere;
}
.dsh-vnc-instance-note[data-state="failed"] {
  color: var(--dsw-alias-state-error-primary, #dc2626);
}
.dsh-vnc-instance:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #2563eb));
}
.dsh-vnc-instance[aria-current="true"] {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
  font-weight: 600;
}
.dsh-vnc-instance-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 2px;
}
.dsh-vnc-instance-row[data-current="true"] .dsh-vnc-instance {
  background: var(--dsw-alias-bg-layer-2, #e7e5e4);
  font-weight: 600;
}
.dsh-vnc-close {
  flex: none;
  width: 22px;
  height: 22px;
  padding: 0;
  box-sizing: border-box;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.dsh-vnc-close:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2, #e7e5e4));
  color: var(--dsw-alias-label-primary, #1f2937);
}
.dsh-vnc-close:disabled {
  opacity: 0.4;
  cursor: default;
}
.dsh-vnc-instance-id {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dsh-vnc-instance-state {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-secondary, #57534e);
  font-size: 11px;
  white-space: nowrap;
}
.dsh-vnc-list-note {
  padding: 10px;
  color: var(--dsw-alias-label-secondary, #57534e);
  font-size: 12px;
  line-height: 17px;
  overflow-wrap: anywhere;
}
.dsh-vnc-list-note .dsh-vnc-secondary {
  margin-top: 8px;
}
.dsh-vnc-viewer {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
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
.dsh-vnc-empty {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 16px;
  box-sizing: border-box;
  text-align: center;
  background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f5f5f4));
  color: var(--dsw-alias-label-secondary, #57534e);
}
.dsh-vnc-empty .dsh-vnc-overlay-hint {
  max-width: 240px;
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
.dsh-vnc-dot[data-state="connecting"],
.dsh-vnc-dot[data-state="starting"] {
  background: var(--dsw-alias-state-warn-primary, #d97706);
  animation: dsh-vnc-pulse 1.2s ease-in-out infinite;
}
.dsh-vnc-dot[data-state="connected"],
.dsh-vnc-dot[data-state="ready"] {
  background: var(--dsw-alias-state-success-primary, #16a34a);
}
.dsh-vnc-dot[data-state="error"],
.dsh-vnc-dot[data-state="failed"] {
  background: var(--dsw-alias-state-error-primary, #dc2626);
}
.dsh-vnc-dot[data-state="disconnected"],
.dsh-vnc-dot[data-state="unknown"] {
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
        rfbModulePromise = Promise.resolve().then(() => rfbImport(RFB_MODULE_PATH())).then((mod) => {
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
      const response = await fetchImpl(STATE_PATH(), { headers: { accept: 'application/json' } })
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
    function teardownRfb(rfbRef, clipboardCleanupRef) {
      const detach = clipboardCleanupRef?.current
      if (clipboardCleanupRef !== undefined) clipboardCleanupRef.current = null
      if (typeof detach === 'function') detach()
      const rfb = rfbRef.current
      rfbRef.current = null
      if (rfb === null || rfb === undefined || typeof rfb.disconnect !== 'function') return
      try {
        rfb.disconnect()
      } catch (error) {
        console.warn('desktop-vnc: disconnecting the viewer failed', error)
      }
    }

    /**
     * Name the component that is keeping the panel from working, if one is.
     *
     * The daemon reports what it knows rather than a verdict: whether Xephyr came
     * up, whether chromium is running, and — when the browser stack had to fall
     * back — the reason it gave. Turning that into one sentence here keeps the
     * user from having to guess which of three binaries is missing.
     *
     * @param desktop - the state document read from the daemon.
     * @returns the readable reason, or null when nothing is wrong.
     */
    function componentFailure(desktop) {
      const browser = desktop?.browser
      if (browser === null || typeof browser !== 'object') return null
      if (browser.enabled === false) return null
      const warning = browser.warning
      // The stack fell back and said why: that reason names the binary.
      if (typeof warning === 'string' && warning !== '') return warning
      // No fallback reported, but a piece is not running: name the piece itself.
      if (browser.xephyr !== true) return 'Xephyr'
      if (browser.chromium !== true) return 'chromium'
      return null
    }

    /**
     * Put text on the system clipboard, if this browser lets us.
     *
     * The async Clipboard API needs a secure context and, in most browsers, a user
     * gesture; a remote-side copy satisfies neither on its own. The older
     * `execCommand` path still works without a gesture in more cases, so it is the
     * fallback rather than the exception. A failure is not fatal: the session keeps
     * working, the user just has to copy again by hand.
     *
     * @param text - the text the remote side put on its clipboard.
     * @returns whether the text reached the clipboard.
     */
    function writeClipboard(text) {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText !== undefined) {
        return navigator.clipboard.writeText(text).then(() => true, () => legacyWriteClipboard(text))
      }
      return Promise.resolve(legacyWriteClipboard(text))
    }

    /** The `execCommand` fallback, for contexts where the Clipboard API refuses. */
    function legacyWriteClipboard(text) {
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false
      const area = document.createElement('textarea')
      area.value = text
      // Off-screen rather than hidden: a `display:none` field cannot be selected.
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.top = '-1000px'
      area.style.opacity = '0'
      document.body.appendChild(area)
      try {
        area.select()
        return document.execCommand('copy') === true
      } catch {
        return false
      } finally {
        document.body.removeChild(area)
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
        // The detail substituted into a failure key that has a `{detail}` slot.
        const [failureDetail, setFailureDetail] = React.useState(null)
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
        // Detaches the paste listener when the viewer is torn down.
        const clipboardCleanupRef = React.useRef(null)

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
        /**
         * The browser instance this page shows. The shell mounts one viewer per
         * focused instance, so this is fixed for the page's whole lifetime; the
         * lifetime effect's `[sessionId]` dependency is therefore what restarts the
         * connection when the shell switches instances — the shell also keys the
         * element, so a switch replaces the component outright.
         */
        const instanceId = typeof props.instanceId === 'string' ? props.instanceId : ''
        const wsPath = WS_PATH(instanceId)

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
            teardownRfb(rfbRef, clipboardCleanupRef)
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
            teardownRfb(rfbRef, clipboardCleanupRef)
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
            teardownRfb(rfbRef, clipboardCleanupRef)
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
            rfb = new RFB(hostRef.current, wsUrlFor(wsPath), {
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
            teardownRfb(rfbRef, clipboardCleanupRef)
          })
          // Clipboard, both directions. noVNC carries the text over the same
          // connection: a server-side copy arrives as a `clipboard` event, and a
          // paste from this side goes out through `clipboardPasteFrom`. Neither
          // path exists until the connection is up, so both are attached here
          // rather than at construction.
          rfb.addEventListener('clipboard', (event) => {
            if (!current()) return
            const text = event?.detail?.text
            if (typeof text !== 'string' || text === '') return
            // Writing the system clipboard needs a user gesture in most browsers
            // and may be refused outright; a refusal must not break the session.
            void Promise.resolve(writeClipboard(text)).catch(() => undefined)
          })
          // Ctrl/Cmd+V while the viewer has focus pastes into the remote side. The
          // listener is on the container, not the document, so a paste meant for
          // the rest of the page keeps working.
          const onPaste = (event) => {
            if (!current()) return
            const text = event?.clipboardData?.getData?.('text/plain')
            if (typeof text !== 'string' || text === '') return
            event.preventDefault()
            try {
              rfb.clipboardPasteFrom(text)
            } catch (error) {
              console.warn('desktop-vnc: sending the clipboard to the remote side failed', error)
            }
          }
          const container = hostRef.current
          container?.addEventListener?.('paste', onPaste)
          clipboardCleanupRef.current = () => {
            container?.removeEventListener?.('paste', onPaste)
          }
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
            // Name the component rather than saying "something failed": the state
            // carries the reason the browser stack fell back or refused, which is
            // what tells the user whether Xephyr, chromium or x11vnc is missing.
            const reason = componentFailure(desktop)
            if (reason !== null) {
              setFailureDetail(reason)
              setFailure('error.component')
              return
            }
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
          teardownRfb(rfbRef, clipboardCleanupRef)
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
          teardownRfb(rfbRef, clipboardCleanupRef)
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
            ? applyParams(t(failure ?? 'error.hint'), { detail: failureDetail ?? '' })
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

    // ===== shell: instance list + viewer =====

    /**
     * The tab body: the browser-instance list on the left, the focused instance's
     * viewer on the right.
     *
     * The list is the Host's table, so every client sees the same instances. The
     * **focus** is the opposite: it is this client's own UI state and never leaves
     * the page, which is what lets two people watch two different instances from
     * the same account.
     *
     * The viewer is mounted with `key={focusedInstanceId}`, so switching instances
     * replaces the component instead of re-rendering it. The replacement unmounts
     * the old viewer — releasing its socket and x11vnc client — and starts a fresh
     * page lifetime for the new one, which is exactly the reset an instance switch
     * needs; nothing has to be torn down by hand here.
     *
     * @param t - the module's locale-bound translator.
     * @param connection - the Host connection generation channel, passed through.
     * @param VncPage - the viewer component to mount for the focused instance.
     */
    function createVncShell(t, connection, VncPage) {
      const Viewer = typeof VncPage === 'function' ? VncPage : createVncPage(t, connection)

      return function VncShell(props) {
        /** The focused browser instance, or null for "nothing selected". */
        const [focusedId, setFocusedId] = React.useState(null)
        /**
         * What the user's own create/close request is doing right now, one entry
         * at a time: `{ kind: 'create' }` or `{ kind: 'close', id }`, with a reason
         * once it failed. A page-level value rather than one per row keeps the two
         * controls mutually exclusive, so a double click cannot open two browsers.
         */
        const [action, setAction] = React.useState(null)
        /** The last list read: `{ rows }`, or `{ error }`. `null` while loading. */
        const [listing, setListing] = React.useState(null)
        const [refreshKey, setRefreshKey] = React.useState(0)
        /**
         * The seat's own tab reader, read here for one fact — whether the tab is
         * showing — and handed to the viewer unchanged, because the viewer is the
         * component that acts on it. It is a framework hook, so it is called
         * unconditionally; a bare render (unit tests) gets the inert placeholder.
         */
        const useTabInfo = typeof props?.useTabInfo === 'function' ? props.useTabInfo : noTabInfo
        const tabInfo = useTabInfo()
        const visible = tabInfo === null || tabInfo === undefined ? true : tabInfo?.tab?.visible !== false

        /**
         * Read the table once per refresh and once per poll, and reconcile the
         * focus with what came back. A read that fails keeps the previous rows and
         * the focus: an unreachable Host is not a closed instance.
         */
        React.useEffect(() => {
          // A hidden tab neither reads nor polls: nobody is looking at the list
          // and its viewer is already released. Revealing it re-runs this effect,
          // which reads once immediately.
          if (!visible) return undefined
          let live = true
          let inFlight = false
          const read = async () => {
            if (inFlight) return
            inFlight = true
            try {
              const rows = await readInstanceList(
                typeof window !== 'undefined' && typeof window.fetch === 'function' ? window.fetch.bind(window) : fetch,
              )
              if (!live) return
              setListing({ rows })
              setFocusedId((current) => focusAfterList(current, rows))
            } catch (error) {
              if (!live) return
              setListing((current) => ({ rows: current?.rows ?? [], error: true }))
            } finally {
              inFlight = false
            }
          }
          void read()
          // The instance table changes without this client doing anything: an
          // agent creates or closes one, a boot moves `starting` → `ready`,
          // another viewer joins. Polling is what keeps a row — and a focus whose
          // instance was closed elsewhere — honest.
          const timer = setInterval(() => { void read() }, LIST_POLL_MS)
          return () => {
            live = false
            clearInterval(timer)
          }
        }, [refreshKey, visible])

        /** The fetch this page uses; the sandbox's own when there is no window. */
        const pageFetch = () => (typeof window !== 'undefined' && typeof window.fetch === 'function'
          ? window.fetch.bind(window)
          : fetch)

        /** The session that owns an instance this page creates. */
        const owningSessionId = typeof tabInfo?.tab?.id === 'string' && tabInfo.tab.id !== ''
          ? tabInfo.tab.id
          : null

        /**
         * Open one instance on the user's behalf and focus it.
         *
         * `starting` rows are not focusable, so the new id is only remembered once
         * the poll reports it ready — otherwise the focus would land on a row the
         * viewer cannot mount.
         */
        const createOnBehalfOfUser = async () => {
          if (action !== null) return
          setAction({ kind: 'create' })
          try {
            const created = await createInstance(pageFetch(), owningSessionId)
            if (created !== null && typeof created.id === 'string') {
              setListing((current) => (current === null ? current : { ...current, rows: current.rows }))
            }
            setAction(null)
            setRefreshKey((key) => key + 1)
          } catch (error) {
            setAction({ kind: 'create', failed: true, detail: errorMessage(error) })
          }
        }

        /** Close one instance, clearing the focus if it was the focused one. */
        const closeOnBehalfOfUser = async (id) => {
          if (action !== null) return
          setAction({ kind: 'close', id })
          try {
            await closeInstance(pageFetch(), id)
            setFocusedId((current) => (current === id ? null : current))
            setAction(null)
            setRefreshKey((key) => key + 1)
          } catch (error) {
            setAction({ kind: 'close', id, failed: true, detail: errorMessage(error) })
          }
        }

        /**
         * One list row: the identity line, the details that decide whether the
         * instance is worth focusing, and — when it is not usable — why.
         *
         * Only a `ready` instance is offered as a target. `starting` and `failed`
         * rows are disabled rather than merely dimmed, and each carries an explicit
         * note: a grey row with no explanation reads as a bug in the list.
         *
         * @param row - one parsed list row.
         */
        const instanceRow = (row) => {
          const selectable = isInstanceSelectable(row)
          const stateLabel = t(`state.${row.state}`)
          const reason = row.state === 'failed'
            ? (typeof row.error === 'string' && row.error !== '' ? row.error : null)
            : null
          const note = row.state === 'failed'
            ? (reason === null ? t('list.failureUnknown') : applyParams(t('list.failureReason'), { detail: reason }))
            : selectable ? null : t('list.unavailable')
          const stamp = formatLastActive(row.lastActiveAt)
          const size = Number.isFinite(row.width) && Number.isFinite(row.height)
            ? applyParams(t('list.size'), { width: row.width, height: row.height })
            : null
          const owner = typeof row.ownerSessionId === 'string' && row.ownerSessionId !== ''
            ? applyParams(t('list.owner'), { id: row.ownerSessionId })
            : t('list.ownerUnknown')
          const viewers = Number.isFinite(row.viewers) && row.viewers > 0
            ? applyParams(t('list.viewers'), { count: row.viewers })
            : t('list.viewersNone')
          const detail = note ?? (typeof row.viewers === 'number' ? viewers : '')
          // The row is a container, not a button: the close control must not be a
          // nested button, which is invalid HTML and unreachable by keyboard.
          const closing = action?.kind === 'close' && action.id === row.id
          const closeFailed = closing && action?.failed === true
          return React.createElement('div', {
            key: row.id,
            className: 'dsh-vnc-instance-row',
            'data-current': selectable && row.id === focusedId,
          },
          React.createElement('button', {
            type: 'button',
            className: 'dsh-vnc-instance',
            // The identity lives on the selectable button, not on the wrapper:
            // the button is the row's control, and this is what tests and any
            // future keyboard navigation read it by.
            'data-instance-id': row.id,
            'data-state': row.state,
            'aria-current': selectable && row.id === focusedId,
            'aria-label': detail === ''
              ? applyParams(t('list.rowLabel'), { id: row.id, state: stateLabel })
              : applyParams(t('list.rowLabelDetail'), { id: row.id, state: stateLabel, detail }),
            // A row that cannot be watched is not a control: disabling it is what
            // keeps it out of the tab order, instead of only making it look inert.
            disabled: !selectable,
            onClick: () => {
              if (selectable) setFocusedId(row.id)
            },
          },
          React.createElement('span', { className: 'dsh-vnc-dot', 'data-state': row.state, 'aria-hidden': true }),
          React.createElement('span', { className: 'dsh-vnc-instance-id', title: row.id }, row.id),
          React.createElement('span', { className: 'dsh-vnc-instance-state' }, stateLabel),
          React.createElement('span', { className: 'dsh-vnc-instance-meta' },
            size === null ? null : React.createElement('span', { className: 'dsh-vnc-instance-size' }, size),
            React.createElement('span', { className: 'dsh-vnc-instance-owner', title: row.ownerSessionId ?? '' }, owner),
            stamp === null
              ? null
              : React.createElement('span', { className: 'dsh-vnc-instance-active' },
                  applyParams(t('list.lastActive'), { time: stamp })),
            React.createElement('span', { className: 'dsh-vnc-instance-viewers' }, viewers)),
          note === null
            ? null
            : React.createElement('span', { className: 'dsh-vnc-instance-note', 'data-state': row.state }, note)),
          React.createElement('button', {
            type: 'button',
            className: 'dsh-vnc-close',
            title: applyParams(t('list.close'), { id: row.id }),
            'aria-label': closing ? t('list.closing') : applyParams(t('list.close'), { id: row.id }),
            // Closing is always offered, whatever the state: an instance that
            // failed to start is exactly the one a user wants to clear away.
            disabled: action !== null,
            onClick: (event) => {
              event.stopPropagation()
              void closeOnBehalfOfUser(row.id)
            },
          }, closing ? t('list.closing') : '\u00d7'),
          closeFailed
            ? React.createElement('span', { className: 'dsh-vnc-instance-note', 'data-state': 'failed', role: 'alert' },
                applyParams(t('list.closeFailed'), { detail: action.detail }))
            : null)
        }

        const rows = listing?.rows ?? []
        const failed = listing?.error === true && rows.length === 0
        const loading = listing === null
        const focusedRow = focusedId === null ? null : rows.find((row) => row.id === focusedId) ?? null

        const listBody = loading
          ? React.createElement('div', { className: 'dsh-vnc-list-note' }, t('list.loading'))
          : failed
            ? React.createElement('div', { className: 'dsh-vnc-list-note', role: 'alert' },
                t('list.error'),
                React.createElement('div', null,
                  React.createElement('button', {
                    type: 'button',
                    className: 'dsh-vnc-secondary',
                    onClick: () => setRefreshKey((key) => key + 1),
                  }, t('list.retry'))))
            : rows.length === 0
              ? React.createElement('div', { className: 'dsh-vnc-list-note' },
                  React.createElement('div', { className: 'dsh-vnc-overlay-title' }, t('list.empty')),
                  React.createElement('div', null, t('list.emptyHint')))
              : rows.map((row) => instanceRow(row))

        return React.createElement('div', { className: 'dsh-vnc-shell' },
          React.createElement('div', { className: 'dsh-vnc-list' },
            React.createElement('div', { className: 'dsh-vnc-list-head' },
              React.createElement('span', { className: 'dsh-vnc-list-title' }, t('list.title')),
              React.createElement('button', {
                type: 'button',
                className: 'dsh-vnc-tool',
                title: action?.kind === 'create' ? t('list.creating') : t('list.create'),
                'aria-label': action?.kind === 'create' ? t('list.creating') : t('list.create'),
                // One create at a time, and never while a close is in flight: two
                // clicks would otherwise open two browsers with no way to tell them
                // apart in this list until both settle.
                disabled: action !== null,
                onClick: () => { void createOnBehalfOfUser() },
              }, action?.kind === 'create' ? t('list.creating') : '+'),
              React.createElement('button', {
                type: 'button',
                className: 'dsh-vnc-tool',
                title: t('list.refresh'),
                'aria-label': t('list.refresh'),
                onClick: () => setRefreshKey((key) => key + 1),
              }, icon('reconnect', 14))),
            action?.kind === 'create' && action?.failed === true
              ? React.createElement('div', { className: 'dsh-vnc-list-note', role: 'alert' },
                  applyParams(t('list.createFailed'), { detail: action.detail }))
              : null,
            React.createElement('div', { className: 'dsh-vnc-list-body' }, listBody)),
          React.createElement('div', { className: 'dsh-vnc-viewer' },
            focusedRow === null
              ? React.createElement('div', { className: 'dsh-vnc-empty', role: 'region', 'aria-label': t('viewer.empty') },
                  React.createElement('div', { className: 'dsh-vnc-overlay-title' }, t('viewer.empty')),
                  React.createElement('div', { className: 'dsh-vnc-overlay-hint' }, t('viewer.emptyHint')))
              : React.createElement(Viewer, { key: focusedRow.id, instanceId: focusedRow.id, useTabInfo })))
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
      // The seat's body is the shell: the instance list plus the focused viewer.
      // `VncPage` stays the viewer component, mounted per focused instance.
      const VncShell = createVncShell(t, connection, VncPage)

      ctx.effect(() => {
        const disposeType = sidebarRightTabs.register(createTabDefinition(t))
        // The body registers under the type's own id, which is the key the pane
        // seat dispatches with for every tab of this kind.
        const disposeBody = slots.inject('sidebar.right.pane.tab', () => slots.register({
          name: 'sidebar.right.pane.tab',
          key: VNC_TAB_ID,
          locale: LOCALE_NS,
        }, VncShell))
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
        SESSIONS_PATH,
        STATE_PATH,
        ZH_DICT,
        EN_DICT,
        VNC_STATES,
        VNC_INITIAL_STATE,
        AUTO_RETRY_LIMIT,
        VNC_STATE_TRANSITIONS,
        INSTANCE_STATES,
        LIST_POLL_MS,
        isVncState,
        reduceVncState,
        statusKeyFor,
        connectionStatusKeyFor,
        shouldAutoConnect,
        classifyDisconnect,
        wsUrlFor,
        rfbModuleUrl,
        writeClipboard,
        legacyWriteClipboard,
        componentFailure,
        applyParams,
        parseInstanceList,
        focusAfterList,
        isInstanceSelectable,
        formatLastActive,
        readInstanceList,
        setRfbModuleImporter,
        createTabDefinition,
        createVncPage,
        createVncShell,
      },
    }
  },
})
