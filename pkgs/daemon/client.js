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
      labelLabel: '名称', labelPlaceholder: '例如 6.13',
      rename: '改名', renamePrompt: '新的名称', renamed: '已改名',
      sectionEnvironments: '环境',
      create: '创建环境', creating: '创建中…',
      tokenOnce: '这个令牌只显示一次，请现在复制',
      tokenHint: '把它填到那台机器 dsh 的 daemon 配置：role=edge，并填上主节点地址。',
      confirmRemove: '移除环境 {id}？那台机器上的 dsh 不会被删除，只是不再连进来。',
      confirmRotate: '为 {id} 换一个新令牌？旧令牌立即失效，那台机器要改成新令牌才能重连。',
      removed: '已移除 {id}。', rotated: '已为 {id} 换令牌。',
      actionFailed: '操作失败：{message}',
      edgeNote: '这台 dsh 是边端：它连向主节点，自己不管理其它环境。要在这里管理环境，把 role 改成 main。',
      switcherLabel: '当前环境：',
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
      labelLabel: 'Name', labelPlaceholder: 'e.g. 6.13',
      rename: 'Rename', renamePrompt: 'New name', renamed: 'Renamed',
      sectionEnvironments: 'Environments',
      create: 'Create environment', creating: 'Creating…',
      tokenOnce: 'This token is shown once — copy it now',
      tokenHint: 'Put it in that machine\'s dsh daemon config: role=edge, plus this node\'s address.',
      confirmRemove: 'Remove environment {id}? The dsh on that machine stays; it just stops connecting here.',
      confirmRotate: 'Give {id} a new token? The old one stops working immediately, and that machine must be updated before it can reconnect.',
      removed: 'Removed {id}.', rotated: 'New token issued for {id}.',
      actionFailed: 'Failed: {message}',
      edgeNote: 'This dsh is an edge: it connects to a main node and manages no environments itself. Set role to main to manage them here.',
      switcherLabel: 'Current environment:',
      switcherLocal: 'This host',
      switcherOffline: ' (offline)',
      switcherTitle: 'Switch environment: open the dsh on another machine',
      switcherFailed: 'Could not read the environment list',
    }

    /**
     * Panel styles.
     *
     * These mirror the Plugin Market's design language — 12px cards on a white surface,
     * a 1px rgba(0,0,0,.1) hairline, 8px pill actions, 11px metadata, 4px tag chips — so
     * this page reads as part of the product rather than a form bolted onto it. The
     * values are the market's computed ones, not an approximation of them.
     */
    const INK = '#0f1115'
    const MUTED = '#61666b'
    const FAINT = '#81858c'
    const HAIRLINE = 'rgba(0,0,0,.1)'
    const styles = {
      wrap: { padding: '18px 20px', maxWidth: 1100, margin: '0 auto' },
      hint: { margin: '0 0 14px', color: MUTED, fontSize: 12, lineHeight: '18px' },
      detail: { color: FAINT, fontSize: 11, marginTop: 2 },
      mono: { fontFamily: 'ui-monospace, monospace', fontSize: 11, color: MUTED },
      dim: { color: FAINT, fontSize: 12 },
      ok: { color: '#2f855a', fontSize: 12 },
      error: { color: '#c53030', fontSize: 12 },
      note: {
        marginTop: 12, padding: '12px 14px', borderRadius: 12,
        border: `1px solid ${HAIRLINE}`, background: '#fff', color: MUTED, fontSize: 12,
      },
      /** One environment. A card, not a table row: the market draws its records this way. */
      card: {
        display: 'flex', alignItems: 'flex-start', gap: 12,
        padding: '12px 14px', borderRadius: 12, border: `1px solid ${HAIRLINE}`,
        background: '#fff', marginBottom: 8,
      },
      cardMain: { flex: '1 1 auto', minWidth: 0 },
      cardName: { fontSize: 13, fontWeight: 600, color: INK, marginBottom: 2 },
      cardMeta: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 4 },
      cardActions: {
        display: 'flex', alignItems: 'center', gap: 6, flex: 'none', flexWrap: 'wrap',
        justifyContent: 'flex-end',
      },
      /** A 4px chip, like the market's tag row. */
      tag: {
        padding: '1px 6px', borderRadius: 4, border: '1px solid rgba(0,0,0,.12)',
        fontSize: 11, color: MUTED, whiteSpace: 'nowrap',
      },
      tagOk: {
        padding: '1px 6px', borderRadius: 4, border: '1px solid rgba(47,133,90,.35)',
        fontSize: 11, color: '#2f855a', whiteSpace: 'nowrap',
      },
      /** An 8px pill. The filled one is the single primary action on the page. */
      button: {
        height: 28, padding: '0 10px', fontSize: 12, cursor: 'pointer', borderRadius: 8,
        border: `1px solid ${HAIRLINE}`, background: 'transparent', color: INK,
        display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
      },
      buttonPrimary: {
        height: 28, padding: '0 12px', fontSize: 12, cursor: 'pointer', borderRadius: 8,
        border: 'none', background: INK, color: '#fff',
        display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
      },
      buttonDanger: {
        height: 28, padding: '0 10px', fontSize: 12, cursor: 'pointer', borderRadius: 8,
        border: '1px solid rgba(197,48,48,.3)', background: 'transparent', color: '#c53030',
        display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
      },
      input: {
        height: 28, padding: '0 10px', fontSize: 12, borderRadius: 8,
        border: `1px solid ${HAIRLINE}`, background: '#fff', color: INK,
        boxSizing: 'border-box',
      },
      form: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, flexWrap: 'wrap' },
      formLabel: { fontSize: 12, color: MUTED, whiteSpace: 'nowrap' },
      sectionTitle: { fontSize: 13, fontWeight: 600, color: INK, margin: '18px 0 8px' },
      tokenBox: {
        margin: '10px 0', padding: '12px 14px', borderRadius: 12,
        background: 'rgba(214,158,46,.1)', border: '1px solid rgba(214,158,46,.35)',
      },
      tokenTitle: { fontSize: 12, fontWeight: 600, color: INK, marginBottom: 6 },
      tokenCode: {
        display: 'block', fontFamily: 'ui-monospace, monospace', fontSize: 11,
        wordBreak: 'break-all', userSelect: 'all', color: INK,
      },
      // The seat container (`sidebar.footer.action`) is `display: contents`, so it has no
      // width to inherit: a flex row there sizes to its content and the select would
      // collapse to its text. Stretching to the parent's content box is what gives the
      // select the remaining horizontal space.
      switcher: {
        display: 'flex', alignItems: 'center', gap: 4, padding: '6px 8px', fontSize: 12,
        width: '100%', boxSizing: 'border-box',
      },
      switcherLabel: { flex: 'none', opacity: 0.65, fontSize: 11, whiteSpace: 'nowrap' },
      // `flex: 1` with `minWidth: 0` is what lets it take the remaining width: without the
      // zero minimum a flex item refuses to shrink below its content, so a long
      // environment label would push the row wider instead of truncating.
      switcherSelect: {
        flex: '1 1 auto', minWidth: 0, padding: '3px 6px', fontSize: 12, borderRadius: 5,
        border: '1px solid rgba(128,128,128,.35)', background: 'transparent', color: 'inherit',
        textOverflow: 'ellipsis',
      },
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
            body: JSON.stringify({ label: label.trim() }),
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

        /**
         * Rename one environment.
         *
         * Only the label changes. The id is the node identifier and the URL is built from
         * it, so renaming must never move the address a bookmark points at.
         */
        const rename = useCallback(async (entry) => {
          const next = window.prompt(t("renamePrompt"), entry.label)
          if (next === null) return
          const label = next.trim()
          if (label === "" || label === entry.label) return
          setBusy(entry.id)
          setFlash("")
          try {
            const result = await call(`/admin/environments/${entry.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ label }),
            })
            setFlash(result.ok ? `${t("renamed")}: ${label}` : t("actionFailed").replace("{message}", result.error ?? ""))
            if (result.ok) await load()
          } finally {
            setBusy("")
          }
        }, [load, t])

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
        // One card per environment, matching how the Plugin Market draws its records:
        // name and metadata on the left, actions as pills on the right.
        const cards = state.environments.map((entry) => h('div', { key: entry.id, style: styles.card },
          h('div', { style: styles.cardMain },
            h('div', { style: styles.cardName }, entry.label),
            entry.hostname === undefined ? null : h('div', { style: styles.detail }, entry.hostname),
            h('div', { style: styles.cardMeta },
              h('span', { style: entry.online ? styles.tagOk : styles.tag },
                entry.online ? t('online') : t('offline')),
              h('span', { style: styles.tag }, `/${entry.id}/`),
              h('span', { style: styles.tag }, entry.tokenHint),
              entry.online || entry.lastSeen === undefined
                ? null
                : h('span', { style: styles.detail }, new Date(entry.lastSeen).toLocaleString()))),
          h('div', { style: styles.cardActions },
            entry.online
              ? h('button', { key: 'open', style: styles.button, onClick: () => window.open(`/${entry.id}/`, '_blank') }, t('open'))
              : null,
            // The name is the only thing an operator can change: the id is the node's
            // identity and its URL is built from it.
            h('button', { key: 'rename', style: styles.button, disabled: busy !== '', onClick: () => void rename(entry) }, t('rename')),
            h('button', { key: 'rot', style: styles.button, disabled: busy !== '', onClick: () => void rotate(entry) }, t('rotate')),
            h('button', { key: 'rm', style: styles.buttonDanger, disabled: busy !== '', onClick: () => void remove(entry) }, t('remove')))))

        children.push(h('div', { key: 'list' },
          h('div', { style: styles.sectionTitle }, t('sectionEnvironments')),
          state.environments.length === 0
            ? h('div', { style: styles.note }, t('empty'))
            : h('div', null, cards),
          h('div', { key: 'form', style: styles.form },
            h('label', { key: 'l', style: styles.formLabel }, t('labelLabel')),
            h('input', {
              key: 'i', style: styles.input, value: label,
              placeholder: t('labelPlaceholder'),
              onChange: (event) => setLabel(event.target.value),
            }),
            h('button', { key: 'b', style: styles.buttonPrimary, disabled: busy !== '', onClick: () => void create() },
              busy === 'create' ? t('creating') : t('create')))))
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
