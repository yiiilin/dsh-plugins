window.__ModuleLoader__.load({
  id: '@yiln-dsh/dsh-gateway',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const NS = 'gateway'
    const h = React.createElement

    const ZH = {
      title: '联邦网关',
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
      title: 'Federation gateway',
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
    /**
     * Panel styles.
     *
     * Every value here is taken from the Plugin Market's own stylesheet
     * (`dshmarket/src/client/Market.module.css`), not inferred from the rendered page:
     *
     *   .root   container-type:inline-size, so the panel is a query container
     *   .head   flex column, gap 12, padding 4px 4px 6px
     *   .title  16px / 24px / 500
     *   .sub    12px / 18px / label-tertiary
     *   .body   padding 12px 4px 64px
     *   .card   bg layer-1, 1px border-l2, radius 12, padding 12px 14px,
     *           flex COLUMN with gap 12
     *   .nm     15px / 22px / 600
     *   .desc   12px / 18px / label-tertiary
     *   .meta   11px
     *   .tag    11px / 16px, padding 1px 6px, radius 4
     *
     * Reading the source is why the earlier attempts kept missing: the values visible
     * in the DOM at one viewport width are the *computed* result of container queries,
     * so they were right for that width and wrong for the design.
     */
    const INK = '#1f2328'
    const SECONDARY = '#5c6570'
    const TERTIARY = '#8b93a1'
    const HAIRLINE = '#e5e7eb'
    const styles = {
      /** `.root`: a query container, so the panel measures against itself. */
      root: {
        height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0,
        color: INK, position: 'relative', containerType: 'inline-size',
        // One column for the head and the body. The market's host surface holds this
        // width by growing padding; standing alone, the panel sets it here so the two
        // regions cannot disagree about where their content starts.
        maxWidth: 968, width: '100%', margin: '0 auto', boxSizing: 'border-box',
        // `.panelHost` in the market's stylesheet: the 28px clears the window frame's top
        // controls. The CSS variable lets a host add to it; absent one, it is 28px.
        paddingTop: 'calc(28px + var(--dsh-frame-top-clearance, 0px))',
      },
      /** `.head`: title and sub share one column with a 12px gap. */
      head: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0 6px' },
      /** `.titleRow`: heading and its actions on one baseline. */
      titleRow: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 10px' },
      titleText: { fontSize: 16, lineHeight: '24px', fontWeight: 500, margin: 0, whiteSpace: 'nowrap' },
      /** `.sub`: the description under the title. */
      hint: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, lineHeight: '18px', color: TERTIARY, margin: 0 },
      /**
       * `.body`: the scrolling region.
       *
       * The market's own `.body` has only 4px of side padding because the surface that
       * hosts it keeps the content at 960px by growing padding instead of setting a
       * width — its computed padding is `4px 185.5px 6px` at this viewport. Standing
       * alone here, the panel has to hold that width itself, or the content stretches
       * to the full window and stops matching at any width past ~1300px.
       */
      wrap: { flex: 1, padding: '12px 0 64px', minWidth: 0 },
      /** `.sectionTitle`: an h3-sized heading inside the body. */
      sectionTitle: { fontSize: 13, fontWeight: 600, color: INK, lineHeight: '20px', margin: '0 0 8px', padding: '0 4px' },
      /** `.card`: a COLUMN — content first, then its footer. */
      card: {
        background: '#fff', border: `1px solid ${HAIRLINE}`, borderRadius: 12,
        padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12,
        alignSelf: 'start', minWidth: 0,
      },
      /** `.row1`: name and the action cluster on one line. */
      cardRow: { display: 'flex', alignItems: 'flex-start', gap: 10, minWidth: 0 },
      cardMain: { flex: '1 1 auto', minWidth: 0 },
      /** `.nm`: the name carries the card, so it is the one thing sized up. */
      cardName: {
        fontWeight: 600, fontSize: 15, lineHeight: '22px',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
      /** `.byline`: the row under the name. */
      cardMeta: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, marginTop: 2, flexWrap: 'wrap' },
      cardActions: { flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
      /** `.meta`: 11px, not 12. */
      detail: { fontSize: 11, color: TERTIARY, marginTop: 2 },
      mono: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 11, color: SECONDARY },
      dim: { fontSize: 12, color: TERTIARY },
      ok: { color: '#16a34a', fontSize: 12 },
      error: { color: '#dc2626', fontSize: 12 },
      /** `.tag`: 1px 6px, radius 4, 11px over a 16px line. */
      tag: {
        border: '1px solid #d9dde3', color: SECONDARY, borderRadius: 4,
        flexShrink: 0, padding: '1px 6px', fontSize: 11, lineHeight: '16px', whiteSpace: 'nowrap',
      },
      tagOk: {
        border: '1px solid #d9dde3', color: '#16a34a', borderRadius: 4,
        flexShrink: 0, padding: '1px 6px', fontSize: 11, lineHeight: '16px', whiteSpace: 'nowrap',
      },
      note: {
        padding: '12px 14px', borderRadius: 12, border: `1px solid ${HAIRLINE}`,
        background: '#fff', color: TERTIARY, fontSize: 12,
      },
      /** The market's pill: 28px tall, 8px radius. */
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
        border: '1px solid rgba(220,38,38,.3)', background: 'transparent', color: '#dc2626',
        display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
      },
      input: {
        height: 28, padding: '0 10px', fontSize: 12, borderRadius: 8,
        border: `1px solid ${HAIRLINE}`, background: '#fff', color: INK, boxSizing: 'border-box',
      },
      form: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' },
      formLabel: { fontSize: 12, color: SECONDARY, whiteSpace: 'nowrap' },
      /** `.grid`: exactly two columns, as the market defines it. */
      grid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', alignItems: 'start', gap: 10 },
      tokenBox: {
        padding: '12px 14px', borderRadius: 12,
        background: '#fdf3e3', border: '1px solid #f3e3c3',
      },
      tokenTitle: { fontSize: 12, fontWeight: 600, color: INK, marginBottom: 6 },
      tokenCode: {
        display: 'block', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 11,
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
      const children = [h('div', { key: 'title', style: styles.titleRow },
      h('span', { style: styles.titleText }, t('title')),
      h('button', { style: styles.button, disabled: busy !== '', onClick: () => void load() }, t('refresh'))),
    h('p', { key: 'hint', style: styles.hint }, t('hint'))]
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
          // `.row1`: the name (and what it is) on the left, its actions on the right.
          h('div', { style: styles.cardRow },
            h('div', { style: styles.cardMain },
              h('div', { style: styles.cardName }, entry.label),
              h('div', { style: styles.cardMeta },
                h('span', { style: entry.online ? styles.tagOk : styles.tag },
                  entry.online ? t('online') : t('offline')),
                // Status and path only: the token prefix that used to sit here is
                // still part of a credential, and nothing on this card needs it.
                  h('span', { style: styles.tag }, `/${entry.id}/`))),
            h('div', { style: styles.cardActions },
            entry.online
              ? h('button', { key: 'open', style: styles.button, onClick: () => window.open(`/${entry.id}/`, '_blank') }, t('open'))
              : null,
            // The name is the only thing an operator can change: the id is the node's
            // identity and its URL is built from it.
            h('button', { key: 'rename', style: styles.button, disabled: busy !== '', onClick: () => void rename(entry) }, t('rename')),
            h('button', { key: 'rot', style: styles.button, disabled: busy !== '', onClick: () => void rotate(entry) }, t('rotate')),
            h('button', { key: 'rm', style: styles.buttonDanger, disabled: busy !== '', onClick: () => void remove(entry) }, t('remove')))),
          // `.meta`: the quiet second line, when there is one.
          entry.hostname === undefined && entry.online
            ? null
            : h('div', { style: styles.detail },
              [entry.hostname, entry.online || entry.lastSeen === undefined
                ? null
                : new Date(entry.lastSeen).toLocaleString()].filter(Boolean).join(' · '))))

        children.push(h('div', { key: 'list' },
          h('div', { style: styles.sectionTitle }, t('sectionEnvironments')),
          state.environments.length === 0
            ? h('div', { style: styles.note }, t('empty'))
            : h('div', { style: styles.grid }, cards),
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


      // Mirrors the market's markup: a query container holding a head and a body.
      const head = [children[0], children[1]]
      const body = children.slice(2)
      return h('div', { style: styles.root },
        h('div', { style: styles.head }, head),
        h('div', { style: styles.wrap }, body))
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
        id: 'gateway',
        order: 40,
        label: () => t('title'),
      }, PanelIcon)), 'gateway: panel entry')
      // … and the page it opens, keyed by the same id.
      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'gateway',
        inject: () => ({}),
      }, makePanelPage(t))), 'gateway: panel page')
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
