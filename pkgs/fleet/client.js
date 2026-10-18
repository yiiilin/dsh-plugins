window.__ModuleLoader__.load({
  id: '@yiln-dsh/dsh-fleet',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const NS = 'fleet'
    const h = React.createElement

    const ZH = {
      title: '服务器集群',
      hint: '一个页面管理多台开发机。每台是一个独立的 dsh 进程，各自持有自己的文件系统与进程。',
      refresh: '刷新',
      loading: '正在读取…',
      unreachable: '无法读取集群状态（管理接口只接受来自本机的请求）。',
      empty: '还没有配置任何服务器。',
      colName: '名称', colKind: '类型', colPort: '端口', colWorkspace: '工作区', colState: '状态', colActions: '操作',
      kindLocal: '本机', kindSsh: 'SSH',
      running: '运行中', stopped: '已停止',
      start: '启动', stop: '停止', remove: '移除',
      open: '打开',
      createTitle: '添加服务器',
      idLabel: '标识（用作 URL 前缀）', labelLabel: '显示名称', kindLabel: '类型',
      portLabel: '端口（留空自动分配）', workspaceLabel: '工作区绝对路径',
      sshHostLabel: 'SSH 别名', sshNodeLabel: '远端 node 路径',
      sshHelperLabel: '远端 helper 路径', sshHelperHashLabel: 'helper 的 SHA-256',
      create: '创建', creating: '创建中…',
      confirmRemove: '确定要从集群中移除 {id} 吗？该服务器的进程会被停止。',
      errId: '标识只能用小写字母、数字和连字符，且以字母开头。',
      errWorkspace: '工作区必须是绝对路径。',
      errSsh: 'SSH 类型必须填写别名、node、helper 路径和 hash。',
      created: '已创建 {id}。',
      started: '已启动 {id}。',
      stoppedMsg: '已停止 {id}。',
      removed: '已移除 {id}。',
      actionFailed: '操作失败：{message}',
      profileNote: '生成的 profile 会在启动时自动写入。',
    }
    const EN = {
      title: 'Server fleet',
      hint: 'Manage several development machines from one page. Each is its own dsh process with its own filesystem and processes.',
      refresh: 'Refresh',
      loading: 'Loading…',
      unreachable: 'Cannot read fleet state (the management API accepts local requests only).',
      empty: 'No servers configured yet.',
      colName: 'Name', colKind: 'Kind', colPort: 'Port', colWorkspace: 'Workspace', colState: 'State', colActions: 'Actions',
      kindLocal: 'local', kindSsh: 'ssh',
      running: 'running', stopped: 'stopped',
      start: 'Start', stop: 'Stop', remove: 'Remove',
      open: 'Open',
      createTitle: 'Add a server',
      idLabel: 'Id (used as the URL prefix)', labelLabel: 'Display name', kindLabel: 'Kind',
      portLabel: 'Port (blank allocates one)', workspaceLabel: 'Absolute workspace path',
      sshHostLabel: 'SSH alias', sshNodeLabel: 'Remote node path',
      sshHelperLabel: 'Remote helper path', sshHelperHashLabel: 'Helper SHA-256',
      create: 'Create', creating: 'Creating…',
      confirmRemove: 'Remove {id} from the fleet? Its process will be stopped.',
      errId: 'The id may contain lowercase letters, digits and hyphens, and must start with a letter.',
      errWorkspace: 'The workspace must be an absolute path.',
      errSsh: 'An ssh server needs the alias, node, helper path and hash.',
      created: 'Created {id}.',
      started: 'Started {id}.',
      stoppedMsg: 'Stopped {id}.',
      removed: 'Removed {id}.',
      actionFailed: 'Action failed: {message}',
      profileNote: 'The generated profile is written on start.',
    }

    const ID_RE = /^[a-z][a-z0-9-]{0,30}$/
    const PATH_RE = /^\//

    const blank = { id: '', label: '', kind: 'local', port: '', workspace: '', sshHost: '', sshNode: '', sshHelper: '', sshHelperHash: '' }

    /** One management call; a non-JSON body is reported as unreachable, never parsed. */
    const call = async (path, body) => {
      const res = await fetch(`/_dsh/fleet/${path}`, body === undefined
        ? { method: 'GET', headers: { accept: 'application/json' } }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const text = await res.text()
      let value
      try { value = text === '' ? {} : JSON.parse(text) } catch { throw new Error(`HTTP ${res.status}`) }
      if (!res.ok) throw new Error(value?.error ?? `HTTP ${res.status}`)
      return value
    }

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14 },
      hint: { opacity: 0.65, fontSize: 12, lineHeight: 1.6, margin: 0 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
      th: { textAlign: 'left', fontWeight: 600, padding: '6px 8px', borderBottom: '1px solid var(--dsh-border, rgba(128,128,128,.28))', opacity: 0.7 },
      td: { padding: '7px 8px', borderBottom: '1px solid var(--dsh-border, rgba(128,128,128,.16))', verticalAlign: 'middle' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, opacity: 0.75 },
      button: { padding: '3px 10px', borderRadius: 6, border: '1px solid var(--dsh-border, rgba(128,128,128,.4))', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 },
      primary: { padding: '5px 14px', borderRadius: 6, border: '1px solid rgba(64,132,255,.5)', background: 'rgba(64,132,255,.14)', color: 'inherit', cursor: 'pointer', fontSize: 13 },
      input: { padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsh-border, rgba(128,128,128,.4))', background: 'transparent', color: 'inherit', fontSize: 12, minWidth: 120 },
      field: { display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 },
      label: { opacity: 0.7 },
      form: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, padding: '12px 0' },
      error: { color: 'var(--dsh-danger, #d33)', fontSize: 12 },
      ok: { color: 'var(--dsh-success, #0a0)', fontSize: 12 },
      pill: { fontSize: 11, padding: '1px 7px', borderRadius: 999, border: '1px solid var(--dsh-border, rgba(128,128,128,.4))' },
      formTitle: { fontWeight: 600, fontSize: 13, marginTop: 6 },
      note: { fontSize: 11, opacity: 0.55 },
    }

    const CreateForm = ({ t, onCreated }) => {
      const [draft, setDraft] = useState(blank)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const set = (key) => (event) => setDraft({ ...draft, [key]: event.target.value })
      const field = (key, label) => h('label', { style: styles.field },
        h('span', { style: styles.label }, label),
        h('input', { style: styles.input, value: draft[key], onChange: set(key) }))

      const submit = async () => {
        setError('')
        if (!ID_RE.test(draft.id)) return setError(t('errId'))
        if (!PATH_RE.test(draft.workspace)) return setError(t('errWorkspace'))
        if (draft.kind === 'ssh' && (!draft.sshHost || !PATH_RE.test(draft.sshNode) || !PATH_RE.test(draft.sshHelper) || !/^[0-9a-f]{64}$/.test(draft.sshHelperHash))) {
          return setError(t('errSsh'))
        }
        const body = {
          id: draft.id,
          label: draft.label || draft.id,
          kind: draft.kind,
          workspace: draft.workspace,
          ...(draft.port === '' ? {} : { port: Number(draft.port) }),
          ...(draft.kind === 'ssh' ? {
            sshHost: draft.sshHost, sshNode: draft.sshNode,
            sshHelper: draft.sshHelper, sshHelperHash: draft.sshHelperHash,
          } : {}),
        }
        setBusy(true)
        try {
          await call('create', body)
          setDraft(blank)
          onCreated(t('created', { id: body.id }))
        } catch (cause) {
          setError(t('actionFailed', { message: cause.message }))
        } finally {
          setBusy(false)
        }
      }

      return h('div', null,
        h('div', { style: styles.formTitle }, t('createTitle')),
        h('div', { style: styles.form },
          field('id', t('idLabel')),
          field('label', t('labelLabel')),
          h('label', { style: styles.field },
            h('span', { style: styles.label }, t('kindLabel')),
            h('select', { style: styles.input, value: draft.kind, onChange: set('kind') },
              h('option', { value: 'local' }, t('kindLocal')),
              h('option', { value: 'ssh' }, t('kindSsh')))),
          field('port', t('portLabel')),
          field('workspace', t('workspaceLabel')),
          draft.kind === 'ssh' ? field('sshHost', t('sshHostLabel')) : null,
          draft.kind === 'ssh' ? field('sshNode', t('sshNodeLabel')) : null,
          draft.kind === 'ssh' ? field('sshHelper', t('sshHelperLabel')) : null,
          draft.kind === 'ssh' ? field('sshHelperHash', t('sshHelperHashLabel')) : null,
        ),
        error === '' ? null : h('div', { style: styles.error }, error),
        h('div', { style: { ...styles.row, marginTop: 8 } },
          h('button', { style: styles.primary, disabled: busy, onClick: submit }, busy ? t('creating') : t('create')),
          h('span', { style: styles.note }, t('profileNote'))))
    }

    // `t` is bound once in apply() and captured here, matching session-mode's
    // pattern: the client factory never resolves the locale service itself.
    const makeFleetCard = (t) => function FleetCard() {
      const [state, setState] = useState({ phase: 'loading', boxes: [], error: '' })
      const [flash, setFlash] = useState('')

      const load = useCallback(async () => {
        try {
          const value = await call('state')
          setState({ phase: 'ready', boxes: value.boxes ?? [], error: '' })
        } catch (cause) {
          setState({ phase: 'failed', boxes: [], error: cause.message })
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const act = async (path, id, key) => {
        setFlash('')
        try {
          await call(path, { id })
          setFlash(t(key, { id }))
          await load()
        } catch (cause) {
          setFlash(t('actionFailed', { message: cause.message }))
        }
      }

      const row = (box) => h('tr', { key: box.id },
        h('td', { style: styles.td },
          h('div', null, box.label ?? box.id),
          h('div', { style: styles.mono }, `/${box.id}/`)),
        h('td', { style: styles.td },
          h('span', { style: styles.pill }, box.kind === 'ssh' ? t('kindSsh') : t('kindLocal'))),
        h('td', { style: { ...styles.td, ...styles.mono } }, String(box.port)),
        h('td', { style: { ...styles.td, ...styles.mono } }, box.workspace),
        h('td', { style: styles.td }, box.running ? t('running') : t('stopped')),
        h('td', { style: styles.td },
          h('div', { style: styles.row },
            box.running
              ? h('a', { style: styles.button, href: `/${box.id}/`, target: '_blank', rel: 'noreferrer' }, t('open'))
              : h('button', { style: styles.button, onClick: () => void act('start', box.id, 'started') }, t('start')),
            box.running
              ? h('button', { style: styles.button, onClick: () => void act('stop', box.id, 'stoppedMsg') }, t('stop'))
              : null,
            h('button', {
              style: styles.button,
              onClick: () => {
                if (!window.confirm(t('confirmRemove', { id: box.id }))) return
                void act('remove', box.id, 'removed')
              },
            }, t('remove')))))

      const columns = ['colName', 'colKind', 'colPort', 'colWorkspace', 'colState', 'colActions']

      const table = h('table', { style: styles.table },
        h('thead', null, h('tr', null, columns.map((key) => h('th', { key, style: styles.th }, t(key))))),
        h('tbody', null, state.boxes.map(row)))

      let content = null
      if (state.phase === 'loading') content = h('p', { style: styles.hint }, t('loading'))
      else {
        const children = [
          h('div', { key: 'actions', style: styles.row },
            h('button', { style: styles.button, onClick: () => void load() }, t('refresh'))),
        ]
        if (flash !== '') children.push(h('div', { key: 'flash', style: styles.ok }, flash))
        if (state.phase === 'failed') children.push(h('div', { key: 'error', style: styles.error }, t('unreachable')))
        if (state.phase === 'ready' && state.boxes.length === 0) children.push(h('p', { key: 'empty', style: styles.hint }, t('empty')))
        if (state.phase === 'ready' && state.boxes.length > 0) children.push(h('div', { key: 'table' }, table))
        children.push(h(CreateForm, { key: 'form', t, onCreated: (message) => { setFlash(message); void load() } }))
        content = h('div', { style: styles.wrap }, children)
      }

      return h('div', { style: styles.wrap },
        h('div', null,
          h('h3', { style: { margin: '0 0 4px', fontSize: 15 } }, t('title')),
          h('p', { style: styles.hint }, t('hint'))),
        content)
    }

    const apply = (ctx) => {
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'fleet: locale')
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'fleet',
        order: 120,
        label: () => t('title'),
        inject: () => ({}),
      }, makeFleetCard(t))), 'fleet: settings page')
    }

    return { name: 'fleet-client', inject: ['locale', 'slots'], apply, __test: { call, blank, ZH, EN } }
  },
})
