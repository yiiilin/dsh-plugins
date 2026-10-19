window.__ModuleLoader__.load({
  id: '@yiln-dsh/dsh-session-mode',
  factory: (require) => {
    const React = require('react')
    const MODES = ['normal', 'delegate-writes']
    const NS = 'session-mode'
    const ZH_DICT = {
      label: '会话模式', toggle: '委托模式',
      on: '已开启', off: '已关闭',
      hint: '{label}：{state}。{detail}',
      normalTitle: '主 agent 可直接修改文件', delegateWritesTitle: '主 agent 只读，写入交给子 agent',
      busy: '会话运行中，暂不能切换。', conflict: '模式已变更，已重新读取，请重试。',
      worker: '子 agent 的模式在启动时固定。', unavailable: '会话模式暂不可用。',
      save_failed: '模式未能保存，原有权限保持不变。', saving: '正在保存会话模式。',
      unsupported: '当前 preset 未提供可直接调用的子 agent 工具。',
    }
    const EN_DICT = {
      label: 'Session mode', toggle: 'Delegate mode',
      on: 'On', off: 'Off',
      hint: '{label}: {state}. {detail}',
      normalTitle: 'The main agent may edit files directly', delegateWritesTitle: 'The main agent is read-only; subagents perform writes',
      busy: 'Wait until the session is idle before switching.', conflict: 'The mode changed elsewhere. Reloaded; try again.',
      worker: 'A worker keeps the mode captured at startup.', unavailable: 'Session mode is unavailable.',
      save_failed: 'The mode was not saved. Existing permissions are unchanged.', saving: 'Saving session mode.',
      unsupported: 'This preset has no directly callable subagent tool.',
    }

    function createRpc(caller, shared) {
      const call = async (op, sessionId, extra = {}, signal) => {
        let carrier
        try {
          carrier = await caller.call(shared ? '/api' : '/session-mode', shared ? 'session-mode' : 'control', { v: 1, op, sessionId, ...extra }, signal)
        } catch { throw Object.assign(new Error('unavailable'), { code: 'unavailable' }) }
        const value = carrier?.value
        if (!carrier?.ok || value?.v !== 1 || value.sessionId !== sessionId) {
          throw Object.assign(new Error('unavailable'), { code: 'unavailable' })
        }
        if (typeof value.code === 'string') throw Object.assign(new Error(value.code), { code: value.code })
        if (!MODES.includes(value.mode) || !Number.isSafeInteger(value.revision) || value.revision < 0
          || typeof value.busy !== 'boolean' || typeof value.worker !== 'boolean') {
          throw Object.assign(new Error('unavailable'), { code: 'unavailable' })
        }
        return value
      }
      return {
        read: (sessionId, signal) => call('read', sessionId, {}, signal),
        set: (sessionId, mode, revision, signal) => call('set', sessionId, { mode, revision }, signal),
      }
    }

    function createSelector(t, rpc, connection, sessions) {
      return function ModeSelector(props) {
        if (typeof props.useSession !== 'function') return null
        const running = props.useSession((state) => state.running)
        const removed = props.useSession((state) => state.removed)
        const worker = props.useSession((state) => state.subagent !== null)
        const [state, setState] = React.useState({ sessionId: props.sessionId, policy: null, saving: false, error: null })
        const active = React.useRef(null)
        React.useEffect(() => {
          if (worker || removed) return
          const life = { seq: 0, live: true, saving: false, controller: null }
          active.current = life
          const refresh = async (keepError = false) => {
            if (life.saving) return
            const seq = ++life.seq
            life.controller?.abort()
            const controller = new AbortController()
            life.controller = controller
            try {
              const policy = await rpc.read(String(props.sessionId), controller.signal)
              if (life.live && seq === life.seq) setState((old) => ({ sessionId: props.sessionId, policy, saving: false, error: keepError ? old.error : null }))
            } catch (error) {
              if (life.live && seq === life.seq) setState((old) => ({ ...old, sessionId: props.sessionId, policy: old.sessionId === props.sessionId ? old.policy : null, saving: false, hidden: error.code === 'unavailable', error: error.code === 'unavailable' ? null : error.code ?? 'unavailable' }))
            }
          }
          life.refresh = refresh
          refresh()
          const unsubscribeConnection = connection.generation?.subscribe?.(() => refresh())
          // The policy is committed outside the Session log, so another tab or
          // client changing it pushes nothing here; re-read when the page is
          // shown again so a returning user does not act on a stale value.
          const onVisible = () => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') refresh() }
          if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
          if (typeof window !== 'undefined') window.addEventListener('focus', onVisible)
          const events = sessions?.binding?.(props.sessionId)?.eventSource
          const unsubscribeEvents = events?.subscribe?.(() => {
            if (events.getSnapshot().change.entries?.some((entry) => entry.event?.type === 'command/done')) refresh()
          })
          return () => {
            life.live = false
            life.controller?.abort()
            unsubscribeConnection?.()
            unsubscribeEvents?.()
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
            if (typeof window !== 'undefined') window.removeEventListener('focus', onVisible)
          }
        }, [props.sessionId, running, worker, removed])
        if (worker || removed) return null
        const current = state.sessionId === props.sessionId ? state : { policy: null, saving: false, error: null }
        const disabled = running || current.saving || !current.policy || current.policy.worker
        const save = async (mode) => {
          const life = active.current
          if (disabled || !life?.live || life.saving || current.policy.mode === mode) return
          life.saving = true
          const seq = ++life.seq
          life.controller?.abort()
          life.controller = new AbortController()
          setState((old) => ({ ...old, saving: true, error: null }))
          try {
            const policy = await rpc.set(String(props.sessionId), mode, current.policy.revision, life.controller.signal)
            if (life.live && life.seq === seq) setState({ sessionId: props.sessionId, policy, saving: false, error: null })
          } catch (error) {
            if (life.live && life.seq === seq) {
              setState((old) => ({ ...old, saving: false, hidden: error.code === 'unavailable', error: error.code in EN_DICT ? error.code : 'save_failed' }))
              life.saving = false
              await life.refresh(true)
            }
          } finally { life.saving = false }
        }
        if (current.hidden || (!current.policy && !current.error)) return null
        const on = current.policy?.mode === 'delegate-writes'
        const stateWord = t(on ? 'on' : 'off')
        const hint = running ? t('busy')
          : current.error ? t(current.error)
            : current.policy?.worker ? t('worker')
              : t('hint', { label: t('toggle'), state: stateWord, detail: t(on ? 'delegateWritesTitle' : 'normalTitle') })
        return React.createElement('button', {
          type: 'button', className: 'ysm-toggle', role: 'switch',
          'aria-checked': on, 'aria-label': t('toggle'), 'aria-busy': current.saving,
          'data-session-id': String(props.sessionId), disabled, title: hint,
          onFocus: () => active.current?.refresh?.(),
          onClick: () => save(on ? 'normal' : 'delegate-writes'),
        },
        React.createElement('span', { className: 'ysm-dot', 'aria-hidden': true }),
        React.createElement('span', { className: 'ysm-label' }, t('toggle')))
      }
    }

    function installStyle() {
      if (typeof document === 'undefined') return () => {}
      const style = document.createElement('style')
      style.dataset.plugin = '@yiln-dsh/dsh-plugins'
      style.textContent = `
.ysm-toggle{box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;flex:none;height:28px;max-width:220px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,#4b5563);font:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer}
.ysm-toggle:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#e7e5e4)}
.ysm-toggle:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#2563eb))}
.ysm-toggle:disabled{color:var(--dsw-alias-label-dimmed,#9ca3af);cursor:default}
.ysm-toggle[aria-checked="true"]{background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-primary,#171717)}
.ysm-dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.35}
.ysm-toggle[aria-checked="true"] .ysm-dot{background:var(--dsw-alias-state-business-primary,#2563eb);opacity:1}
.ysm-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`
      document.head.append(style)
      return () => style.remove()
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH_DICT, en: EN_DICT }), 'session-mode: locale')
      ctx.effect(() => installStyle(), 'session-mode: stylesheet')
      const rpc = createRpc(ctx.connection.rpc, Reflect.has(ctx.connection, 'generation'))
      const Selector = createSelector(ctx.locale.bind(NS), rpc, ctx.connection, ctx.sessions)
      ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left', id: 'session-mode', order: 40, locale: NS, inject: () => ({}),
      }, Selector)), 'session-mode: selector')
    }
    return { name: 'session-mode-client', inject: ['connection', 'locale', 'slots', 'sessions'], apply, __test: { createRpc, createSelector } }
  },
})
