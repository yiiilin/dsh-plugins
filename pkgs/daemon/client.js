window.__ModuleLoader__.load({
  id: '@yiln-dsh/dsh-daemon',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const NS = 'daemon'
    const h = React.createElement

    const ZH = {
      title: '开发守护',
      hint: '一个入口，多个 profile。每个 profile 是一个独立的 dsh 进程，各自拥有自己的文件系统与进程。',
      refresh: '刷新',
      loading: '正在读取…',
      unreachable: '无法读取守护状态（管理接口只接受已登录的请求）。',
      empty: '还没有配置任何 profile。',
      colName: '名称', colKind: '类型', colPort: '端口', colWorkspace: '工作区', colState: '状态', colActions: '操作',
      kindLocal: '本地', kindSsh: 'SSH',
      running: '运行中', stopped: '已停止',
      start: '启动', stop: '停止', remove: '移除', open: '打开',
      createTitle: '添加 profile',
      idLabel: '标识（留空自动生成）', workspaceLabel: '工作区绝对路径',
      sshHostLabel: 'SSH 主机（别名或 host:port）', sshUserLabel: 'SSH 用户',
      sshHelperLabel: '远端 helper 路径', sshHelperHashLabel: 'helper 的 SHA-256',
      create: '创建', creating: '创建中…',
      confirmRemove: '确定要移除 {id} 吗？它的进程会被停止。',
      errWorkspace: '工作区必须是绝对路径。',
      errSsh: 'SSH 类型必须填写主机、用户和 helper 的 hash。',
      actionFailed: '操作失败：{message}',
      adminPage: '打开管理页',
      deployNote: 'SSH profile 需要先部署 helper：在管理页填写连接信息并确认后才会写入远端。',
    }
    const EN = {
      title: 'Development daemon',
      hint: 'One entry, many profiles. Each profile is its own dsh process with its own filesystem and processes.',
      refresh: 'Refresh',
      loading: 'Loading…',
      unreachable: 'Cannot read daemon state (the admin endpoints require an authenticated request).',
      empty: 'No profiles configured yet.',
      colName: 'Name', colKind: 'Kind', colPort: 'Port', colWorkspace: 'Workspace', colState: 'State', colActions: 'Actions',
      kindLocal: 'local', kindSsh: 'SSH',
      running: 'running', stopped: 'stopped',
      start: 'Start', stop: 'Stop', remove: 'Remove', open: 'Open',
      createTitle: 'Add a profile',
      idLabel: 'Id (blank derives one)', workspaceLabel: 'Workspace absolute path',
      sshHostLabel: 'SSH host (alias or host:port)', sshUserLabel: 'SSH user',
      sshHelperLabel: 'Remote helper path', sshHelperHashLabel: "Helper's SHA-256",
      create: 'Create', creating: 'Creating…',
      confirmRemove: 'Remove {id}? Its process will be stopped.',
      errWorkspace: 'Workspace must be an absolute path.',
      errSsh: 'An SSH profile needs a host, a user and the helper hash.',
      actionFailed: 'Action failed: {message}',
      adminPage: 'Open the admin page',
      deployNote: 'An SSH profile needs its helper deployed first: the admin page writes nothing to the host until you confirm.',
    }

    const styles = {
      wrap: { display: 'grid', gap: 12 },
      hint: { margin: '0 0 4px', opacity: 0.7, fontSize: 13 },
      error: { color: '#c0392b', fontSize: 13 },
      ok: { color: '#2a7a3f', fontSize: 13 },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
      cell: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid rgba(128,128,128,.25)' },
      mono: { fontFamily: 'ui-monospace, monospace', fontSize: 12, opacity: 0.8, wordBreak: 'break-all' },
      button: { font: 'inherit', fontSize: 12, padding: '2px 8px', marginRight: 4, borderRadius: 6, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
      input: { font: 'inherit', fontSize: 13, padding: '4px 6px', borderRadius: 6, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit' },
      form: { display: 'grid', gap: 6, maxWidth: 420 },
      label: { fontSize: 12, opacity: 0.7 },
    }

    const call = async (path, options) => {
      const response = await fetch(path, { credentials: 'same-origin', ...options })
      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        return { ok: false, error: text.slice(0, 200) }
      }
    }

    const makeCard = (t) => function DaemonCard() {
      const [state, setState] = useState({ phase: 'loading', profiles: [] })
      const [flash, setFlash] = useState('')

      const load = useCallback(async () => {
        try {
          const result = await call('/admin/state')
          if (result.ok) setState({ phase: 'ready', profiles: result.profiles })
          else setState({ phase: 'failed', profiles: [], error: result.error })
        } catch (error) {
          setState({ phase: 'failed', profiles: [], error: String(error) })
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const act = useCallback(async (path, options, message) => {
        const result = await call(path, options)
        if (result.ok) { setFlash(message); void load() } else setFlash(t('actionFailed').replace('{message}', result.error ?? ''))
      }, [load, t])

      const row = (profile) => h('tr', { key: profile.id },
        h('td', { style: styles.cell },
          h('div', null, profile.label),
          h('div', { style: styles.mono }, `/${profile.id}/`)),
        h('td', { style: styles.cell }, profile.kind === 'ssh' ? t('kindSsh') : t('kindLocal')),
        h('td', { style: styles.cell }, String(profile.port)),
        h('td', { style: { ...styles.cell, ...styles.mono } }, profile.workspace),
        h('td', { style: styles.cell }, profile.running ? t('running') : t('stopped')),
        h('td', { style: styles.cell },
          profile.running
            ? h('button', { key: 'open', style: styles.button, onClick: () => window.open(profile.url ?? `/${profile.id}/`, '_blank') }, t('open'))
            : null,
          h('button', { key: 'start', style: styles.button, disabled: profile.running, onClick: () => act(`/admin/profiles/${profile.id}/start`, { method: 'POST' }, '') }, t('start')),
          h('button', { key: 'stop', style: styles.button, disabled: !profile.running, onClick: () => act(`/admin/profiles/${profile.id}/stop`, { method: 'POST' }, '') }, t('stop')),
          h('button', { key: 'remove', style: styles.button, onClick: () => { if (confirm(t('confirmRemove').replace('{id}', profile.id))) void act(`/admin/profiles/${profile.id}`, { method: 'DELETE' }, '') } }, t('remove'))))

      const table = h('table', { style: styles.table },
        h('thead', null, h('tr', null,
          ['colName', 'colKind', 'colPort', 'colWorkspace', 'colState', 'colActions'].map((key) => h('th', { key, style: styles.cell }, t(key))))),
        h('tbody', null, state.profiles.map(row)))

      const children = [h('p', { key: 'hint', style: styles.hint }, t('hint'))]
      if (flash !== '') children.push(h('div', { key: 'flash', style: styles.ok }, flash))
      if (state.phase === 'failed') children.push(h('div', { key: 'error', style: styles.error }, t('unreachable')))
      if (state.phase === 'ready' && state.profiles.length === 0) children.push(h('p', { key: 'empty', style: styles.hint }, t('empty')))
      if (state.phase === 'ready' && state.profiles.length > 0) children.push(h('div', { key: 'table' }, table))
      children.push(h('div', { key: 'actions' },
        h('button', { style: styles.button, onClick: () => void load() }, t('refresh')),
        h('a', { style: { ...styles.button, textDecoration: 'none' }, href: '/admin', target: '_blank', rel: 'noreferrer' }, t('adminPage'))))
      children.push(h('p', { key: 'deploy', style: styles.hint }, t('deployNote')))

      return h('div', { style: styles.wrap }, children)
    }

    const apply = (ctx) => {
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'daemon: locale')
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'daemon',
        order: 118,
        label: () => t('title'),
        inject: () => ({}),
      }, makeCard(t))), 'daemon: settings page')
    }

    return { name: 'daemon-client', inject: ['locale', 'slots'], apply, __test: { call, ZH, EN } }
  },
})
