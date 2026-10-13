/**
 * work-journal — browser bundle (static DSH client module).
 *
 * Contributes one page tab to the official right Sidebar: a browser over the
 * reports the host half has already generated (`reports/<kind>/<key>.md` plus
 * their metadata). The panel lists those reports newest-first with their time
 * span, searches them (keyword + semantic hybrid, ranked by the host store),
 * and renders the Markdown body of whichever report is opened.
 *
 * All host data arrives over the plugin's own `/api` route, multiplexed with
 * every other plugin; a runtime without the shared channel falls back to the
 * positional `/work-journal` RPC endpoint.
 */
window.__ModuleLoader__.load({
  id: '@yiln-dsh/dsh-plugins/work-journal',
  factory: (require) => {
    const React = require('react')

    /** Tab-system identity, unique across every registration. */
    const TAB_ID = '@yiln-dsh/dsh-plugins/work-journal'
    /** Page kind opened through `ctx.sidebarRight.openTab`. */
    const TAB_KIND = 'work-journal.journal'
    /** Left-rail panel id; also the `main` page key. */
    const PANEL_ID = 'work-journal'
    const LOCALE_NS = 'work-journal'
    /** Positional RPC channel registered by the host half (legacy runtime). */
    const CHANNEL = '/work-journal'
    /** Shared `/api` method name that carries `{ endpoint, payload }`. */
    const API_METHOD = 'work-journal'

    /** Report kinds and statuses the store can return. */
    const KINDS = ['day', 'week', 'month']
    const STATUSES = ['ok', 'failed', 'generating']
    /** Search mode: the store fuses its keyword and vector halves. */
    const SEARCH_MODE = 'hybrid'
    /** Reports fetched per list call; more than a year of dailies. */
    const LIST_LIMIT = 100
    const SEARCH_LIMIT = 30
    /** Keystroke quiet period before a search is issued. */
    const SEARCH_DELAY = 250
    const ERROR_CAP = 160

    const ZH_DICT = {
      'title': '工作日志',
      'guide.description': '查看日报、周报、月报',
      'refresh': '刷新列表',
      'loading': '正在读取…',
      'unavailable': '工作日志服务不可用。',
      'failed': '读取失败：{message}',
      'emptyList': '还没有生成任何报告。',
      'search': '搜索',
      'searchPlaceholder': '搜索报告内容…',
      'searching': '正在搜索…',
      'searchEmpty': '没有匹配的报告。',
      'searchResults': '搜索结果',
      'score': '相关度',
      'snippet': '命中片段',
      'span': '时间跨度',
      'generatedAt': '生成时间',
      'kind.day': '日报',
      'kind.week': '周报',
      'kind.month': '月报',
      'status.ok': '正常',
      'status.failed': '失败',
      'status.generating': '生成中',
      'detail': '报告正文',
      'back': '返回',
      'copy': '复制 Markdown',
      'copied': '已复制',
      'missing': '这份报告已不存在。',
      'emptyBody': '这份报告没有正文。',
    }
    const EN_DICT = {
      'title': 'Work journal',
      'guide.description': 'Daily, weekly and monthly reports',
      'refresh': 'Refresh list',
      'loading': 'Loading…',
      'unavailable': 'The work journal service is unavailable.',
      'failed': 'Read failed: {message}',
      'emptyList': 'No reports have been generated yet.',
      'search': 'Search',
      'searchPlaceholder': 'Search report contents…',
      'searching': 'Searching…',
      'searchEmpty': 'No report matched.',
      'searchResults': 'Search results',
      'score': 'Relevance',
      'snippet': 'Matched excerpt',
      'span': 'Time span',
      'generatedAt': 'Generated',
      'kind.day': 'Daily',
      'kind.week': 'Weekly',
      'kind.month': 'Monthly',
      'status.ok': 'OK',
      'status.failed': 'Failed',
      'status.generating': 'Generating',
      'detail': 'Report body',
      'back': 'Back',
      'copy': 'Copy Markdown',
      'copied': 'Copied',
      'missing': 'This report no longer exists.',
      'emptyBody': 'This report has no body.',
    }

    /** Interpolate `{name}` placeholders without pulling in a formatter. */
    function applyParams(text, params) {
      if (params === undefined) return text
      return String(text).replace(/\{(\w+)\}/gu, (match, key) => (params[key] === undefined ? match : String(params[key])))
    }

    /**
     * One instant as `YYYY-MM-DD HH:MM` in the deployment's own timezone.
     *
     * The offset comes from the host, not from the browser: a period boundary is
     * defined by the timezone the report was bucketed in, and rendering it in
     * UTC made the panel show `2026-10-11 16:00 ~ 2026-10-12 15:59` for a report
     * whose own body says `2026-10-12 00:00:00 ~ 2026-10-12 23:59:59`.
     * @param time - epoch milliseconds, possibly absent.
     * @param tzOffsetMinutes - minutes east of UTC; absent means UTC.
     * @returns the formatted stamp, or `''` when there is no usable instant.
     */
    function formatStamp(time, tzOffsetMinutes) {
      if (!Number.isFinite(time)) return ''
      const offset = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0
      const iso = new Date(time + offset * 60000).toISOString()
      return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
    }

    /**
     * The span shown on every entry: `start ~ end`, collapsed to one instant
     * when the period has no width (or the end is missing).
     * @param startTime - epoch milliseconds of the period start.
     * @param endTime - epoch milliseconds of the period end.
     * @param tzOffsetMinutes - minutes east of UTC; absent means UTC.
     * @returns the human-readable span, or `''` when unreadable.
     */
    function formatSpan(startTime, endTime, tzOffsetMinutes) {
      const start = formatStamp(startTime, tzOffsetMinutes)
      if (start === '') return ''
      const end = formatStamp(endTime, tzOffsetMinutes)
      if (end === '' || !(endTime > startTime)) return start
      return `${start} ~ ${end}`
    }

    /** Search rank as a two-decimal string; `''` when the store gave none. */
    function formatScore(score) {
      return Number.isFinite(score) ? score.toFixed(2) : ''
    }

    /** Localized kind label, empty for an unknown kind rather than a raw key. */
    function kindLabel(t, kind) {
      return KINDS.includes(kind) ? t(`kind.${kind}`) : ''
    }

    /** Localized status label, empty for an unknown status. */
    function statusLabel(t, status) {
      return STATUSES.includes(status) ? t(`status.${status}`) : ''
    }

    /** Collapse a thrown error into the `{ code, message }` a note renders. */
    function describeError(error) {
      const code = PASSED_CODES.includes(error?.code) ? error.code : 'failed'
      const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : code
      return { code, message: message.slice(0, ERROR_CAP) }
    }

    /** The localized sentence for one `{ code, message }`. */
    function noteFor(error, t) {
      if (error === null || error === undefined) return t('failed', { message: '' })
      if (error.code === 'unavailable') return t('unavailable')
      if (error.code === 'not-found') return t('missing')
      return t('failed', { message: error.message })
    }

    /**
     * Ride out keystrokes: each call replaces the pending one, so only the last
     * query within the quiet period reaches the host.
     * @param schedule - `{ later(fn, ms), cancel(id) }`, injected for testing.
     * @param callback - invoked once per quiet period.
     * @returns `{ schedule(delay), cancel() }`.
     */
    function deferSearch(schedule, callback) {
      let pending = null
      const fire = () => {
        pending = null
        callback()
      }
      return {
        schedule: (delay) => {
          if (pending !== null) schedule.cancel(pending)
          pending = schedule.later(fire, delay)
        },
        cancel: () => {
          if (pending !== null) schedule.cancel(pending)
          pending = null
        },
      }
    }

    /**
     * The host's timezone offset from a response, defaulting to UTC.
     *
     * An older host omits it, and a span rendered in the wrong zone is worse
     * than one rendered in UTC only because UTC is what that host meant.
     * @param value - one response value.
     * @returns minutes east of UTC.
     */
    function offsetOf(value) {
      return Number.isFinite(value?.tzOffsetMinutes) ? value.tzOffsetMinutes : 0
    }

    /** Keep only objects, so one malformed row cannot crash the list. */
    function recordsOf(value) {
      return Array.isArray(value) ? value.filter((entry) => entry !== null && typeof entry === 'object') : []
    }

    /** Newest period first, ties broken by key so the order is total. */
    function byStartDesc(a, b) {
      const startA = Number.isFinite(a.startTime) ? a.startTime : 0
      const startB = Number.isFinite(b.startTime) ? b.startTime : 0
      if (startA !== startB) return startB - startA
      return String(b.key ?? '').localeCompare(String(a.key ?? ''))
    }

    /** Error codes the panel reacts to specifically, rather than as "failed". */
    const PASSED_CODES = ['unavailable', 'not-found']

    /** Read the plugin's route, mapping transport failures to one error. */
    function createClient(caller, shared) {
      const call = async (endpoint, payload, signal) => {
        let result
        try {
          result = shared
            // One `/api` route multiplexes every plugin; the endpoint travels
            // in the payload instead of as a positional RPC method.
            ? await caller.call('/api', API_METHOD, { endpoint, payload }, signal)
            : await caller.call(CHANNEL, endpoint, payload, signal)
        } catch {
          throw Object.assign(new Error('unavailable'), { code: 'unavailable' })
        }
        if (result?.ok !== true) {
          const error = new Error(result?.error?.message ?? 'request failed')
          const code = result?.error?.code
          error.code = PASSED_CODES.includes(code) ? code : 'failed'
          throw error
        }
        return result.value
      }
      return {
        list: (payload, signal) => call('list', payload, signal),
        get: (payload, signal) => call('get', payload, signal),
        search: (payload, signal) => call('search', payload, signal),
      }
    }

    /**
     * Cancel the in-flight request held in a ref.
     *
     * The ref stores `{ controller, live }`; `live` must be cleared first so a
     * response that has already arrived cannot still set state. Calling
     * `.abort()` on the wrapper (rather than `.controller`) is what used to
     * crash the panel.
     */
    function cancelActive(ref) {
      const life = ref?.current
      if (life === null || life === undefined) return
      life.live = false
      life.controller?.abort()
    }

    const IDLE_SEARCH = Object.freeze({ status: 'idle', query: '', hits: [], error: null })
    const IDLE_DETAIL = Object.freeze({ key: '', status: 'idle', meta: null, body: '', error: null })

    /** The host's timers, resolved at call time so a test can supply its own. */
    const DEFAULT_SCHEDULE = {
      later: (fn, ms) => setTimeout(fn, ms),
      cancel: (id) => clearTimeout(id),
    }

    function createPanel(t, client, schedule = DEFAULT_SCHEDULE) {
      return function WorkJournalPanel() {
        const [list, setList] = React.useState({ status: 'loading', reports: [], tz: 0, error: null })
        const [text, setText] = React.useState('')
        const [search, setSearch] = React.useState(IDLE_SEARCH)
        const [detailTz, setDetailTz] = React.useState(0)
        const [detail, setDetail] = React.useState(IDLE_DETAIL)
        const [copied, setCopied] = React.useState(false)
        const active = React.useRef(null)
        const searchActive = React.useRef(null)
        const detailActive = React.useRef(null)
        const typed = React.useRef('')

        const load = React.useCallback(async () => {
          // `active.current` holds the {controller, live} pair, not the
          // controller; aborting the pair threw
          // "active.current?.abort is not a function" and blanked the page.
          cancelActive(active)
          const controller = new AbortController()
          const life = { controller, live: true }
          active.current = life
          setList((old) => ({ ...old, status: 'loading', error: null }))
          try {
            const value = await client.list({ limit: LIST_LIMIT }, controller.signal)
            if (life.live) {
              setList({ status: 'ready', reports: recordsOf(value?.reports).sort(byStartDesc), tz: offsetOf(value), error: null })
            }
          } catch (error) {
            if (life.live) setList({ status: 'error', reports: [], tz: 0, error: describeError(error) })
          }
        }, [])

        const runSearch = React.useCallback(async (value) => {
          const query = value.trim()
          cancelActive(searchActive)
          if (query.length === 0) {
            setSearch(IDLE_SEARCH)
            return
          }
          const controller = new AbortController()
          const life = { controller, live: true }
          searchActive.current = life
          setSearch({ status: 'loading', query, hits: [], tz: 0, error: null })
          try {
            const found = await client.search({ query, mode: SEARCH_MODE, limit: SEARCH_LIMIT }, controller.signal)
            if (life.live) setSearch({ status: 'ready', query, hits: recordsOf(found?.hits), tz: offsetOf(found), error: null })
          } catch (error) {
            if (life.live) setSearch({ status: 'error', query, hits: [], tz: 0, error: describeError(error) })
          }
        }, [])

        const openReport = React.useCallback(async (key) => {
          cancelActive(detailActive)
          const controller = new AbortController()
          const life = { controller, live: true }
          detailActive.current = life
          setCopied(false)
          setDetail({ key, status: 'loading', meta: null, body: '', error: null })
          try {
            const value = await client.get({ key }, controller.signal)
            if (!life.live) return
            if (value === null || value === undefined) setDetail({ key, status: 'missing', meta: null, body: '', error: null })
            else {
              setDetailTz(offsetOf(value))
              setDetail({ key, status: 'ready', meta: value.meta ?? null, body: typeof value.body === 'string' ? value.body : '', error: null })
            }
          } catch (error) {
            if (life.live) setDetail({ key, status: 'error', meta: null, body: '', error: describeError(error) })
          }
        }, [])

        const closeDetail = React.useCallback(() => {
          cancelActive(detailActive)
          setCopied(false)
          setDetail(IDLE_DETAIL)
        }, [])

        const copy = React.useCallback(async () => {
          try {
            if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) await navigator.clipboard.writeText(detail.body)
            setCopied(true)
          } catch {
            setCopied(false)
          }
        }, [detail.body])

        // Created once: the debounced callback reads the latest keystroke from
        // `typed`, so the schedule never holds a stale closure.
        const queue = React.useRef(null)
        if (queue.current === null) {
          queue.current = deferSearch(schedule, () => { void runSearch(typed.current) })
        }

        React.useEffect(() => {
          void load()
        }, [load])

        React.useEffect(() => () => {
          cancelActive(active)
          cancelActive(searchActive)
          cancelActive(detailActive)
          queue.current?.cancel()
        }, [])

        const onInput = (event) => {
          const value = typeof event?.target?.value === 'string' ? event.target.value : ''
          typed.current = value
          setText(value)
          if (value.trim().length === 0) {
            queue.current.cancel()
            cancelActive(searchActive)
            setSearch(IDLE_SEARCH)
            return
          }
          queue.current.schedule(SEARCH_DELAY)
        }

        const submitSearch = () => {
          queue.current.cancel()
          void runSearch(text)
        }

        const header = React.createElement('div', { className: 'wj-header' },
          React.createElement('button', {
            type: 'button', className: 'wj-action', disabled: list.status === 'loading',
            onClick: () => { void load() },
          }, t('refresh')))

        const searchBox = React.createElement('div', { className: 'wj-search' },
          React.createElement('input', {
            className: 'wj-input', type: 'search', value: text,
            placeholder: t('searchPlaceholder'), 'aria-label': t('searchPlaceholder'),
            onChange: onInput,
            onKeyDown: (event) => { if (event?.key === 'Enter') submitSearch() },
          }),
          React.createElement('button', { type: 'button', className: 'wj-action', onClick: submitSearch }, t('search')))

        let body
        if (detail.status !== 'idle') body = detailView(t, detail, copied, { back: closeDetail, copy: () => { void copy() } }, detailTz)
        else if (search.status !== 'idle') body = searchView(t, search, openReport)
        else body = listView(t, list, openReport)

        return React.createElement('div', { className: 'wj-panel' }, [header, searchBox, body])
      }
    }

    /** One entry: kind, label, status, time span and generation time. */
    function reportItem(t, meta, onOpen, key, tz) {
      const openable = typeof meta.key === 'string' && meta.key.length > 0
      return React.createElement('button', {
        key, type: 'button', className: 'wj-item', disabled: !openable,
        onClick: () => { if (openable) onOpen(meta.key) },
      },
      React.createElement('span', { className: 'wj-item-head' },
        React.createElement('span', { className: `wj-badge wj-badge-${meta.kind ?? 'unknown'}` }, kindLabel(t, meta.kind)),
        React.createElement('span', { className: 'wj-item-label' }, typeof meta.label === 'string' && meta.label.length > 0 ? meta.label : String(meta.key ?? '')),
        React.createElement('span', { className: `wj-status wj-status-${meta.status ?? 'unknown'}` }, statusLabel(t, meta.status))),
      React.createElement('span', { className: 'wj-span', title: t('span') }, formatSpan(meta.startTime, meta.endTime, tz)),
      React.createElement('span', { className: 'wj-stamp', title: t('generatedAt') }, formatStamp(meta.generatedAt, tz)),
      typeof meta.error === 'string' && meta.error.length > 0
        ? React.createElement('span', { className: 'wj-item-error' }, meta.error.slice(0, ERROR_CAP))
        : null)
    }

    /** The report list, in the three states it can be read in. */
    function listView(t, list, onOpen) {
      if (list.status === 'error') {
        return React.createElement('div', { className: 'wj-note wj-error', key: 'list' }, noteFor(list.error, t))
      }
      if (list.reports.length === 0) {
        return React.createElement('div', { className: 'wj-note', key: 'list' }, list.status === 'loading' ? t('loading') : t('emptyList'))
      }
      return React.createElement('div', { className: 'wj-list', key: 'list' },
        list.reports.map((meta, index) => reportItem(t, meta, onOpen, String(meta.key ?? index), list.tz)))
    }

    /** Search hits, ranked best-first by the host store. */
    function searchView(t, search, onOpen) {
      const children = [React.createElement('h3', { className: 'wj-section-title', key: 'title' }, t('searchResults'))]
      if (search.status === 'loading') {
        children.push(React.createElement('div', { className: 'wj-note', key: 'note' }, t('searching')))
      } else if (search.status === 'error') {
        children.push(React.createElement('div', { className: 'wj-note wj-error', key: 'note' }, noteFor(search.error, t)))
      } else if (search.hits.length === 0) {
        children.push(React.createElement('div', { className: 'wj-note', key: 'note' }, t('searchEmpty')))
      } else {
        children.push(React.createElement('div', { className: 'wj-list', key: 'list' }, search.hits.map((hit, index) => {
          const score = formatScore(hit.score)
          const openable = typeof hit.key === 'string' && hit.key.length > 0
          return React.createElement('button', {
            key: String(hit.key ?? index), type: 'button', className: 'wj-item', disabled: !openable,
            onClick: () => { if (openable) onOpen(hit.key) },
          },
          React.createElement('span', { className: 'wj-item-head' },
            React.createElement('span', { className: `wj-badge wj-badge-${hit.kind ?? 'unknown'}` }, kindLabel(t, hit.kind)),
            React.createElement('span', { className: 'wj-item-label' }, typeof hit.label === 'string' && hit.label.length > 0 ? hit.label : String(hit.key ?? '')),
            React.createElement('span', { className: `wj-status wj-status-${hit.status ?? 'unknown'}` }, statusLabel(t, hit.status)),
            score === '' ? null : React.createElement('span', { className: 'wj-score', title: t('score') }, score)),
          React.createElement('span', { className: 'wj-span', title: t('span') }, formatSpan(hit.startTime, hit.endTime, search.tz)),
          typeof hit.snippet === 'string' && hit.snippet.length > 0
            ? React.createElement('span', { className: 'wj-snippet', title: t('snippet') }, hit.snippet)
            : null)
        })))
      }
      return React.createElement('section', { className: 'wj-section', key: 'search' }, children)
    }

    /**
     * The opened report. Its body is the Markdown the generator wrote, shown as
     * text: the panel deliberately does not render or parse Markdown.
     */
    function detailView(t, detail, copied, actions, tz = 0) {
      const buttons = React.createElement('div', { className: 'wj-detail-head' },
        React.createElement('button', { type: 'button', className: 'wj-action', onClick: actions.back }, t('back')),
        React.createElement('button', {
          type: 'button', className: 'wj-action',
          disabled: detail.status !== 'ready' || detail.body.length === 0,
          onClick: actions.copy,
        }, t(copied ? 'copied' : 'copy')))

      let content
      if (detail.status === 'loading') {
        content = React.createElement('div', { className: 'wj-note' }, t('loading'))
      } else if (detail.status === 'error') {
        content = React.createElement('div', { className: 'wj-note wj-error' }, noteFor(detail.error, t))
      } else if (detail.status === 'missing') {
        content = React.createElement('div', { className: 'wj-note' }, t('missing'))
      } else if (detail.body.trim().length === 0) {
        content = React.createElement('div', { className: 'wj-note' }, t('emptyBody'))
      } else {
        content = React.createElement('pre', { className: 'wj-body' }, detail.body)
      }

      const meta = detail.meta
      const metaLine = meta === null
        ? null
        : React.createElement('div', { className: 'wj-detail-meta' },
          React.createElement('span', { className: `wj-badge wj-badge-${meta.kind ?? 'unknown'}` }, kindLabel(t, meta.kind)),
          React.createElement('span', { className: 'wj-item-label' }, typeof meta.label === 'string' ? meta.label : String(meta.key ?? detail.key)),
          React.createElement('span', { className: 'wj-span', title: t('span') }, formatSpan(meta.startTime, meta.endTime, tz)),
          React.createElement('span', { className: 'wj-stamp', title: t('generatedAt') }, formatStamp(meta.generatedAt, tz)))

      return React.createElement('section', { className: 'wj-detail', key: 'detail', 'aria-label': t('detail') }, [buttons, metaLine, content])
    }

    /** Tab glyph, drawn before the guide entry title. */
    function Glyph(props) {
      const size = props?.size ?? 16
      return React.createElement('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        React.createElement('rect', { x: 2, y: 2.5, width: 12, height: 11, rx: 2, stroke: 'currentColor', strokeWidth: 1.3 }),
        React.createElement('path', { d: 'M5 6h6M5 8.5h6M5 11h3.5', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }))
    }

    function installStyle() {
      if (typeof document === 'undefined') return () => {}
      const style = document.createElement('style')
      style.dataset.plugin = '@yiln-dsh/dsh-plugins'
      style.textContent = `
.wj-panel{height:100%;min-height:0;display:flex;flex-direction:column;gap:10px;overflow:auto;box-sizing:border-box;padding:10px 12px 20px;background:var(--dsw-specific-sidebar-fill,var(--dsw-alias-bg-base,#fafaf9));color:var(--dsw-alias-label-primary,#1c1917);font-size:13px;line-height:1.5}
.wj-header{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap}
.wj-action{appearance:none;border:1px solid var(--dsw-alias-border-l1,#e0dedc);background:transparent;color:inherit;font:inherit;padding:3px 9px;border-radius:6px;cursor:pointer}
.wj-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#efeeec)}
.wj-action:disabled{opacity:.45;cursor:default}
.wj-action:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,#2563eb)}
.wj-search{display:flex;gap:6px;align-items:center}
.wj-input{flex:1;min-width:0;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l1,#e0dedc);border-radius:6px;padding:3px 8px}
.wj-input:focus-visible{outline:none;border-color:var(--dsw-focus-ring-color,#2563eb)}
.wj-note{color:var(--dsw-alias-label-secondary,#57534e);padding:8px 0}
.wj-error{color:var(--dsw-alias-state-error-primary,#dc2626)}
.wj-section{display:flex;flex-direction:column;gap:6px}
.wj-section-title{margin:6px 0 0;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#57534e);text-transform:none}
.wj-list{display:flex;flex-direction:column;gap:6px}
.wj-item{appearance:none;display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l1,#e7e5e4);border-radius:var(--dsw-radius-md,10px);padding:7px 10px;background:var(--dsw-alias-bg-layer-1,#fff)}
.wj-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f5f5f4)}
.wj-item:disabled{cursor:default;opacity:.6}
.wj-item:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,#2563eb)}
.wj-item-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.wj-item-label{font-weight:600;overflow-wrap:anywhere}
.wj-item-error{font-size:11px;color:var(--dsw-alias-state-error-primary,#dc2626);overflow-wrap:anywhere}
.wj-badge{flex:none;font-size:10.5px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f0efee);color:var(--dsw-alias-label-secondary,#57534e)}
.wj-badge-week{background:var(--dsw-alias-bg-module-platform,#e7e5e4)}
.wj-badge-month{background:var(--dsw-alias-bg-layer-3,#e0dedc)}
.wj-status{margin-left:auto;flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,#78716c)}
.wj-status-failed{color:var(--dsw-alias-state-error-primary,#dc2626)}
.wj-status-generating{color:var(--dsw-alias-state-warning-primary,#b45309)}
.wj-span{font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#57534e)}
.wj-stamp{font-size:11px;color:var(--dsw-alias-label-dimmed,#a8a29e)}
.wj-score{flex:none;font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#78716c)}
.wj-snippet{font-size:11.5px;color:var(--dsw-alias-label-secondary,#78716c);overflow-wrap:anywhere}
.wj-detail{display:flex;flex-direction:column;gap:8px;min-height:0}
.wj-detail-head{display:flex;gap:6px}
.wj-detail-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.wj-body{margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,#e7e5e4);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1,#fff);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;overflow:auto}
`
      document.head.append(style)
      return () => style.remove()
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      const sidebarRightTabs = ctx.get('sidebarRightTabs')
      const locale = ctx.get('locale')
      if (slots === undefined || sidebarRightTabs === undefined) return

      if (locale !== undefined) {
        ctx.effect(() => locale.register(LOCALE_NS, { zh: ZH_DICT, en: EN_DICT }), 'work-journal: locale')
      }
      const t = locale !== undefined
        ? locale.bind(LOCALE_NS)
        : (key, params) => applyParams(ZH_DICT[key] ?? EN_DICT[key] ?? key, params)

      ctx.effect(() => installStyle(), 'work-journal: stylesheet')

      const connection = ctx.get('connection')
      const caller = connection?.rpc
      if (caller === undefined) return
      // A runtime exposing `generation` multiplexes every plugin route behind
      // one `/api` fetch endpoint; the older one still uses per-plugin channels.
      const shared = Reflect.has(connection, 'generation')
      const client = createClient(caller, shared)
      const Panel = createPanel(t, client)

      // Left rail, beside 插件 and 自动化任务, below 新建会话. `sidebar.panellist`
      // draws icon buttons and drives `layout.selectPanel(id)`; the page body
      // registers under the same id in `main`.
      ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        locale: LOCALE_NS,
        label: () => t('title'),
      }, Glyph)), 'work-journal: sidebar button')
      ctx.effect(() => slots.inject('main', () => slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: LOCALE_NS,
      }, Panel)), 'work-journal: main page')

      ctx.effect(() => {
        const disposeType = sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: () => t('title'),
          guide: [{
            id: 'work-journal',
            order: 22,
            title: () => t('title'),
            description: () => t('guide.description'),
            icon: Glyph,
          }],
        })
        // The body registers under the type's own id, in the seat the product
        // draws for whichever pane holds the tab.
        const disposeBody = slots.inject('sidebar.right.pane.tab', () => slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: LOCALE_NS,
        }, Panel))
        return () => {
          disposeBody()
          disposeType()
        }
      }, 'work-journal: right sidebar tab')
    }

    return {
      name: 'work-journal-client',
      inject: ['connection', 'locale', 'slots', 'sidebarRight', 'sidebarRightTabs'],
      apply,
      __test: {
        createClient,
        createPanel,
        cancelActive,
        deferSearch,
        describeError,
        formatSpan,
        formatStamp,
        offsetOf,
        formatScore,
        LIST_LIMIT,
        SEARCH_DELAY,
        SEARCH_LIMIT,
        SEARCH_MODE,
      },
    }
  },
})