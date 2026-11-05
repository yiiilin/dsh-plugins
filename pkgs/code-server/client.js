/**
 * dsh-code-server — browser bundle (static DSH client module).
 *
 * Contributes a "Code editor" tab to the official right Sidebar. The tab body
 * is a thin client: it reads `/_dsh/code-server/state`, resolves the **DSH
 * Workspace** the pane belongs to, automatically starts that workspace's
 * instance on reveal, and embeds it in an iframe with `?folder=<workspace
 * path>` so VS Code opens the workspace immediately. Everything that spawns a
 * process lives on the Host half.
 *
 * One instance per Workspace, not per session: every session in the same
 * workspace sees the same editor and the same shared extensions directory.
 *
 * All URLs are resolved against `document.baseURI`, not the site root: the GUI
 * can be served under an environment prefix (`/main/`, `/env-6-13/`), and a
 * root-absolute path would escape it and land on the login page.
 *
 * The seat `sidebar.right.pane.tab` is session-scoped, so the body receives
 * `sessionId` plus the global `useWorkspaces` and `useSessions` selector hooks.
 * The Host still prefers its own `workspaceRegistry` over the ids/paths sent
 * from here.
 */
window.__ModuleLoader__.load({
  id: '@yiln-dsh/dsh-code-server',
  factory: (require) => {
    const React = require('react')

    const LOCALE_NS = 'code-server'
    /** Tab-system identity, persisted in each client's saved sidebar layout. */
    const TAB_ID = '@yiln-dsh/dsh-code-server'
    /** Tab type discriminator. */
    const TAB_KIND = 'code-server'
    /** How often a visible panel re-reads the Host's state. */
    const POLL_MS = 4000

    const BASE = () => (typeof document === 'undefined' ? 'http://localhost/' : document.baseURI)
    const urlFor = (relative) => new URL(relative, BASE()).href
    const STATE_PATH = () => urlFor('_dsh/code-server/state')
    const DETECT_PATH = () => urlFor('_dsh/code-server/detect')
    const INSTALL_PATH = () => urlFor('_dsh/code-server/install')
    const INSTALL_LOG_PATH = () => urlFor('_dsh/code-server/install/log')
    const SESSIONS_PATH = () => urlFor('_dsh/code-server/sessions')
    const sessionPath = (id) => urlFor(`_dsh/code-server/sessions/${encodeURIComponent(id)}`)
    /**
     * The iframe URL. `?folder=<absolute path>` is code-server's own URL API
     * (its FAQ documents it, and the workbench router skips the last-opened
     * redirect when it is present), so the workbench opens this workspace as
     * soon as it loads even though one instance is shared by many tabs.
     */
    const instanceUrl = (row) => {
      const url = new URL(urlFor(row.url))
      if (typeof row.workspacePath === 'string' && row.workspacePath !== '') {
        url.searchParams.set('folder', row.workspacePath)
      }
      return url.href
    }

    const ZH_DICT = {
      'title': '代码编辑器',
      'guide.description': '在侧栏里用 VS Code 打开当前工作区',
      'status.loading': '正在读取编辑器状态…',
      'status.error': '无法读取编辑器服务状态',
      'status.retry': '重试',
      'setup.title': '安装 code-server',
      'setup.description': '本插件不附带 code-server，宿主机上也没有找到 {executable}。先在宿主机安装，再回到这里重新检测。',
      'setup.command': '安装命令',
      'setup.copy': '复制命令',
      'setup.copied': '已复制',
      'setup.copyFailed': '复制失败，请手动选中命令',
      'setup.install': '一键安装',
      'setup.installConfirm': '确认在宿主机运行该命令',
      'setup.installing': '正在安装…',
      'setup.installStarted': '已启动安装进程，实时输出见下方',
      'setup.installSucceeded': '安装完成，已检测到 code-server',
      'setup.installExitedNonZero': '安装进程退出码 {code}，见下方输出',
      'setup.installFailed': '安装未成功：{detail}',
      'setup.log': '安装输出',
      'setup.logEmpty': '命令已启动，暂时没有输出。npm 在非终端环境下不打印进度，可能在数分钟内只有结束时的一行汇总。',
      'setup.logHide': '收起安装输出',
      'setup.logShow': '查看安装输出',
      'setup.commandLine': '执行命令',
      'setup.pidless': '进程已创建',
      'setup.detect': '重新检测',
      'setup.hint': '安装命令由插件配置决定，不会使用浏览器传来的参数。也可以自行安装后点「重新检测」。',
      'setup.output': '安装输出',
      'setup.installFailed': '安装未成功：{detail}',
      'editor.title': '代码编辑器',
      'editor.refresh': '刷新',
      'editor.openNewTab': '在新标签打开',
      'editor.start': '启动编辑器',
      'editor.starting': '正在启动…',
      'editor.autoStarting': '正在为这个工作区启动编辑器…',
      'editor.retry': '重试',
      'editor.close': '关闭编辑器',
      'editor.empty': '编辑器尚未启动',
      'editor.emptyHint': '打开这个标签页会自动启动，也可以点下方按钮手动启动。',
      'editor.noWorkspace': '无法确定当前工作区',
      'editor.noWorkspaceHint': '请先在工作区列表里打开一个会话，再回到这里。',
      'editor.folder': '工作区',
      'editor.extensionsShared': '扩展全局共享',
      'state.starting': '启动中',
      'state.ready': '就绪',
      'state.failed': '启动失败',
      'state.unknown': '未知状态',
      'action.failed': '操作失败：{detail}',
      'disabled': '编辑器插件已在配置中停用',
      'status.installed': '已检测到 {version}',
      'status.installedUnknownVersion': '已检测到 code-server',
    }
    const EN_DICT = {
      'title': 'Code editor',
      'guide.description': 'Open the current workspace in VS Code inside the sidebar',
      'status.loading': 'Reading editor state…',
      'status.error': 'Could not read the editor service state',
      'status.retry': 'Retry',
      'setup.title': 'Install code-server',
      'setup.description': 'This plugin does not bundle code-server, and {executable} was not found on the host. Install it on the host, then re-detect here.',
      'setup.command': 'Install command',
      'setup.copy': 'Copy command',
      'setup.copied': 'Copied',
      'setup.copyFailed': 'Copy failed — select the command manually',
      'setup.install': 'Install now',
      'setup.installConfirm': 'Confirm running this command on the host',
      'setup.installing': 'Installing…',
      'setup.installStarted': 'Install process started — live output below',
      'setup.installSucceeded': 'Install finished; code-server was detected',
      'setup.installExitedNonZero': 'The install process exited with code {code}; see the output below',
      'setup.log': 'Install output',
      'setup.logEmpty': 'The command is running with no output yet. npm prints no progress without a TTY, so it can stay quiet for minutes and then print one summary line.',
      'setup.logHide': 'Hide install output',
      'setup.logShow': 'Show install output',
      'setup.commandLine': 'Command',
      'setup.pidless': 'Process started',
      'setup.detect': 'Re-detect',
      'setup.hint': 'The install command comes from plugin configuration, never from the browser. You can also install it yourself and re-detect.',
      'setup.output': 'Install output',
      'setup.installFailed': 'Install did not succeed: {detail}',
      'editor.title': 'Code editor',
      'editor.refresh': 'Refresh',
      'editor.openNewTab': 'Open in a new tab',
      'editor.start': 'Start editor',
      'editor.starting': 'Starting…',
      'editor.autoStarting': 'Starting an editor for this workspace…',
      'editor.retry': 'Retry',
      'editor.close': 'Close editor',
      'editor.empty': 'Editor is not running',
      'editor.emptyHint': 'Opening this tab starts it automatically; you can also start it manually below.',
      'editor.noWorkspace': 'No current workspace',
      'editor.noWorkspaceHint': 'Open a session from the workspace list first, then come back here.',
      'editor.folder': 'Workspace',
      'editor.extensionsShared': 'Extensions shared',
      'state.starting': 'Starting',
      'state.ready': 'Ready',
      'state.failed': 'Failed to start',
      'state.unknown': 'Unknown state',
      'action.failed': 'Action failed: {detail}',
      'disabled': 'The editor plugin is disabled in configuration',
      'status.installed': 'Detected {version}',
      'status.installedUnknownVersion': 'code-server detected',
    }

    /** Substitute `{name}` placeholders; unknown names stay literal. */
    function applyParams(template, params) {
      if (!params) return template
      return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match))
    }

    /** One readable line for whatever a fetch path threw. Duck-typed so a
     * cross-realm error (e.g. one crossing the module sandbox) still reads. */
    function errorMessage(error) {
      if (error !== null && typeof error === 'object'
        && typeof error.message === 'string' && error.message !== '') return error.message
      if (typeof error === 'string' && error !== '') return error
      return 'unknown error'
    }

    /** The fetch this page uses; the sandbox's own when there is no window. */
    function pageFetch() {
      return typeof window !== 'undefined' && typeof window.fetch === 'function'
        ? window.fetch.bind(window)
        : fetch
    }

    async function readJson(fetchImpl, url, options) {
      const response = await fetchImpl(url, options)
      const body = await response.json().catch(() => null)
      if (response?.ok !== true) {
        const reason = typeof body?.error === 'string' && body?.error !== ''
          ? body.error
          : `HTTP ${response?.status}`
        throw new Error(reason)
      }
      return body
    }

    const readState = (fetchImpl) => readJson(fetchImpl, STATE_PATH(), { headers: { accept: 'application/json' } })

    const reDetect = (fetchImpl) => readJson(fetchImpl, DETECT_PATH(), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: '{}',
    })

    const runInstall = (fetchImpl) => readJson(fetchImpl, INSTALL_PATH(), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    })

    /** One poll of the running install's live output. */
    const readInstallLog = (fetchImpl) => readJson(fetchImpl, INSTALL_LOG_PATH(), {
      headers: { accept: 'application/json' },
    })

    const startInstance = (fetchImpl, workspace) => readJson(fetchImpl, SESSIONS_PATH(), {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: workspace.workspaceId,
        workspacePath: workspace.path,
        ...(typeof workspace.title === 'string' && workspace.title !== ''
          ? { workspaceTitle: workspace.title } : {}),
      }),
    })

    const closeInstance = (fetchImpl, id) => readJson(fetchImpl, sessionPath(id), {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    })

    /** Keep only rows with a usable id; normalise an unknown state. */
    function parseInstances(rows) {
      if (!Array.isArray(rows)) return []
      const states = ['starting', 'ready', 'failed']
      return rows
        .filter((row) => row !== null && typeof row === 'object' && typeof row.id === 'string' && row.id !== '')
        .map((row) => ({ ...row, state: states.includes(row.state) ? row.state : 'unknown' }))
    }

    /** Pick this workspace's instance. Ownership is per Workspace, not per
     * session, so every tab in a workspace must find the same row. */
    function instanceFor(instances, workspaceId) {
      if (typeof workspaceId !== 'string' || workspaceId === '') return null
      return instances.find((row) => row.workspaceId === workspaceId) ?? null
    }

    /**
     * Resolve the Workspace the pane is showing.
     *
     * Membership (`sessionIds`) is the primary key; a session not yet attached
     * to its Workspace still resolves by its canonical cwd. `useWorkspaces` is
     * a global standard prop, so it is available on the session-scoped seat.
     *
     * @param {unknown} items `useWorkspaces(...).items`.
     * @param {string} sessionId the pane's session.
     * @param {unknown} cwd `useSessions(...).cwd`.
     * @returns {{workspaceId: string, path: string, title: string}|null}
     */
    function findWorkspace(items, sessionId, cwd) {
      const rows = Array.isArray(items) ? items : []
      let found
      if (typeof sessionId === 'string' && sessionId !== '') {
        found = rows.find((item) => item !== null && typeof item === 'object'
          && Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))
      }
      if (found === undefined && typeof cwd === 'string' && cwd !== '') {
        found = rows.find((item) => item !== null && typeof item === 'object' && item.path === cwd)
      }
      if (found === undefined || found === null) return null
      if (typeof found.workspaceId !== 'string' || found.workspaceId === '') return null
      if (typeof found.path !== 'string' || found.path === '') return null
      return {
        workspaceId: found.workspaceId,
        path: found.path,
        title: typeof found.title === 'string' ? found.title : '',
      }
    }

    const stateKeyFor = (state) => `state.${state}`

    /** Original glyph: a code bracket inside a window frame. */
    function TabGlyph({ size }) {
      return React.createElement('svg', {
        viewBox: '0 0 24 24',
        width: size || 20,
        height: size || 20,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false,
      },
        React.createElement('rect', { x: '2.5', y: '3.5', width: '19', height: '17', rx: '2.5' }),
        React.createElement('path', { d: 'M2.5 8.5h19' }),
        React.createElement('path', { d: 'M9.5 12.5L7.5 15l2 2.5' }),
        React.createElement('path', { d: 'M14.5 12.5l2 2.5-2 2.5' }),
      )
    }

    function installStyle() {
      if (typeof document === 'undefined') return () => {}
      const style = document.createElement('style')
      style.id = 'dsh-code-server-style'
      style.dataset.plugin = '@yiln-dsh/dsh-code-server'
      style.textContent = `
.dsh-cs-shell { height:100%; min-height:0; display:flex; flex-direction:column; box-sizing:border-box;
  background:var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #f5f5f4));
  color:var(--dsw-alias-label-primary, #111827); font-size:13px; overflow:hidden; }
.dsh-cs-bar { flex:0 0 auto; display:flex; align-items:center; gap:6px; min-height:40px; padding:4px 8px;
  box-sizing:border-box; border-bottom:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); }
.dsh-cs-title { flex:1 1 auto; min-width:0; font-size:11px; font-weight:600; letter-spacing:.02em;
  text-transform:uppercase; color:var(--dsw-alias-label-secondary,#57534e); white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; }
.dsh-cs-tool { width:26px; height:26px; display:inline-flex; align-items:center; justify-content:center;
  border:0; border-radius:var(--dsw-radius-sm,6px); background:transparent;
  color:var(--dsw-alias-label-secondary,#4b5563); font:inherit; font-size:14px; line-height:1; cursor:pointer; }
.dsh-cs-tool:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,#e7e5e4)); }
.dsh-cs-tool:focus-visible { outline:none; box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#2563eb)); }
.dsh-cs-tool:disabled { opacity:.4; cursor:default; }
.dsh-cs-body { flex:1 1 auto; min-height:0; min-width:0; display:flex; flex-direction:column; overflow:hidden; }
.dsh-cs-center { flex:1 1 auto; min-height:0; display:flex; flex-direction:column; align-items:center;
  justify-content:center; gap:10px; padding:16px; box-sizing:border-box; text-align:center;
  color:var(--dsw-alias-label-secondary,#57534e); }
.dsh-cs-heading { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary,#111827); }
.dsh-cs-note { max-width:320px; font-size:12px; line-height:17px; overflow-wrap:anywhere; }
.dsh-cs-code { display:block; max-width:100%; padding:8px 10px; box-sizing:border-box; border-radius:var(--dsw-radius-sm,6px);
  border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); background:var(--dsw-alias-bg-layer-1,#fff);
  font-family:var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size:11.5px;
  text-align:left; overflow-wrap:anywhere; }
.dsh-cs-logwrap { flex:0 0 auto; display:flex; flex-direction:column; min-height:0;
  max-height:40%; border-top:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); }
.dsh-cs-loghead { flex:0 0 auto; display:flex; align-items:center; justify-content:space-between;
  gap:8px; padding:5px 10px; box-sizing:border-box; font-size:11px; line-height:15px;
  font-weight:600; letter-spacing:.02em; text-transform:uppercase;
  color:var(--dsw-alias-label-secondary,#57534e);
  border-bottom:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); }
.dsh-cs-logmeta { flex:1 1 auto; min-width:0; font-weight:400; text-transform:none; letter-spacing:0;
  color:var(--dsw-alias-label-tertiary,#9ca3af); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-cs-logclose { flex:0 0 auto; width:20px; height:20px; padding:0; box-sizing:border-box;
  display:inline-flex; align-items:center; justify-content:center;
  border:0; border-radius:var(--dsw-radius-sm,6px); background:transparent;
  color:var(--dsw-alias-label-secondary,#6b7280); font:inherit; font-size:14px; line-height:1;
  cursor:pointer; }
.dsh-cs-logclose:hover { background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,#e7e5e4));
  color:var(--dsw-alias-label-primary,#1f2937); }
.dsh-cs-logclose:focus-visible { outline:none;
  box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#2563eb)); }
.dsh-cs-output { flex:1 1 auto; min-height:0; max-height:none; overflow:auto; margin:0; padding:8px 10px;
  font-family:var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size:11px;
  line-height:15px; white-space:pre-wrap; overflow-wrap:anywhere;
  color:var(--dsw-alias-label-secondary,#57534e); }
.dsh-cs-btn { display:inline-flex; align-items:center; justify-content:center; gap:6px; min-height:30px;
  padding:0 12px; box-sizing:border-box; border:0; border-radius:var(--dsw-radius-sm,6px);
  background:var(--dsw-alias-brand-primary,#4f46e5); color:var(--dsw-alias-label-primary-inverted,#fff);
  font:inherit; font-size:13px; font-weight:500; cursor:pointer; }
.dsh-cs-btn:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover-accent,#4338ca); }
.dsh-cs-btn:focus-visible { outline:none; box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#2563eb)); }
.dsh-cs-btn:disabled { opacity:.5; cursor:default; }
.dsh-cs-btn-secondary { display:inline-flex; align-items:center; justify-content:center; min-height:28px;
  padding:0 10px; box-sizing:border-box; border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));
  border-radius:var(--dsw-radius-sm,6px); background:transparent;
  color:var(--dsw-alias-label-primary,#111827); font:inherit; font-size:12px; cursor:pointer; }
.dsh-cs-btn-secondary:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,#e7e5e4)); }
.dsh-cs-btn-secondary:disabled { opacity:.5; cursor:default; }
.dsh-cs-row { display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:center; }
.dsh-cs-status { display:inline-flex; align-items:center; gap:6px; font-size:12px;
  color:var(--dsw-alias-label-secondary,#57534e); }
.dsh-cs-dot { width:8px; height:8px; border-radius:50%; background:var(--dsw-alias-state-idle-primary,#9ca3af); }
.dsh-cs-dot[data-state="starting"] { background:var(--dsw-alias-state-warn-primary,#d97706); }
.dsh-cs-dot[data-state="ready"] { background:var(--dsw-alias-state-success-primary,#16a34a); }
.dsh-cs-dot[data-state="failed"] { background:var(--dsw-alias-state-error-primary,#dc2626); }
.dsh-cs-error { color:var(--dsw-alias-state-error-primary,#dc2626); font-size:12px; line-height:17px;
  overflow-wrap:anywhere; }
.dsh-cs-meta { flex:0 0 auto; padding:5px 10px; box-sizing:border-box;
  border-bottom:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); font-size:11px; line-height:15px;
  color:var(--dsw-alias-label-secondary,#57534e); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-cs-frame { flex:1 1 auto; min-height:0; min-width:0; width:100%; height:100%; border:0; display:block; background:#1e1e1e; }
`
      document.head.append(style)
      return () => style.remove()
    }

    /** Inert readers for a bare render outside the seat (unit tests). */
    const noTabInfo = () => null
    const noUseSessions = () => undefined
    const noUseWorkspaces = () => undefined
    /**
     * One shared empty list.
     *
     * The workspace selector MUST return a reference-stable value: the hook
     * compares snapshots by reference, so a fresh `?? []` on every call makes
     * every render look like a change, which re-renders forever and throws out
     * of the whole tab body (the pane then renders blank — no toolbar at all).
     * Selector results are therefore only widened to this constant here, never
     * allocated inside the selector.
     */
    const EMPTY_WORKSPACES = []

    function createShell(t) {
      return function CodeServerShell(props) {
        const [state, setState] = React.useState(null)
        const [failure, setFailure] = React.useState(null)
        const [action, setAction] = React.useState(null)
        const [installOutput, setInstallOutput] = React.useState('')
        /**
         * The live install job: `{ phase, running, command, exitCode, error }`.
         * Kept separate from `action` because the job outlives the click that
         * started it — the POST answers 202 immediately.
         */
        const [installJob, setInstallJob] = React.useState(null)
        /**
         * Whether the install log is shown.
         *
         * The log belongs to the running job: it must disappear once the job is
         * done and did succeed, or the panel keeps a dead terminal that eats
         * half the sidebar. A FAILED job stays visible on purpose — that output
         * is the only thing explaining what went wrong — and the header's × is
         * the user's way out either way.
         */
        const [logOpen, setLogOpen] = React.useState(false)
        const [confirmInstall, setConfirmInstall] = React.useState(false)
        const [copied, setCopied] = React.useState(false)
        const [refreshKey, setRefreshKey] = React.useState(0)
        /** Workspace ids already auto-started in this mounted pane, so a failed
         * start waits for the user instead of retrying on every state poll. */
        const autoStartedRef = React.useRef(new Set())

        const useTabInfo = typeof props?.useTabInfo === 'function' ? props.useTabInfo : noTabInfo
        const tabInfo = useTabInfo()
        const visible = tabInfo === null || tabInfo === undefined ? true : tabInfo?.tab?.visible !== false
        const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
        const useSessions = typeof props?.useSessions === 'function' ? props.useSessions : noUseSessions
        const cwd = useSessions((sessions) => sessions?.byId?.[sessionId]?.cwd)
        const useWorkspaces = typeof props?.useWorkspaces === 'function' ? props.useWorkspaces : noUseWorkspaces
        // Select the stored list itself (reference-stable) and only substitute
        // the shared empty list outside the selector; allocating inside it
        // would make every render a "change".
        const storedWorkspaceItems = useWorkspaces((snapshot) => snapshot?.items)
        const workspaceItems = Array.isArray(storedWorkspaceItems) ? storedWorkspaceItems : EMPTY_WORKSPACES
        const workspace = findWorkspace(workspaceItems, sessionId, cwd)

        // Read once per reveal and then poll while shown. A hidden tab neither
        // reads nor polls: nobody is looking at it, and its iframe is already
        // released by the seat.
        React.useEffect(() => {
          if (!visible) return undefined
          let live = true
          let inFlight = false
          const read = async () => {
            if (inFlight) return
            inFlight = true
            try {
              const next = await readState(pageFetch())
              if (!live) return
              setState(next)
              setFailure(null)
            } catch (error) {
              if (!live) return
              setFailure(errorMessage(error))
            } finally {
              inFlight = false
            }
          }
          void read()
          const timer = setInterval(() => { void read() }, POLL_MS)
          timer.unref?.()
          return () => { live = false; clearInterval(timer) }
        }, [visible, refreshKey])

        const refresh = () => setRefreshKey((key) => key + 1)
        // A failed action is not "busy": its Retry button must stay usable.
        const busy = action !== null && action.failed !== true

        const runAction = async (kind, work) => {
          if (busy) return
          setAction({ kind })
          try {
            await work()
            setAction(null)
            refresh()
          } catch (error) {
            setAction({ kind, failed: true, detail: errorMessage(error) })
          }
        }

        const onStart = (target) => void runAction('start', () => startInstance(pageFetch(), target ?? workspace))
        const onClose = (id) => void runAction('close', () => closeInstance(pageFetch(), id))
        const onDetect = () => void runAction('detect', () => reDetect(pageFetch()).then((next) => setState(next)))
        const onInstall = () => void runAction('install', () => runInstall(pageFetch()).then((result) => {
          // 202: the process is running and the panel polls /install/log.
          if (result?.state !== undefined && result.state !== null) setState(result.state)
          if (result?.state?.install !== undefined) setInstallJob(result.state.install)
          // A fresh run always reveals the log: the user just asked for it.
          setLogOpen(true)
          setConfirmInstall(false)
        }))

        /**
         * Poll the install's live output while it runs.
         *
         * `state.install.running` (from the existing /state poll) is the trigger,
         * so this stops on its own when the job settles — no timer outlives the
         * job, and a panel reopened mid-install picks the run back up.
         */
        const installRunning = state?.install?.running === true
        React.useEffect(() => {
          if (!visible || !installRunning) return undefined
          let live = true
          let inFlight = false
          const tick = async () => {
            if (inFlight) return
            inFlight = true
            try {
              const log = await readInstallLog(pageFetch())
              if (!live) return
              // The Host keeps the whole retained tail, so this is a full
              // re-render of the log rather than an append: it stays correct
              // when the tail is trimmed, and needs no cursor bookkeeping.
              setInstallOutput(typeof log?.text === 'string' ? log.text : '')
              setInstallJob({
                phase: log?.phase ?? null,
                running: log?.running === true,
                command: log?.command ?? '',
                exitCode: log?.exitCode ?? null,
                error: log?.error ?? null,
              })
              if (log?.running !== true) {
                // Success closes the log by itself (the setup page is about to
                // turn into an editor); failure keeps it for diagnosis.
                if (log?.phase === 'succeeded') setLogOpen(false)
                refresh()
              }
            } catch {
              // A transient poll failure is not worth tearing the view down.
            } finally {
              inFlight = false
            }
          }
          void tick()
          const timer = setInterval(() => { void tick() }, 1000)
          timer.unref?.()
          return () => { live = false; clearInterval(timer) }
        }, [visible, installRunning])

        // Opening the tab *is* the request to see this workspace, so start its
        // editor automatically. One automatic attempt per workspace per mounted
        // pane: a failed start waits for the user's Retry instead of hammering
        // the Host on every 4-second poll. A manual close is also honoured —
        // the id stays in the set, so close does not immediately re-open.
        const workspaceId = workspace?.workspaceId ?? ''
        React.useEffect(() => {
          if (!visible || state === null) return
          if (state.installed !== true || state.enabled === false) return
          if (workspace === null || action !== null || workspaceId === '') return
          if (instanceFor(parseInstances(state.instances), workspaceId) !== null) return
          if (autoStartedRef.current.has(workspaceId)) return
          autoStartedRef.current.add(workspaceId)
          void runAction('start', () => startInstance(pageFetch(), workspace))
        }, [visible, state, workspaceId, action, refreshKey])

        const onCopy = async () => {
          const command = typeof state?.installCommand === 'string' ? state.installCommand : ''
          if (command === '') return
          try {
            if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText !== undefined) {
              await navigator.clipboard.writeText(command)
            } else {
              throw new Error('clipboard unavailable')
            }
            setCopied(true)
          } catch {
            setCopied(false)
            setFailure(t('setup.copyFailed'))
          }
        }

        // --- loading / unreadable state ------------------------------------------
        // Every hook has run above, so returning early here is safe. This must
        // stay the FIRST thing after the hooks: the read succeeded only once
        // `state` is an object, and every projection below dereferences it.
        // (Reading `state.instances` before this check threw
        // "Cannot read properties of null" and blanked the whole pane.)
        if (state === null) {
          return React.createElement('div', { className: 'dsh-cs-shell' },
            React.createElement('div', { className: 'dsh-cs-center' },
              React.createElement('div', { className: 'dsh-cs-note' },
                failure !== null ? `${t('status.error')}: ${failure}` : t('status.loading')),
              failure !== null
                ? React.createElement('button', {
                  type: 'button', className: 'dsh-cs-btn-secondary', onClick: refresh,
                }, t('status.retry'))
                : null))
        }

        // --- setup guide ---------------------------------------------------
        const setupBody = () => React.createElement('div', { className: 'dsh-cs-center' },
          React.createElement('div', { className: 'dsh-cs-heading' }, t('setup.title')),
          React.createElement('div', { className: 'dsh-cs-note' },
            applyParams(t('setup.description'), { executable: state.executable ?? 'code-server' })),
          React.createElement('div', { className: 'dsh-cs-note', style: { fontWeight: 600 } }, t('setup.command')),
          React.createElement('code', { className: 'dsh-cs-code' }, state.installCommand || '—'),
          React.createElement('div', { className: 'dsh-cs-row' },
            React.createElement('button', {
              type: 'button', className: 'dsh-cs-btn-secondary', onClick: () => { void onCopy() },
            }, copied ? t('setup.copied') : t('setup.copy')),
            React.createElement('button', {
              type: 'button',
              className: 'dsh-cs-btn',
              disabled: busy || action?.kind === 'install' || state.installCommand === '',
              onClick: () => { if (confirmInstall) onInstall(); else setConfirmInstall(true) },
            }, confirmInstall
              ? t('setup.installConfirm')
              : action?.kind === 'install' || installRunning ? t('setup.installing') : t('setup.install')),
            React.createElement('button', {
              type: 'button', className: 'dsh-cs-btn-secondary', disabled: busy || installRunning,
              onClick: () => { setConfirmInstall(false); onDetect() },
            }, t('setup.detect')),
            // Once the log is hidden, this is how it comes back — including
            // after a failure whose output is the only explanation.
            installJob !== null && !logOpen
              ? React.createElement('button', {
                type: 'button', className: 'dsh-cs-btn-secondary', onClick: () => setLogOpen(true),
              }, t('setup.logShow'))
              : null),
          // The job's own state, separate from the click that started it. The
          // panel shows the command that is actually running and how it ended,
          // so "nothing happened" can never be the only feedback.
          installJob !== null
            ? React.createElement('div', { className: 'dsh-cs-note', role: 'status' },
              installJob.running === true
                ? t('setup.installStarted')
                : installJob.error !== null && installJob.error !== undefined
                  ? applyParams(t('setup.installFailed'), { detail: String(installJob.error) })
                  : installJob.exitCode !== null && installJob.exitCode !== 0
                    ? applyParams(t('setup.installExitedNonZero'), { code: String(installJob.exitCode) })
                    : t('setup.installSucceeded'))
            : null,
          installJob?.command !== undefined && installJob.command !== '' && installJob.running === true
            ? React.createElement(React.Fragment, null,
              React.createElement('div', { className: 'dsh-cs-note', style: { fontWeight: 600 } }, t('setup.commandLine')),
              React.createElement('code', { className: 'dsh-cs-code' }, installJob.command))
            : null,
          action?.failed === true
            ? React.createElement('div', { className: 'dsh-cs-error', role: 'alert' },
              applyParams(t('setup.installFailed'), { detail: action.detail }))
            : null,
          failure !== null
            ? React.createElement('div', { className: 'dsh-cs-error', role: 'alert' }, failure)
            : null,
          React.createElement('div', { className: 'dsh-cs-note' }, t('setup.hint')))

        // --- editor --------------------------------------------------------
        const instances = parseInstances(state.instances)
        const row = instanceFor(instances, workspace?.workspaceId ?? '')
        const statusLabel = (value) => t(stateKeyFor(value))

        const editorBody = () => {
          if (workspace === null) {
            return React.createElement('div', { className: 'dsh-cs-center' },
              React.createElement('div', { className: 'dsh-cs-heading' }, t('editor.noWorkspace')),
              React.createElement('div', { className: 'dsh-cs-note' }, t('editor.noWorkspaceHint')))
          }
          if (row === null) {
            const starting = action?.kind === 'start' && action.failed !== true
            return React.createElement('div', { className: 'dsh-cs-center' },
              React.createElement('div', { className: 'dsh-cs-heading' },
                starting ? t('editor.autoStarting') : t('editor.empty')),
              React.createElement('div', { className: 'dsh-cs-note' }, t('editor.emptyHint')),
              action?.failed === true
                ? React.createElement('div', { className: 'dsh-cs-error', role: 'alert' },
                  applyParams(t('action.failed'), { detail: action.detail }))
                : null,
              React.createElement('button', {
                type: 'button', className: 'dsh-cs-btn', disabled: busy,
                onClick: () => onStart(workspace),
              }, action?.failed === true ? t('editor.retry')
                : starting ? t('editor.starting') : t('editor.start')))
          }
          if (row.state !== 'ready') {
            return React.createElement('div', { className: 'dsh-cs-center' },
              React.createElement('div', { className: 'dsh-cs-status' },
                React.createElement('span', { className: 'dsh-cs-dot', 'data-state': row.state }),
                statusLabel(row.state)),
              row.error !== null && row.error !== undefined && row.error !== ''
                ? React.createElement('div', { className: 'dsh-cs-error', role: 'alert' }, String(row.error))
                : null,
              React.createElement('div', { className: 'dsh-cs-row' },
                React.createElement('button', {
                  type: 'button', className: 'dsh-cs-btn-secondary', disabled: busy,
                  onClick: () => onClose(row.id),
                }, t('editor.close')),
                React.createElement('button', {
                  type: 'button', className: 'dsh-cs-btn-secondary', disabled: busy,
                  onClick: refresh,
                }, t('editor.refresh'))))
          }
          return React.createElement('iframe', {
            key: row.id,
            className: 'dsh-cs-frame',
            src: instanceUrl(row),
            title: t('editor.title'),
            allow: 'clipboard-read; clipboard-write; fullscreen',
          })
        }

        const installedStatus = state.version
          ? applyParams(t('status.installed'), { version: state.version })
          : t('status.installedUnknownVersion')

        return React.createElement('div', { className: 'dsh-cs-shell' },
          React.createElement('div', { className: 'dsh-cs-bar' },
            React.createElement('span', { className: 'dsh-cs-title' }, t('editor.title')),
            row !== null
              ? React.createElement('button', {
                type: 'button', className: 'dsh-cs-tool',
                title: t('editor.close'), 'aria-label': t('editor.close'),
                disabled: busy, onClick: () => onClose(row.id),
              }, '×')
              : null,
            state.installed === true && row !== null
              ? React.createElement('a', {
                className: 'dsh-cs-tool', href: instanceUrl(row), target: '_blank',
                rel: 'noopener noreferrer', title: t('editor.openNewTab'),
                'aria-label': t('editor.openNewTab'),
              }, '↗')
              : null,
            React.createElement('button', {
              type: 'button', className: 'dsh-cs-tool', title: t('editor.refresh'),
              'aria-label': t('editor.refresh'), disabled: busy, onClick: refresh,
            }, '⟳')),
          React.createElement('div', { className: 'dsh-cs-body' },
            state.enabled === false
              ? React.createElement('div', { className: 'dsh-cs-center' },
                React.createElement('div', { className: 'dsh-cs-note' }, t('disabled')))
              : state.installed !== true
                ? setupBody()
                : React.createElement(React.Fragment, null,
                React.createElement('div', {
                  className: 'dsh-cs-meta',
                  title: row?.workspacePath ?? installedStatus,
                },
                  row !== null
                    ? `${t('editor.folder')}: ${row.workspaceTitle || row.workspacePath || '—'} · ${statusLabel(row.state)} · ${t('editor.extensionsShared')}`
                    : installedStatus),
                editorBody())),
          // The live log stays mounted for the whole job (running or settled),
          // and shows a waiting line rather than vanishing while output is
          // still empty — a process that has started but printed nothing yet
          // must still look like a process that started.
          logOpen && installJob !== null
            ? React.createElement('div', { className: 'dsh-cs-logwrap' },
              React.createElement('div', { className: 'dsh-cs-loghead' },
                React.createElement('span', null, t('setup.log')),
                React.createElement('span', { className: 'dsh-cs-logmeta' },
                  installJob.running === true
                    ? t('setup.installing')
                    : installJob.exitCode === null || installJob.exitCode === undefined
                      ? ''
                      : `exit ${installJob.exitCode}`),
                // Always available: a finished job must not leave a panel the
                // user cannot dismiss, and a running one can be hidden too —
                // the poll keeps going, reopening shows the accumulated tail.
                React.createElement('button', {
                  type: 'button',
                  className: 'dsh-cs-logclose',
                  title: t('setup.logHide'),
                  'aria-label': t('setup.logHide'),
                  onClick: () => setLogOpen(false),
                }, '×')),
              React.createElement('pre', { className: 'dsh-cs-output' },
                installOutput !== '' ? installOutput : t('setup.logEmpty')))
            : null)
      }
    }

    /** The tab-type definition contributed to the product's registry. */
    function createTabDefinition(t) {
      return {
        id: TAB_ID,
        kind: TAB_KIND,
        priority: 'extension',
        title: () => t('title'),
        guide: [{
          id: TAB_KIND,
          order: 26,
          title: () => t('title'),
          description: () => t('guide.description'),
          icon: TabGlyph,
        }],
      }
    }

    /**
     * Render the shell, turning a throw into visible text.
     *
     * A tab body that throws is dropped by the renderer, and the pane goes
     * blank — including this plugin's own toolbar — which gives the user
     * nothing to report. This boundary keeps the failure readable instead.
     */
    function createGuardedShell(t) {
      const Inner = createShell(t)
      return function CodeServerBoundary(props) {
        const [error, setError] = React.useState(null)
        if (error !== null) {
          return React.createElement('div', { className: 'dsh-cs-shell' },
            React.createElement('div', { className: 'dsh-cs-center' },
              React.createElement('div', { className: 'dsh-cs-heading' }, t('status.error')),
              React.createElement('div', { className: 'dsh-cs-error', role: 'alert' }, error)))
        }
        try {
          return React.createElement(Inner, props)
        } catch (thrown) {
          // Rendering a sibling state update is not allowed during render, so
          // the message is published from an effect-scheduled update instead.
          setError(errorMessage(thrown))
          return null
        }
      }
    }

    const inject = ['slots', 'locale', 'sidebarRightTabs']

    function apply(ctx) {
      const slots = ctx.get('slots')
      const sidebarRightTabs = ctx.get('sidebarRightTabs')
      const locale = ctx.get('locale')
      // The right Sidebar arrived in a later DSH than this suite's floor;
      // without its registry and pane seat there is nowhere to contribute.
      if (slots === undefined || sidebarRightTabs === undefined) return

      if (locale !== undefined) {
        ctx.effect(() => locale.register(LOCALE_NS, { zh: ZH_DICT, en: EN_DICT }), 'code-server: locale')
      }
      ctx.effect(() => installStyle(), 'code-server: stylesheet')

      const t = locale !== undefined
        ? locale.bind(LOCALE_NS)
        : (key, params) => applyParams(ZH_DICT[key] ?? EN_DICT[key] ?? key, params)

      const Shell = createGuardedShell(t)
      ctx.effect(() => {
        const disposeType = sidebarRightTabs.register(createTabDefinition(t))
        const disposeBody = slots.inject('sidebar.right.pane.tab', () => slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: LOCALE_NS,
        }, Shell))
        return () => { disposeBody(); disposeType() }
      }, 'code-server: right sidebar tab')
    }

    return {
      name: 'code-server-client',
      inject,
      apply,
      __test: {
        LOCALE_NS,
        TAB_ID,
        TAB_KIND,
        POLL_MS,
        BASE,
        STATE_PATH,
        DETECT_PATH,
        INSTALL_PATH,
        INSTALL_LOG_PATH,
        SESSIONS_PATH,
        sessionPath,
        instanceUrl,
        ZH_DICT,
        EN_DICT,
        applyParams,
        errorMessage,
        parseInstances,
        instanceFor,
        findWorkspace,
        EMPTY_WORKSPACES,
        stateKeyFor,
        createTabDefinition,
        createShell,
        createGuardedShell,
      },
    }
  },
})
