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
      stNotRunning: '未运行',
      stUnreachable: '远端不可达',
      stHelperBad: 'helper 异常',
      stOk: '正常',
      stUnknown: '检查中…',
      fixDeploy: '部署 helper',
      fixRetest: '重试',
      fixStart: '启动',
      logTitle: '最近日志',
      logEmpty: '（无输出）',
      logClose: '收起',
      enableLabel: '开机自启',
      enabledOn: '自启',
      enabledOff: '不自启',
      askRemoveHelper: '同时删除远端机器上的 helper？\n\n{path}\n\n默认会删除；取消则只移除本地环境，并生成卸载脚本供你以后手动执行。',
      uninstallAt: '卸载脚本：{path}',
      deployingNow: '正在部署 helper…',
      preparing: '正在探测远端…',
      fingerprintLabel: '主机指纹（请与你已知的指纹核对）',
      confirmInstall: '确认并安装',
      hostFacts: '远端信息',
      authPasswordLabel: '密码（仅本次探测用，不保存）',
      authKeyLabel: '私钥路径（可选，仅本次用）',
      probeAction: '探测远端',
      factTitle: '探测结果',
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
      stNotRunning: 'not running',
      stUnreachable: 'remote unreachable',
      stHelperBad: 'helper unhealthy',
      stOk: 'healthy',
      stUnknown: 'checking…',
      fixDeploy: 'Deploy helper',
      fixRetest: 'Retry',
      fixStart: 'Start',
      logTitle: 'Recent output',
      logEmpty: '(no output)',
      logClose: 'Hide',
      enableLabel: 'Start on boot',
      enabledOn: 'autostart',
      enabledOff: 'manual',
      askRemoveHelper: 'Also delete the helper on the remote host?\n\n{path}\n\nOK deletes it; Cancel removes only the local environment and writes an uninstall script for later.',
      uninstallAt: 'Uninstall script: {path}',
      deployingNow: 'Deploying helper…',
      preparing: 'Probing the remote…',
      fingerprintLabel: 'Host fingerprint (compare with what you know)',
      confirmInstall: 'Confirm and install',
      hostFacts: 'Remote facts',
      authPasswordLabel: 'Password (this probe only, never stored)',
      authKeyLabel: 'Private key path (optional, this probe only)',
      probeAction: 'Probe the host',
      factTitle: 'Probe result',
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
      detail: { fontSize: 11, opacity: 0.6, marginTop: 2 },
      dimText: { fontSize: 13, opacity: 0.7 },
      warn: { fontSize: 13, color: '#b7791f' },
      logBox: { padding: '8px 12px', background: 'rgba(128,128,128,.08)' },
      facts: { padding: '8px 10px', borderRadius: 6, background: 'rgba(128,128,128,.08)', display: 'grid', gap: 3 },
      factTitle: { fontSize: 12, fontWeight: 600, opacity: 0.8 },
      logPre: { margin: '4px 0 0', fontSize: 11, lineHeight: 1.45, maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace' },
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
      const [state, setState] = useState({ phase: 'loading', environments: [] })
      const [flash, setFlash] = useState('')
      const [busy, setBusy] = useState('')
      const [form, setForm] = useState({
        sshHost: '', sshPort: '', sshUser: '', password: '', bootstrapKey: '',
        workspace: '', sshHelper: '/opt/dsh-helper/dsh-ssh-helper',
      })
      const [prepared, setPrepared] = useState(undefined)

      const [openLog, setOpenLog] = useState('')
      const [logText, setLogText] = useState('')

      const load = useCallback(async (fresh = false) => {
        try {
          // `fresh` skips the daemon's health cache, which a retry button must do or it
          // would report the same stale verdict.
          const result = await call(fresh ? '/admin/state?fresh=1' : '/admin/state')
          if (result.ok) setState({ phase: 'ready', environments: result.environments })
          else setState({ phase: 'failed', environments: [], error: result.error })
        } catch (error) {
          setState({ phase: 'failed', environments: [], error: String(error) })
        }
      }, [])

      const toggleLog = useCallback(async (id) => {
        if (openLog === id) { setOpenLog(''); setLogText(''); return }
        setOpenLog(id)
        setLogText('')
        const result = await call(`/admin/profiles/${id}/log`)
        setLogText(result.ok ? (result.log ?? '') : String(result.error ?? ''))
      }, [openLog])

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

      const toggleEnabled = useCallback(async (entry) => {
        await run('toggle', `/admin/profiles/${entry.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: !entry.enabled }),
        }, '')
      }, [run])

      const removeEnvironment = useCallback(async (entry) => {
        const deleteHelper = confirm(t('askRemoveHelper').replace('{path}', entry.sshHelper))
        const result = await run('remove', `/admin/profiles/${entry.id}?remoteHelper=${deleteHelper}`, { method: 'DELETE' }, t('removedMsg').replace('{id}', entry.id))
        if (result.ok && typeof result.uninstallScript === 'string') {
          setFlash(`${t('removedMsg').replace('{id}', entry.id)} ${t('uninstallAt').replace('{path}', result.uninstallScript)}`)
        }
      }, [run, t])

      useEffect(() => { void load() }, [load])

      const field = (key) => ({
        value: form[key],
        onChange: (event) => setForm((prev) => ({ ...prev, [key]: event.target.value })),
        style: styles.input,
      })

      const prepareEnvironment = useCallback(async () => {
        const sshHost = form.sshHost.trim()
        const sshUser = form.sshUser.trim()
        if (sshHost === '' || sshUser === '') { setFlash(t('errSsh')); return }
        setBusy('prepare')
        setFlash('')
        setPrepared(undefined)
        try {
          const result = await call('/admin/environments/prepare', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sshHost,
              sshUser,
              ...(form.sshPort.trim() === '' ? {} : { sshPort: Number(form.sshPort) }),
              ...(form.password === '' ? {} : { password: form.password }),
            }),
          })
          if (result.ok) setPrepared(result)
          else setFlash(t('actionFailed').replace('{message}', result.error ?? ''))
        } finally {
          setBusy('')
        }
      }, [form, t])

      const confirmEnvironment = useCallback(async () => {
        if (prepared === undefined) return
        setBusy('confirm')
        setFlash('')
        try {
          const result = await call('/admin/environments/confirm', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sshHost: form.sshHost.trim(),
              sshUser: form.sshUser.trim(),
              ...(form.sshPort.trim() === '' ? {} : { sshPort: Number(form.sshPort) }),
              ...(form.password === '' ? {} : { password: form.password }),
              workspace: form.workspace.trim() === '' ? undefined : form.workspace.trim(),
              sshHelper: form.sshHelper.trim(),
              fingerprint: prepared.fingerprint,
              // A placeholder: `confirm` deploys the helper and records the real digest.
              sshHelperHash: '0'.repeat(64),
            }),
          })
          if (result.ok) {
            setFlash(t('created').replace('{id}', result.environment.id))
            setPrepared(undefined)
            setForm((prev) => ({ ...prev, password: '', workspace: '' }))
            await load(true)
          } else {
            setFlash(t('actionFailed').replace('{message}', result.error ?? ''))
          }
        } finally {
          setBusy('')
        }
      }, [form, load, prepared, t])

      // One row plus its optional log panel. Health decides both the label and the
      // action offered: four states exist because they fail for unrelated reasons.
      const statusOf = (entry) => {
        if (!entry.running) return { label: t('stNotRunning'), action: 'start', tone: 'down' }
        const state = entry.health?.state
        if (state === 'ok') return { label: t('stOk'), action: null, tone: 'up' }
        if (state === 'helper-bad') return { label: t('stHelperBad'), action: 'deploy', tone: 'warn' }
        if (state === 'unreachable') return { label: t('stUnreachable'), action: 'retest', tone: 'warn' }
        return { label: t('stUnknown'), action: 'retest', tone: 'dim' }
      }

      const actionButton = (entry, status) => {
        if (status.action === 'start') {
          return h('button', { key: 'start', style: styles.button, disabled: busy !== '', onClick: () => void run('start', `/admin/profiles/${entry.id}/start`, { method: 'POST' }, t('startedMsg').replace('{id}', entry.id)) }, t('fixStart'))
        }
        if (status.action === 'deploy') {
          return h('button', { key: 'deploy', style: styles.button, disabled: busy !== '', onClick: () => void run('deploy', `/admin/profiles/${entry.id}/deploy`, { method: 'POST' }, t('deployed').replace('{host}', entry.sshHost)) }, busy === 'deploy' ? t('deployingNow') : t('fixDeploy'))
        }
        if (status.action === 'retest') {
          return h('button', { key: 'retest', style: styles.button, disabled: busy !== '', onClick: () => void load(true) }, t('fixRetest'))
        }
        return null
      }

      const renderRow = (entry) => {
        const status = statusOf(entry)
        const expanded = openLog === entry.id
        const main = h('tr', { key: entry.id },
          h('td', { style: styles.cell },
            h('div', null, entry.label),
            h('div', { style: styles.mono }, `/${entry.id}/`),
            entry.health?.detail !== undefined && entry.health.detail !== ''
              ? h('div', { style: styles.detail }, entry.health.detail)
              : null),
          h('td', { style: styles.cell },
            h('div', { style: styles.mono }, entry.sshHost),
            h('div', { style: styles.detail }, entry.sshHelper)),
          h('td', { style: styles.cell }, String(entry.port)),
          h('td', { style: { ...styles.cell, ...styles.mono } }, entry.workspace),
          h('td', { style: styles.cell },
            h('span', { style: status.tone === 'up' ? styles.ok : status.tone === 'warn' ? styles.warn : styles.dimText }, status.label),
            h('div', { style: styles.detail }, entry.enabled ? t('enabledOn') : t('enabledOff'))),
          h('td', { style: styles.cell },
            entry.running
              ? h('button', { key: 'open', style: styles.button, onClick: () => window.open(entry.url ?? `/${entry.id}/`, '_blank') }, t('open'))
              : null,
            actionButton(entry, status),
            h('button', { key: 'restart', style: styles.button, disabled: !entry.running || busy !== '', onClick: () => void run('restart', `/admin/profiles/${entry.id}/restart`, { method: 'POST' }, t('startedMsg').replace('{id}', entry.id)) }, t('restart')),
            h('button', { key: 'stop', style: styles.button, disabled: !entry.running || busy !== '', onClick: () => void run('stop', `/admin/profiles/${entry.id}/stop`, { method: 'POST' }, t('stoppedMsg').replace('{id}', entry.id)) }, t('stop')),
            h('button', { key: 'log', style: styles.button, disabled: busy !== '', onClick: () => void toggleLog(entry.id) }, expanded ? t('logClose') : t('log')),
            h('button', { key: 'toggle', style: styles.button, disabled: busy !== '', onClick: () => void toggleEnabled(entry) }, entry.enabled ? t('enabledOn') : t('enabledOff')),
            h('button', { key: 'remove', style: styles.button, disabled: busy !== '', onClick: () => void removeEnvironment(entry) }, t('remove'))))

        if (!expanded) return main
        const panel = h('tr', { key: `${entry.id}-log` },
          h('td', { colSpan: 6, style: { ...styles.cell, padding: 0 } },
            h('div', { style: styles.logBox },
              h('div', { style: styles.detail }, t('logTitle')),
              h('pre', { style: styles.logPre }, logText === '' ? t('logEmpty') : logText))))
        return [main, panel]
      }

      const table = h('table', { style: styles.table },
        h('thead', null, h('tr', null,
          ['colName', 'colKind', 'colPort', 'colWorkspace', 'colState', 'colActions'].map((key) => h('th', { key, style: styles.cell }, t(key))))),
        h('tbody', null, state.environments.flatMap(renderRow)))

      const children = [h('p', { key: 'hint', style: styles.hint }, t('hint'))]
      if (flash !== '') children.push(h('div', { key: 'flash', style: styles.ok }, flash))
      if (state.phase === 'failed') children.push(h('div', { key: 'error', style: styles.error }, t('unreachable')))
      if (state.phase === 'ready' && state.environments.length === 0) children.push(h('p', { key: 'empty', style: styles.hint }, t('empty')))
      if (state.phase === 'ready' && state.environments.length > 0) children.push(h('div', { key: 'table' }, table))
      children.push(h('div', { key: 'actions' },
        h('button', { style: styles.button, disabled: busy !== '', onClick: () => void load() }, t('refresh'))))

      // Two-phase onboarding: `prepare` writes nothing to the remote and returns the
      // host facts plus its host-key fingerprint. Only after the operator confirms
      // does `confirm` install anything.
      const formRows = []
      const addRow = (label, control) => {
        formRows.push(h('label', { key: `l-${label}` }, t(label)))
        formRows.push(control)
      }
      addRow('sshHostLabel', h('input', { key: 'host', ...field('sshHost'), placeholder: '192.168.1.10 或 dsh-box1' }))
      addRow('sshPortLabel', h('input', { key: 'port', ...field('sshPort'), placeholder: '22' }))
      addRow('sshUserLabel', h('input', { key: 'user', ...field('sshUser'), placeholder: 'root' }))
      addRow('authPasswordLabel', h('input', { key: 'pass', ...field('password'), type: 'password', placeholder: '①' }))
      addRow('authKeyLabel', h('input', { key: 'keyfile', ...field('bootstrapKey'), placeholder: '~/.ssh/id_ed25519（可留空）' }))
      addRow('workspaceLabel', h('input', { key: 'ws', ...field('workspace'), placeholder: '/root/workspace' }))
      addRow('sshHelperLabel', h('input', { key: 'helper', ...field('sshHelper') }))
      formRows.push(h('span', { key: 'gap' }))
      formRows.push(h('button', { key: 'prep', disabled: busy !== '', onClick: prepareEnvironment },
        busy === 'prepare' ? t('preparing') : t('probeAction')))

      if (prepared !== undefined) {
        formRows.push(h('span', { key: 'prepGap' }))
        formRows.push(h('div', { key: 'facts', style: styles.facts },
          h('div', { style: styles.factTitle }, t('hostFacts')),
          h('div', { style: styles.mono }, `host ${prepared.host.hostname} · ${prepared.host.arch} · ${prepared.host.os} · glibc ${prepared.host.glibc}`),
          h('div', { style: styles.detail }, `${t('fingerprintLabel')}: ${prepared.fingerprint}`),
          h('div', { style: styles.detail }, `${t('idLabel')}: ${prepared.id}`)))
        formRows.push(h('button', { key: 'doConfirm', disabled: busy !== '', onClick: confirmEnvironment },
          busy === 'confirm' ? t('deployingNow') : t('confirmInstall')))
      }

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
