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
      deployNote: 'SSH profile 需要先部署 helper：填好连接信息并确认后才会写入远端，远端不需要 Node。',
      kindLabel: '类型',
      modeLabel: '模式',
      modeCreate: '新建',
      modeAdopt: '接管已有',
      adoptSubmit: '接管',
      adoptLabel: '已有 profile 名（目录名）',
      adoptHint: '接管只登记坐标，不改动该 profile 的任何文件。',
      sshHostLabel: 'SSH 主机（别名或 host:port）会用于建连',
      sshPortLabel: 'SSH 端口（留空跟随 ssh_config）',
      sshHelperHashLabel: 'helper 的 SHA-256（部署后自动填入）',
      deploy: '部署 helper',
      deploying: '部署中…',
      create: '创建',
      creating: '创建中…',
      errAdopt: '请填写已有 profile 的目录名。',
      errHelperHash: '新建 SSH profile 需要 helper 的 SHA-256；若远端还没有 helper，先填一个占位值再用「部署 helper」覆盖。',
      created: '已创建 {id}。',
      adopted: '已接管 {id}。',
      deployed: 'helper 已部署到 {host}。',
      startedMsg: '已启动 {id}。',
      stoppedMsg: '已停止 {id}。',
      removedMsg: '已移除 {id}。',
      refresh: '刷新',
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
      deployNote: 'An SSH profile needs its helper deployed first: nothing is written to the host until you confirm, and the host needs no Node.',
      kindLabel: 'Kind',
      modeLabel: 'Mode',
      modeCreate: 'New',
      modeAdopt: 'Adopt',
      adoptSubmit: 'Adopt',
      adoptLabel: 'Existing profile directory name',
      adoptHint: 'Adoption records coordinates only; no file in that profile is touched.',
      sshHostLabel: 'SSH host (alias or host:port) used to connect',
      sshPortLabel: 'SSH port (blank follows ssh_config)',
      sshHelperHashLabel: 'Helper SHA-256 (filled after deploy)',
      deploy: 'Deploy helper',
      deploying: 'Deploying…',
      create: 'Create',
      creating: 'Creating…',
      errAdopt: 'Enter the directory name of the existing profile.',
      errHelperHash: 'A new SSH profile needs the helper SHA-256; use a placeholder and let "Deploy helper" fill it.',
      created: 'Created {id}.',
      adopted: 'Adopted {id}.',
      deployed: 'Helper deployed to {host}.',
      startedMsg: 'Started {id}.',
      stoppedMsg: 'Stopped {id}.',
      removedMsg: 'Removed {id}.',
      refresh: 'Refresh',
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
      form: { display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: 8, maxWidth: 560, alignItems: 'center' },
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
      const [busy, setBusy] = useState('')
      const [mode, setMode] = useState('create')
      const [form, setForm] = useState({
        kind: 'local', id: '', workspace: '', adopt: '',
        sshHost: '', sshPort: '', sshUser: '',
        sshHelper: '/opt/dsh-helper/dsh-ssh-helper', sshHelperHash: '',
      })

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

      const field = (key) => ({
        value: form[key],
        onChange: (event) => setForm((prev) => ({ ...prev, [key]: event.target.value })),
        style: styles.input,
      })

      const run = useCallback(async (label, path, options, message) => {
        setBusy(label)
        setFlash('')
        try {
          const result = await call(path, options)
          if (result.ok) {
            if (message !== '') setFlash(message)
            await load()
          } else {
            setFlash(t('actionFailed').replace('{message}', result.error ?? ''))
          }
          return result
        } finally {
          setBusy('')
        }
      }, [load, t])

      const submit = useCallback(async (event) => {
        event.preventDefault()
        if (mode === 'adopt') {
          if (form.adopt.trim() === '') { setFlash(t('errAdopt')); return }
          const result = await run('adopt', '/admin/profiles', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ adopt: form.adopt.trim(), id: form.id || undefined, workspace: form.workspace || undefined }),
          }, '')
          if (result.ok) {
            setFlash(t('adopted').replace('{id}', result.profile.id))
            setForm((prev) => ({ ...prev, adopt: '', id: '', workspace: '' }))
          }
          return
        }
        if (form.workspace.trim() === '' || !form.workspace.trim().startsWith('/')) { setFlash(t('errWorkspace')); return }
        if (form.kind === 'ssh' && (form.sshHost.trim() === '' || form.sshUser.trim() === '')) { setFlash(t('errSsh')); return }
        if (form.kind === 'ssh' && form.sshHelperHash.trim() === '') { setFlash(t('errHelperHash')); return }
        const body = {
          kind: form.kind,
          workspace: form.workspace.trim(),
          id: form.id || undefined,
          ...(form.kind === 'ssh' ? {
            sshHost: form.sshHost.trim(),
            sshUser: form.sshUser.trim(),
            sshHelper: form.sshHelper.trim(),
            sshHelperHash: form.sshHelperHash.trim(),
            ...(form.sshPort.trim() === '' ? {} : { sshPort: Number(form.sshPort) }),
          } : {}),
        }
        const result = await run('create', '/admin/profiles', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }, '')
        if (result.ok) {
          setFlash(t('created').replace('{id}', result.profile.id))
          setForm((prev) => ({ ...prev, id: '', workspace: '', sshHelperHash: '' }))
        }
      }, [form, mode, run, t])

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
          h('button', { key: 'start', style: styles.button, disabled: profile.running || busy !== '', onClick: () => void run('start', `/admin/profiles/${profile.id}/start`, { method: 'POST' }, t('startedMsg').replace('{id}', profile.id)) }, t('start')),
          h('button', { key: 'stop', style: styles.button, disabled: !profile.running || busy !== '', onClick: () => void run('stop', `/admin/profiles/${profile.id}/stop`, { method: 'POST' }, t('stoppedMsg').replace('{id}', profile.id)) }, t('stop')),
          profile.kind === 'ssh'
            ? h('button', { key: 'deploy', style: styles.button, disabled: busy !== '', onClick: () => void run('deploy', `/admin/profiles/${profile.id}/deploy`, { method: 'POST' }, t('deployed').replace('{host}', profile.sshHost)) }, busy === 'deploy' ? t('deploying') : t('deploy'))
            : null,
          h('button', { key: 'remove', style: styles.button, disabled: busy !== '', onClick: () => { if (confirm(t('confirmRemove').replace('{id}', profile.id))) void run('remove', `/admin/profiles/${profile.id}`, { method: 'DELETE' }, t('removedMsg').replace('{id}', profile.id)) } }, t('remove'))))

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
        h('button', { style: styles.button, disabled: busy !== '', onClick: () => void load() }, t('refresh'))))

      // The management surface lives here; the retired `/admin` page stays only as
      // an unlinked fallback for a broken client bundle.
      const kindRow = h('span', { key: 'kind', style: { display: 'flex', gap: 6 } },
        h('select', { ...field('kind'), disabled: mode === 'adopt' },
          h('option', { value: 'local' }, t('kindLocal')),
          h('option', { value: 'ssh' }, t('kindSsh'))))
      const formRows = []
      formRows.push(h('label', { key: 'mode' }, t('modeLabel')))
      formRows.push(h('span', { key: 'modeSel' },
        h('button', { style: styles.button, onClick: () => setMode('create'), disabled: mode === 'create' }, t('modeCreate')),
        h('button', { style: styles.button, onClick: () => setMode('adopt'), disabled: mode === 'adopt' }, t('modeAdopt'))))
      if (mode === 'adopt') {
        formRows.push(h('label', { key: 'adopt' }, t('adoptLabel')))
        formRows.push(h('input', { key: 'adoptIn', ...field('adopt'), placeholder: 'web' }))
        formRows.push(h('label', { key: 'adoptId' }, t('idLabel')))
        formRows.push(h('input', { key: 'adoptIdIn', ...field('id'), placeholder: 'main' }))
        formRows.push(h('label', { key: 'adoptWs' }, t('workspaceLabel')))
        formRows.push(h('input', { key: 'adoptWsIn', ...field('workspace'), placeholder: '/usr/local/src/project/dsh-plugin' }))
        formRows.push(h('span', { key: 'adoptNote' }))
        formRows.push(h('p', { key: 'adoptNoteText', style: styles.hint }, t('adoptHint')))
      } else {
        formRows.push(h('label', { key: 'kindL' }, t('kindLabel')))
        formRows.push(kindRow)
        formRows.push(h('label', { key: 'idL' }, t('idLabel')))
        formRows.push(h('input', { key: 'idIn', ...field('id'), placeholder: '' }))
        formRows.push(h('label', { key: 'wsL' }, t('workspaceLabel')))
        formRows.push(h('input', { key: 'wsIn', ...field('workspace'), placeholder: '/root/scratch' }))
        if (form.kind === 'ssh') {
          formRows.push(h('label', { key: 'hostL' }, t('sshHostLabel')))
          formRows.push(h('input', { key: 'hostIn', ...field('sshHost'), placeholder: 'dsh-box1' }))
          formRows.push(h('label', { key: 'portL' }, t('sshPortLabel')))
          formRows.push(h('input', { key: 'portIn', ...field('sshPort'), placeholder: '' }))
          formRows.push(h('label', { key: 'userL' }, t('sshUserLabel')))
          formRows.push(h('input', { key: 'userIn', ...field('sshUser'), placeholder: 'root' }))
          formRows.push(h('label', { key: 'helperL' }, t('sshHelperLabel')))
          formRows.push(h('input', { key: 'helperIn', ...field('sshHelper') }))
          formRows.push(h('label', { key: 'hashL' }, t('sshHelperHashLabel')))
          formRows.push(h('input', { key: 'hashIn', ...field('sshHelperHash'), placeholder: '64 hex' }))
        }
      }
      formRows.push(h('span', { key: 'submitGap' }))
      formRows.push(h('button', { key: 'submit', disabled: busy !== '', onClick: submit }, busy !== '' ? t('creating') : (mode === 'adopt' ? t('adoptSubmit') : t('create'))))

      children.push(h('div', { key: 'createTitle', style: { marginTop: 18 } },
        h('h3', { style: { margin: '0 0 8px', fontSize: 14 } }, t('createTitle'))))
      children.push(h('div', { key: 'form', style: styles.form }, formRows))
      children.push(h('p', { key: 'deploy', style: styles.hint }, t('deployNote')))

      return h('div', { style: styles.wrap }, children)
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

    /** Panel page: the same card the settings tab used to render, with room. */
    const makePanelPage = (t) => function DaemonPanelPage() {
      const Card = makeCard(t)
      return h('div', { style: { padding: '18px 20px', maxWidth: 1100, margin: '0 auto' } },
        h('h2', { style: { margin: '0 0 12px', fontSize: 17 } }, t('title')),
        h(Card))
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
    }

    return { name: 'daemon-client', inject: ['locale', 'slots'], apply, __test: { call, ZH, EN } }
  },
})
