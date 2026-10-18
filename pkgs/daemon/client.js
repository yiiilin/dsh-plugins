window.__ModuleLoader__.load({
  id: '@yiln-dsh/dsh-daemon',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const NS = 'daemon'
    const h = React.createElement

    const ZH = {
      title: '开发守护',
      hint: '一个入口，多个环境。每个环境是另一台机器上的完整 dsh：它自己跑工具、自己存会话，所以没有网络延迟。',
      refresh: '刷新',
      unreachable: '无法读取守护状态（管理接口只接受已登录的请求）。',
      empty: '还没有环境。创建一个，把 token 填到那台机器的 dsh 配置里。',
      colName: '名称', colPath: '访问路径', colToken: '令牌', colState: '状态', colActions: '操作',
      online: '在线', offline: '离线', never: '从未连接',
      open: '打开', rotate: '换令牌', remove: '移除',
      labelLabel: '名称（可留空）', labelPlaceholder: '例如 6.13',
      create: '创建环境', creating: '创建中…',
      tokenOnce: '这个令牌只显示一次，请现在复制',
      tokenHint: '把它填到那台机器 dsh 的 daemon 配置：role=edge，并填上主节点地址。',
      confirmRemove: '移除环境 {id}？那台机器上的 dsh 不会被删除，只是不再连进来。',
      confirmRotate: '为 {id} 换一个新令牌？旧令牌立即失效，那台机器要改成新令牌才能重连。',
      removed: '已移除 {id}。', rotated: '已为 {id} 换令牌。',
      actionFailed: '操作失败：{message}',
      edgeNote: '这台 dsh 是边端：它连向主节点，自己不管理其它环境。要在这里管理环境，把 role 改成 main。',
      switcherLabel: '环境',
      switcherLocal: '本机',
      switcherOffline: '（离线）',
      switcherTitle: '切换环境：打开另一台机器上的 dsh',
      switcherFailed: '无法读取环境列表',
    }

    const EN = {
      title: 'Daemon',
      hint: 'One entry, many environments. Each is a complete dsh on another machine: it runs its own tools and keeps its own sessions, so there is no network latency.',
      refresh: 'Refresh',
      unreachable: 'Could not read daemon state (the admin API only answers authenticated requests).',
      empty: 'No environments yet. Create one and put its token in that machine\'s dsh config.',
      colName: 'Name', colPath: 'Path', colToken: 'Token', colState: 'State', colActions: 'Actions',
      online: 'online', offline: 'offline', never: 'never connected',
      open: 'Open', rotate: 'Rotate token', remove: 'Remove',
      labelLabel: 'Name (optional)', labelPlaceholder: 'e.g. 6.13',
      create: 'Create environment', creating: 'Creating…',
      tokenOnce: 'This token is shown once — copy it now',
      tokenHint: 'Put it in that machine\'s dsh daemon config: role=edge, plus this node\'s address.',
      confirmRemove: 'Remove environment {id}? The dsh on that machine stays; it just stops connecting here.',
      confirmRotate: 'Give {id} a new token? The old one stops working immediately, and that machine must be updated before it can reconnect.',
      removed: 'Removed {id}.', rotated: 'New token issued for {id}.',
      actionFailed: 'Failed: {message}',
      edgeNote: 'This dsh is an edge: it connects to a main node and manages no environments itself. Set role to main to manage them here.',
      switcherLabel: 'Environment',
      switcherLocal: 'This host',
      switcherOffline: ' (offline)',
      switcherTitle: 'Switch environment: open the dsh on another machine',
      switcherFailed: 'Could not read the environment list',
    }

    const styles = {
      wrap: { padding: '18px 20px', maxWidth: 1100, margin: '0 auto' },
      hint: { margin: '0 0 6px', opacity: 0.7, fontSize: 13 },
      detail: { fontSize: 11, opacity: 0.6, marginTop: 2 },
      mono: { fontFamily: 'ui-monospace, monospace', fontSize: 12 },
      dim: { opacity: 0.6, fontSize: 13 },
      ok: { color: '#2f855a', fontSize: 13 },
      error: { color: '#c53030', fontSize: 13 },
      note: { marginTop: 12, padding: '10px 12px', background: 'rgba(128,128,128,.08)', borderRadius: 6, fontSize: 13 },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
      cell: { padding: '7px 8px', borderBottom: '1px solid rgba(128,128,128,.18)', textAlign: 'left', verticalAlign: 'top' },
      button: { marginRight: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer', borderRadius: 5, border: '1px solid rgba(128,128,128,.35)', background: 'transparent' },
      input: { padding: '5px 8px', fontSize: 13, borderRadius: 5, border: '1px solid rgba(128,128,128,.35)', background: 'transparent', marginRight: 8 },
      form: { display: 'flex', alignItems: 'center', gap: 0, marginTop: 16, flexWrap: 'wrap' },
      tokenBox: { margin: '10px 0', padding: '10px 12px', borderRadius: 6, background: 'rgba(214,158,46,.12)', border: '1px solid rgba(214,158,46,.4)' },
      tokenTitle: { fontSize: 13, fontWeight: 600, marginBottom: 6 },
      switcher: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px', fontSize: 12 },
      switcherLabel: { flex: 'none', opacity: 0.65, fontSize: 11 },
      switcherSelect: {
        flex: 1, minWidth: 0, padding: '3px 6px', fontSize: 12, borderRadius: 5,
        border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit',
      },
      tokenCode: { display: 'block', fontFamily: 'ui-monospace, monospace', fontSize: 12, wordBreak: 'break-all', userSelect: 'all' },
    }

    const call = async (path, options) => {
      const response = await fetch(path, { credentials: 'same-origin', ...options })
      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` }
      }
    }

    /** Rail icon for the global panel list. */
    const PanelIcon = () => h('svg', {
      width: 18,
      height: 18,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': 'true',
    },
    h('rect', { key: 'a', x: 3, y: 4, width: 18, height: 6, rx: 2 }),
    h('rect', { key: 'b', x: 3, y: 14, width: 18, height: 6, rx: 2 }),
    h('circle', { key: 'c', cx: 7, cy: 7, r: 0.9, fill: 'currentColor', stroke: 'none' }),
    h('circle', { key: 'd', cx: 7, cy: 17, r: 0.9, fill: 'currentColor', stroke: 'none' }))

    /** Panel page: the environment list, and the form that adds one. */
    const makePanelPage = (t) => function DaemonPanelPage() {
      const [state, setState] = useState({ phase: 'loading', self: undefined, environments: [] })
      const [busy, setBusy] = useState('')
      const [flash, setFlash] = useState('')
      const [token, setToken] = useState('')
      const [label, setLabel] = useState('')

      const load = useCallback(async () => {
        try {
          const result = await call('/admin/state')
          if (result.ok) setState({ phase: 'ready', self: result.self, environments: result.environments ?? [] })
          else setState({ phase: 'failed', self: undefined, environments: [], error: result.error })
        } catch (error) {
          setState({ phase: 'failed', self: undefined, environments: [], error: String(error) })
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const create = useCallback(async () => {
        setBusy('create')
        setFlash('')
        setToken('')
        try {
          const result = await call('/admin/environments', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ label: label.trim() === '' ? undefined : label.trim() }),
          })
          if (result.ok) {
            // Shown once: the token is the edge's credential, not a display value.
            setToken(result.token)
            setLabel('')
            await load()
          } else {
            setFlash(t('actionFailed').replace('{message}', result.error ?? ''))
          }
        } finally {
          setBusy('')
        }
      }, [label, load, t])

      const remove = useCallback(async (entry) => {
        if (!confirm(t('confirmRemove').replace('{id}', entry.id))) return
        setBusy(entry.id)
        try {
          const result = await call(`/admin/environments/${entry.id}`, { method: 'DELETE' })
          setFlash(result.ok ? t('removed').replace('{id}', entry.id) : t('actionFailed').replace('{message}', result.error ?? ''))
          await load()
        } finally {
          setBusy('')
        }
      }, [load, t])

      const rotate = useCallback(async (entry) => {
        if (!confirm(t('confirmRotate').replace('{id}', entry.id))) return
        setBusy(entry.id)
        try {
          const result = await call(`/admin/environments/${entry.id}/token`, { method: 'POST' })
          if (result.ok) {
            setToken(result.token)
            setFlash(t('rotated').replace('{id}', entry.id))
            await load()
          } else {
            setFlash(t('actionFailed').replace('{message}', result.error ?? ''))
          }
        } finally {
          setBusy('')
        }
      }, [load, t])

      const role = state.self?.role ?? 'main'
      const children = [h('p', { key: 'hint', style: styles.hint }, t('hint'))]
      if (flash !== '') children.push(h('div', { key: 'flash', style: styles.ok }, flash))

      if (token !== '') {
        children.push(h('div', { key: 'token', style: styles.tokenBox },
          h('div', { style: styles.tokenTitle }, t('tokenOnce')),
          h('code', { style: styles.tokenCode }, token),
          h('p', { style: styles.hint }, t('tokenHint'))))
      }

      if (state.phase === 'failed') children.push(h('div', { key: 'error', style: styles.error }, t('unreachable')))

      if (role === 'main') {
        const rows = state.environments.map((entry) => h('tr', { key: entry.id },
          h('td', { style: styles.cell },
            h('div', null, entry.label),
            entry.hostname === undefined ? null : h('div', { style: styles.detail }, entry.hostname)),
          h('td', { style: { ...styles.cell, ...styles.mono } }, `/${entry.id}/`),
          h('td', { style: { ...styles.cell, ...styles.mono } }, entry.tokenHint),
          h('td', { style: styles.cell },
            h('span', { style: entry.online ? styles.ok : styles.dim }, entry.online ? t('online') : t('offline')),
            entry.online || entry.lastSeen === undefined
              ? null
              : h('div', { style: styles.detail }, new Date(entry.lastSeen).toLocaleString())),
          h('td', { style: styles.cell },
            entry.online ? h('button', { key: 'open', style: styles.button, onClick: () => window.open(`/${entry.id}/`, '_blank') }, t('open')) : null,
            h('button', { key: 'rot', style: styles.button, disabled: busy !== '', onClick: () => void rotate(entry) }, t('rotate')),
            h('button', { key: 'rm', style: styles.button, disabled: busy !== '', onClick: () => void remove(entry) }, t('remove')))))

        const table = h('table', { style: styles.table },
          h('thead', null, h('tr', null,
            ['colName', 'colPath', 'colToken', 'colState', 'colActions'].map((key) => h('th', { key, style: styles.cell }, t(key))))),
          h('tbody', null, state.environments.length === 0
            ? h('tr', null, h('td', { colSpan: 5, style: { ...styles.cell, ...styles.dim } }, t('empty')))
            : rows))

        children.push(h('div', { key: 'table', style: { marginTop: 14 } }, table))
        children.push(h('div', { key: 'form', style: styles.form },
          h('label', { key: 'l' }, `${t('labelLabel')} `),
          h('input', {
            key: 'i', style: styles.input, value: label,
            placeholder: t('labelPlaceholder'),
            onChange: (event) => setLabel(event.target.value),
          }),
          h('button', { key: 'b', style: styles.button, disabled: busy !== '', onClick: () => void create() },
            busy === 'create' ? t('creating') : t('create'))))
      } else {
        children.push(h('div', { key: 'edge', style: styles.note }, t('edgeNote')))
      }

      children.push(h('div', { key: 'actions', style: { marginTop: 14 } },
        h('button', { style: styles.button, disabled: busy !== '', onClick: () => void load() }, t('refresh'))))

      return h('div', { style: styles.wrap }, children)
    }


    /**
     * Environment switcher in the sidebar footer.
     *
     * A plain `select` because it is a location, not a state: choosing one navigates.
     * The list is fetched once on mount and refreshed when the panel loads, since an
     * environment's online state changes without anything here noticing.
     */
    const makeSwitcher = (t) => function EnvironmentSwitcher() {
      const [state, setState] = useState({ phase: 'loading', role: 'main', current: '', environments: [] })

      useEffect(() => {
        let cancelled = false
        void (async () => {
          try {
            const result = await call('/admin/state')
            if (cancelled) return
            if (result.ok) {
              setState({
                phase: 'ready',
                role: result.self?.role ?? 'main',
                current: result.self?.rootPrefix ?? '',
                environments: result.environments ?? [],
              })
            } else {
              setState((prev) => ({ ...prev, phase: 'failed' }))
            }
          } catch {
            if (!cancelled) setState((prev) => ({ ...prev, phase: 'failed' }))
          }
        })()
        return () => { cancelled = true }
      }, [])

      // An edge has no other environments to offer, and no list to build one from.
      if (state.phase === 'loading' || state.role !== 'main' || state.environments.length === 0) return null

      // Where we are now, so the control shows the truth rather than a default.
      const path = window.location.pathname
      const active = state.current !== '' && (path === `/${state.current}` || path.startsWith(`/${state.current}/`))
        ? state.current
        : state.environments.map((one) => one.id).find((id) => path.startsWith(`/${id}/`)) ?? ''

      return h('label', { style: styles.switcher, title: t('switcherTitle') },
        h('span', { style: styles.switcherLabel }, t('switcherLabel')),
        h('select', {
          style: styles.switcherSelect,
          value: active,
          onChange: (event) => {
            const id = event.target.value
            window.location.href = id === '' ? '/' : `/${id}/`
          },
        },
        h('option', { value: '' }, t('switcherLocal')),
        // Offline environments stay in the list: removing them would read as deletion,
        // and the operator needs to see that a machine is simply unreachable.
        ...state.environments.map((one) => h('option', {
          key: one.id,
          value: one.id,
          disabled: one.online !== true,
        }, `${one.label}${one.online === true ? '' : t('switcherOffline')}`))))
    }

    const apply = (ctx) => {
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'daemon: locale')
      const t = ctx.locale.bind(NS)
      // Rail button …
      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'daemon',
        order: 40,
        label: () => t('title'),
      }, PanelIcon)), 'daemon: panel entry')
      // … and the page it opens, keyed by the same id.
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'daemon',
        inject: () => ({}),
      }, makePanelPage(t))), 'daemon: panel page')
      // The switcher lives at the bottom of the sidebar: `sidebar.workspaces` is a
      // single slot owned upstream, so there is no "above the workspace list" to use.
      ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'daemon-environment-switcher',
        order: -20,
        inject: () => ({}),
      }, makeSwitcher(t))), 'daemon: environment switcher')
    }

    return { name: 'daemon-client', inject: ['locale', 'slots'], apply, __test: { call, ZH, EN } }
  },
})
