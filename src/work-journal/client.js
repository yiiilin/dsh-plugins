/**
 * work-journal — browser bundle (static DSH client module).
 *
 * Contributes one page tab to the official right Sidebar: a report browser over
 * the host half's incremental index. The panel renders the structured
 * aggregate (overview, per-day distribution, prompts, files, sessions) and can
 * copy the identical Markdown the model tool returns, so what is read in the
 * browser and what is asked for in a conversation come from one computation.
 *
 * All host data arrives over the plugin's own `/work-journal` RPC channel; the
 * panel never touches the session log itself.
 */
window.__ModuleLoader__.load({
  id: '@yiln-dsh/dsh-plugins/work-journal',
  factory: (require) => {
    const React = require('react')

    /** Tab-system identity, unique across every registration. */
    const TAB_ID = '@yiln-dsh/dsh-plugins/work-journal'
    /** Page kind opened through `ctx.sidebarRight.openTab`. */
    const TAB_KIND = 'work-journal.journal'
    const LOCALE_NS = 'work-journal'
    /** RPC channel registered by the host half. */
    const CHANNEL = '/work-journal'

    const ZH_DICT = {
      'title': '工作日志',
      'guide.description': '查看日报、周报、月报',
      'range.day': '今日',
      'range.week': '本周',
      'range.month': '本月',
      'range.recent': '近 7 天',
      'range.all': '全部',
      'refresh': '刷新索引',
      'copy': '复制 Markdown',
      'copied': '已复制',
      'loading': '正在读取…',
      'empty': '这个时间段没有记录到 DSH 活动。',
      'unavailable': '工作日志服务不可用。',
      'failed': '读取失败：{message}',
      'activeDays': '活跃天数',
      'activeTime': '活跃时长',
      'sessions': '主会话 / 子 agent',
      'prompts': '我的需求',
      'toolCalls': '工具调用',
      'outputTokens': '模型输出 tokens',
      'overview': '概览',
      'promptsSection': '我提的需求',
      'daysSection': '每日分布',
      'projectsSection': '项目分布',
      'filesSection': '改动的文件',
      'toolsSection': '工具使用',
      'sessionsSection': '会话清单',
      'indexLine': '索引：{indexed}/{sessions} 个会话，更新于 {updated}',
      'projectFilter': '项目',
      'allProjects': '全部项目',
      'more': '…其余 {count} 条已省略',
      'subagent': '子 agent',
      'hours': '小时',
      'minutes': '分',
      'lessThanMinute': '不足 1 分钟',
    }
    const EN_DICT = {
      'title': 'Work journal',
      'guide.description': 'Daily, weekly and monthly reports',
      'range.day': 'Today',
      'range.week': 'This week',
      'range.month': 'This month',
      'range.recent': 'Last 7 days',
      'range.all': 'All',
      'refresh': 'Refresh index',
      'copy': 'Copy Markdown',
      'copied': 'Copied',
      'loading': 'Loading…',
      'empty': 'No DSH activity was recorded in this period.',
      'unavailable': 'The work journal service is unavailable.',
      'failed': 'Read failed: {message}',
      'activeDays': 'Active days',
      'activeTime': 'Active time',
      'sessions': 'Sessions / subagents',
      'prompts': 'My requests',
      'toolCalls': 'Tool calls',
      'outputTokens': 'Output tokens',
      'overview': 'Overview',
      'promptsSection': 'What I asked for',
      'daysSection': 'Per day',
      'projectsSection': 'Per project',
      'filesSection': 'Files changed',
      'toolsSection': 'Tools used',
      'sessionsSection': 'Sessions',
      'indexLine': 'Index: {indexed}/{sessions} sessions, updated {updated}',
      'projectFilter': 'Project',
      'allProjects': 'All projects',
      'more': '…{count} more omitted',
      'subagent': 'subagent',
      'hours': 'h',
      'minutes': 'm',
      'lessThanMinute': '<1 min',
    }

    const RANGES = ['day', 'week', 'month', 'recent', 'all']

    /** Interpolate `{name}` placeholders without pulling in a formatter. */
    function applyParams(text, params) {
      if (params === undefined) return text
      return String(text).replace(/\{(\w+)\}/gu, (match, key) => (params[key] === undefined ? match : String(params[key])))
    }

    /** Group an integer with thousands separators. */
    function formatInt(value) {
      const n = Number.isFinite(value) ? Math.round(value) : 0
      return String(n).replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
    }

    /** Compact duration in the current language. */
    function formatDuration(ms, t) {
      const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60000) : 0
      if (total < 1) return t('lessThanMinute')
      const hours = Math.floor(total / 60)
      const minutes = total % 60
      if (hours === 0) return `${minutes}${t('minutes')}`
      return minutes === 0 ? `${hours}${t('hours')}` : `${hours}${t('hours')} ${minutes}${t('minutes')}`
    }

    /** Local wall-clock `HH:MM` for one instant, using the report's own offset. */
    function formatClock(time, tzOffsetMinutes) {
      if (!Number.isFinite(time)) return ''
      return new Date(time + tzOffsetMinutes * 60000).toISOString().slice(11, 16)
    }

    /** Read the plugin's RPC channel, mapping transport failures to one error. */
    function createClient(caller) {
      const call = async (endpoint, payload, signal) => {
        let result
        try {
          result = await caller.call(CHANNEL, endpoint, payload, signal)
        } catch {
          throw Object.assign(new Error('unavailable'), { code: 'unavailable' })
        }
        if (result?.ok !== true) {
          const error = new Error(result?.error?.message ?? 'request failed')
          error.code = result?.error?.code ?? 'failed'
          throw error
        }
        return result.value
      }
      return {
        query: (payload, signal) => call('query', payload, signal),
        status: (signal) => call('status', {}, signal),
      }
    }

    function createPanel(t, client) {
      return function WorkJournalPanel() {
        const [range, setRange] = React.useState('week')
        const [state, setState] = React.useState({ status: 'loading', value: null, error: null, copied: false })
        const [project, setProject] = React.useState('')
        const active = React.useRef(null)

        const load = React.useCallback(async (nextRange, options) => {
          active.current?.abort()
          const controller = new AbortController()
          const life = { controller, live: true }
          active.current = life
          setState((old) => ({ ...old, status: 'loading', error: null, copied: false }))
          try {
            const value = await client.query({ range: nextRange, refresh: options?.refresh === true }, controller.signal)
            if (life.live) setState({ status: 'ready', value, error: null, copied: false })
          } catch (error) {
            if (life.live) setState({ status: 'error', value: null, error: error.code ?? 'failed', copied: false })
          }
        }, [])

        React.useEffect(() => {
          load(range)
          return () => { active.current?.abort() }
        }, [range, load])

        const report = state.value?.report
        const projects = report?.projects ?? []
        const activeProject = project === '' ? undefined : project
        const visible = React.useMemo(() => {
          if (report === undefined || activeProject === undefined) return report
          return filterReport(report, activeProject)
        }, [report, activeProject])

        const copy = async () => {
          const markdown = state.value?.markdown ?? ''
          try {
            if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined) await navigator.clipboard.writeText(markdown)
            setState((old) => ({ ...old, copied: true }))
          } catch {
            setState((old) => ({ ...old, copied: false }))
          }
        }

        const header = React.createElement('div', { className: 'wj-header' },
          React.createElement('div', { className: 'wj-ranges' }, RANGES.map((kind) =>
            React.createElement('button', {
              key: kind, type: 'button', className: 'wj-chip',
              'aria-pressed': range === kind,
              onClick: () => setRange(kind),
            }, t(`range.${kind}`)))),
          React.createElement('div', { className: 'wj-actions' },
            React.createElement('button', {
              type: 'button', className: 'wj-action', disabled: state.status === 'loading',
              onClick: () => load(range, { refresh: true }),
            }, t('refresh')),
            React.createElement('button', {
              type: 'button', className: 'wj-action', disabled: report === undefined,
              onClick: copy,
            }, t(state.copied ? 'copied' : 'copy'))))

        if (state.status === 'loading' && state.value === null) {
          return React.createElement('div', { className: 'wj-panel' }, header,
            React.createElement('div', { className: 'wj-note' }, t('loading')))
        }
        if (state.status === 'error' && state.value === null) {
          const key = state.error === 'unavailable' ? 'unavailable' : 'failed'
          return React.createElement('div', { className: 'wj-panel' }, header,
            React.createElement('div', { className: 'wj-note wj-error' }, t(key, { message: state.error })))
        }
        if (report === undefined) {
          return React.createElement('div', { className: 'wj-panel' }, header,
            React.createElement('div', { className: 'wj-note' }, t('unavailable')))
        }

        const tz = report.tzOffsetMinutes
        const totals = report.totals
        const children = [header]

        if (projects.length > 1) {
          children.push(React.createElement('div', { className: 'wj-filter', key: 'filter' },
            React.createElement('span', { className: 'wj-filter-label' }, t('projectFilter')),
            React.createElement('select', {
              className: 'wj-select', value: project,
              onChange: (event) => setProject(event.target.value),
            },
            React.createElement('option', { value: '' }, t('allProjects')),
            projects.map((entry) => React.createElement('option', { key: entry.project, value: entry.project }, entry.project)))))
        }

        if (totals.sessions === 0 && totals.childSessions === 0) {
          children.push(React.createElement('div', { className: 'wj-note', key: 'empty' }, t('empty')))
        } else {
          children.push(React.createElement('div', { className: 'wj-cards', key: 'cards' },
            card(t('activeDays'), String(totals.days)),
            card(t('activeTime'), formatDuration(totals.activeMs, t)),
            card(t('sessions'), `${formatInt(totals.sessions)} / ${formatInt(totals.childSessions)}`),
            card(t('prompts'), formatInt(totals.prompts)),
            card(t('toolCalls'), formatInt(totals.toolCalls)),
            card(t('outputTokens'), formatInt(totals.outputTokens))))

          if (visible.prompts.length > 0) {
            children.push(section(t('promptsSection'), 'prompts',
              visible.prompts.map((prompt, index) => React.createElement('div', { className: 'wj-prompt', key: `${prompt.sessionId}-${index}` },
                React.createElement('div', { className: 'wj-prompt-meta' },
                  `${prompt.date} ${formatClock(prompt.time, tz)} · ${prompt.project}`),
                React.createElement('div', { className: 'wj-prompt-text' }, prompt.text)))))
          }

          if (visible.days.length > 0) {
            children.push(section(t('daysSection'), 'days', [React.createElement('table', { className: 'wj-table', key: 'days' },
              React.createElement('thead', null, React.createElement('tr', null,
                ['日期', '时段', '活跃时长', '会话', '需求', '工具'].map((label, index) => React.createElement('th', { key: index }, label)))),
              React.createElement('tbody', null, visible.days.map((day) => React.createElement('tr', { key: day.date },
                React.createElement('td', null, day.date),
                React.createElement('td', null, day.firstTime === undefined ? '—' : `${formatClock(day.firstTime, tz)}–${formatClock(day.lastTime, tz)}`),
                React.createElement('td', null, formatDuration(day.activeMs, t)),
                React.createElement('td', null, String(day.sessions)),
                React.createElement('td', null, String(day.prompts)),
                React.createElement('td', null, String(day.toolCalls))))))]))
          }

          if (visible.projects.length > 0) {
            children.push(section(t('projectsSection'), 'projects', [React.createElement('table', { className: 'wj-table', key: 'projects' },
              React.createElement('thead', null, React.createElement('tr', null,
                ['项目', '会话', '需求', '轮次', '工具'].map((label, index) => React.createElement('th', { key: index }, label)))),
              React.createElement('tbody', null, visible.projects.map((entry) => React.createElement('tr', { key: entry.project },
                React.createElement('td', null, entry.project),
                React.createElement('td', null, String(entry.sessions)),
                React.createElement('td', null, String(entry.prompts)),
                React.createElement('td', null, String(entry.turns)),
                React.createElement('td', null, String(entry.toolCalls))))))]))
          }

          if (visible.files.length > 0) {
            children.push(section(t('filesSection'), 'files',
              visible.files.slice(0, 15).map((file) => React.createElement('div', { className: 'wj-row', key: file.path },
                React.createElement('code', { className: 'wj-path' }, file.path),
                React.createElement('span', { className: 'wj-count' }, `× ${file.count}`)))))
          }

          if (visible.tools.length > 0) {
            children.push(section(t('toolsSection'), 'tools', [React.createElement('div', { className: 'wj-tools', key: 'tools' },
              visible.tools.map((tool) => React.createElement('span', { className: 'wj-tool', key: tool.name }, `${tool.name} × ${tool.count}`)))]))
          }

          if (visible.sessions.length > 0) {
            children.push(section(t('sessionsSection'), 'sessions',
              visible.sessions.map((session) => React.createElement('div', { className: 'wj-session', key: session.id },
                React.createElement('div', { className: 'wj-session-title' },
                  session.title.length > 0 ? session.title : session.id,
                  session.origin === 'subagent' ? React.createElement('span', { className: 'wj-tag' }, t('subagent')) : null),
                React.createElement('div', { className: 'wj-session-meta' },
                  `${session.project} · ${formatClock(session.firstTime, tz)}–${formatClock(session.lastTime, tz)} · ${t('prompts')} ${session.prompts} · ${t('toolCalls')} ${session.toolCalls}`)))))
          }
        }

        if (state.value.index !== undefined) {
          children.push(React.createElement('div', { className: 'wj-index', key: 'index' },
            t('indexLine', {
              indexed: state.value.index.indexed,
              sessions: state.value.index.sessions,
              updated: state.value.index.updatedAt === 0 ? '—' : new Date(state.value.index.updatedAt).toLocaleString(),
            })))
        }

        return React.createElement('div', { className: 'wj-panel' }, children)
      }
    }

    /** One overview card. */
    function card(label, value) {
      return React.createElement('div', { className: 'wj-card', key: label },
        React.createElement('div', { className: 'wj-card-value' }, value),
        React.createElement('div', { className: 'wj-card-label' }, label))
    }

    /** One collapsible report section. */
    function section(title, key, body) {
      return React.createElement('section', { className: 'wj-section', key },
        React.createElement('h3', { className: 'wj-section-title' }, title),
        body)
    }

    /** Narrow a report to one project, mirroring the host's own filter. */
    function filterReport(report, project) {
      const projects = report.projects.filter((entry) => entry.project === project)
      const sessions = report.sessions.filter((session) => session.project === project)
      const ids = new Set(sessions.map((session) => session.id))
      const tools = {}
      const files = {}
      const commands = {}
      for (const entry of projects) {
        for (const [name, count] of Object.entries(entry.tools ?? {})) tools[name] = (tools[name] ?? 0) + count
        for (const [path, count] of Object.entries(entry.files ?? {})) files[path] = (files[path] ?? 0) + count
        // Commands come from the project entry, never from the day list: a day
        // mixes every project's shell history.
        for (const [command, count] of Object.entries(entry.commands ?? {})) commands[command] = (commands[command] ?? 0) + count
      }
      const days = report.days
        .map((day) => ({ ...day, sessions: sessions.filter((session) => session.days.includes(day.date)).length }))
        .filter((day) => day.sessions > 0)
      return {
        ...report,
        projects,
        sessions,
        days,
        prompts: report.prompts.filter((prompt) => ids.has(prompt.sessionId)),
        tools: Object.entries(tools).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
        files: Object.entries(files).map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count),
        commands: Object.entries(commands).map(([command, count]) => ({ command, count })).sort((a, b) => b.count - a.count),
      }
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
.wj-header{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.wj-ranges{display:inline-flex;gap:2px;padding:2px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-2,#f0efee)}
.wj-chip{appearance:none;border:0;background:transparent;color:inherit;font:inherit;padding:3px 9px;border-radius:6px;cursor:pointer;white-space:nowrap}
.wj-chip[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 2px rgba(0,0,0,.08);font-weight:600}
.wj-chip:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,#2563eb)}
.wj-actions{display:inline-flex;gap:6px}
.wj-action{appearance:none;border:1px solid var(--dsw-alias-border-l1,#e0dedc);background:transparent;color:inherit;font:inherit;padding:3px 9px;border-radius:6px;cursor:pointer}
.wj-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#efeeec)}
.wj-action:disabled{opacity:.45;cursor:default}
.wj-filter{display:flex;align-items:center;gap:8px}
.wj-filter-label{color:var(--dsw-alias-label-secondary,#57534e)}
.wj-select{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l1,#e0dedc);border-radius:6px;padding:2px 6px}
.wj-note{color:var(--dsw-alias-label-secondary,#57534e);padding:8px 0}
.wj-error{color:var(--dsw-alias-state-error-primary,#dc2626)}
.wj-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:8px}
.wj-card{border:1px solid var(--dsw-alias-border-l1,#e7e5e4);border-radius:var(--dsw-radius-md,10px);padding:8px 10px;background:var(--dsw-alias-bg-layer-1,#fff)}
.wj-card-value{font-size:16px;font-weight:600;line-height:1.3;overflow-wrap:anywhere}
.wj-card-label{font-size:11px;color:var(--dsw-alias-label-secondary,#78716c)}
.wj-section{display:flex;flex-direction:column;gap:6px}
.wj-section-title{margin:6px 0 0;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#57534e);text-transform:none}
.wj-table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
.wj-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary,#78716c);border-bottom:1px solid var(--dsw-alias-border-l1,#e7e5e4);padding:3px 6px 3px 0}
.wj-table td{padding:3px 6px 3px 0;border-bottom:1px solid var(--dsw-alias-border-l2,#f5f5f4);vertical-align:top}
.wj-prompt{border-left:2px solid var(--dsw-alias-border-l1,#e0dedc);padding-left:8px;margin-bottom:6px}
.wj-prompt-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#78716c)}
.wj-prompt-text{overflow-wrap:anywhere}
.wj-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.wj-path{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;overflow-wrap:anywhere}
.wj-count{flex:none;color:var(--dsw-alias-label-secondary,#78716c);font-size:11px}
.wj-tools{display:flex;flex-wrap:wrap;gap:4px}
.wj-tool{font-size:11.5px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f0efee)}
.wj-session{margin-bottom:6px}
.wj-session-title{font-weight:500;overflow-wrap:anywhere}
.wj-tag{margin-left:6px;font-size:10.5px;font-weight:400;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#f0efee);color:var(--dsw-alias-label-secondary,#78716c)}
.wj-session-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#78716c);overflow-wrap:anywhere}
.wj-index{font-size:11px;color:var(--dsw-alias-label-dimmed,#a8a29e);border-top:1px solid var(--dsw-alias-border-l2,#f5f5f4);padding-top:6px}
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
      const client = createClient(caller)
      const Panel = createPanel(t, client)

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

    return { name: 'work-journal-client', inject: ['connection', 'locale', 'slots', 'sidebarRight', 'sidebarRightTabs'], apply, __test: { createClient, createPanel, filterReport, formatDuration, formatInt } }
  },
})
