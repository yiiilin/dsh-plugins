window.__ModuleLoader__.load({
  id: '@yiln-dsh/dsh-plugin-mentor',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const REQUEST_VERSION = 'mentor_view_request_v1'
    const RESPONSE_VERSION = 'mentor_view_response_v1'
    const VIEW_CHANNEL = '/mentor-view'
    const VIEW_ENDPOINT = 'read'
    const SHARED_API_ENDPOINT = 'mentor.view'
    const LOCALE_NS = 'mentor.history'
    const PACKAGE_ID = '@yiln-dsh/dsh-plugin-mentor'

    const ZH = {
      tab: 'Mentor',
      title: 'Mentor 记录',
      refresh: '刷新',
      refreshing: '刷新中…',
      loading: '正在读取 Mentor 记录…',
      empty: '当前会话还没有已完成的 Mentor 咨询。',
      unavailable: '当前主会话暂不可用。',
      readFailed: '暂时无法读取 Mentor 记录。',
      truncated: '仅显示最近的记录。',
      question: '问题',
      answer: '导师回复',
      evidence: '证据',
      evidenceCount: '条',
      revision: '第 {revision} 次咨询',
      delivered: '已交付',
      pending: '待交付',
      undelivered: '未送达',
      settingsTitle: 'Mentor',
      settingsSummary: '全局配置模型路由、思考强度与超时；所有会话共用同一份设置。',
      settingsLoading: '正在读取模型目录和全局设置…',
      settingsUnavailable: 'Mentor 全局设置当前不可用。',
      settingsReadOnly: '本部署的插件配置不可写；请直接编辑 Profile 中的 dsh-mentor 行。',
      settingsConflict: '设置已被其他位置修改，已重新加载，请再保存一次。',
      settingsFailed: '设置未能保存；请检查模型与思考强度。',
      settingsWriteFailed: '设置未能写入 Profile 配置；请查看 daemon 日志。',
      model: '模型',
      profileModel: '使用 DSH 模型目录默认值（{provider}/{model}）',
      reasoning: '思考强度',
      modelDefault: '模型默认',
      serviceTier: '服务优先级沿用所选模型的 Profile 配置',
      metricsNotice: '生成次数、输入/上下文估算字节、回复字节与 provider usage 只写入 Mentor journal，不设上限、不做拦截。',
      enabled: '启用 Mentor 工具',
      enabledHint: '关闭后主 Agent 不再注册 mentor 工具；已保存的设置保留。',
      timeout: '单次超时（毫秒）',
      concurrency: '全局并发上限',
      concurrencyHint: '同时在跑的 Mentor 咨询数量上限。',
      invalidNumber: '请输入正整数。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
    }
    const EN = {
      tab: 'Mentor',
      title: 'Mentor history',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      loading: 'Loading Mentor history…',
      empty: 'No completed Mentor consultations in this Session.',
      unavailable: 'The primary Session is unavailable.',
      readFailed: 'Mentor history could not be read.',
      truncated: 'Showing the most recent records.',
      question: 'Question',
      answer: 'Mentor reply',
      evidence: 'Evidence',
      evidenceCount: 'items',
      revision: 'Consultation {revision}',
      delivered: 'Delivered',
      pending: 'Pending delivery',
      undelivered: 'Not delivered',
      settingsTitle: 'Mentor',
      settingsSummary: 'One global model route, reasoning effort, and timeout shared by every Session.',
      settingsLoading: 'Loading the model catalog and global settings…',
      settingsUnavailable: 'Mentor global settings are unavailable.',
      settingsReadOnly: 'This deployment stores plugin configuration read-only; edit the dsh-mentor row in the Profile instead.',
      settingsConflict: 'These settings changed elsewhere. The page reloaded them; save again.',
      settingsFailed: 'Settings could not be saved. Check the model and reasoning effort.',
      settingsWriteFailed: 'The Profile configuration write failed; check the daemon log.',
      model: 'Model',
      profileModel: 'Use the DSH model catalog default ({provider}/{model})',
      reasoning: 'Reasoning effort',
      modelDefault: 'Model default',
      serviceTier: 'Service tier follows the selected model Profile setting',
      metricsNotice: 'Generation counts, input/context byte estimates, reply bytes, and provider usage are recorded in the Mentor journal only — no limit is enforced.',
      enabled: 'Enable the Mentor tool',
      enabledHint: 'When off, the primary Agent no longer registers the mentor tool; saved settings are kept.',
      timeout: 'Request timeout (ms)',
      concurrency: 'Global concurrency',
      concurrencyHint: 'How many Mentor consultations may run at the same time.',
      invalidNumber: 'Enter a positive whole number.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
    }

    function applyParams(template, params) {
      if (!params) return template
      return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match)
    }

    function record(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
    }

    function routeKey(provider, model) {
      return JSON.stringify([provider, model])
    }

    function parseRouteKey(value) {
      if (typeof value !== 'string' || value === '') return undefined
      try {
        const parts = JSON.parse(value)
        return Array.isArray(parts) && parts.length === 2 && parts.every((part) => typeof part === 'string')
          ? { provider: parts[0], model: parts[1] }
          : undefined
      } catch {
        return undefined
      }
    }

    function draftFrom(values) {
      const settings = record(values) || {}
      return {
        route: typeof settings.provider === 'string' && settings.provider !== ''
          && typeof settings.model === 'string' && settings.model !== ''
          ? routeKey(settings.provider, settings.model)
          : '',
        reasoningEffort: typeof settings.reasoningEffort === 'string' ? settings.reasoningEffort : '',
        requestTimeoutMs: String(settings.requestTimeoutMs ?? ''),
        globalConcurrency: String(settings.globalConcurrency ?? ''),
        enabled: settings.enabled === true,
      }
    }

    function installStyle() {
      if (typeof document === 'undefined' || document.querySelector(`style[data-plugin="${PACKAGE_ID}"]`) !== null) return
      const style = document.createElement('style')
      style.dataset.plugin = PACKAGE_ID
      style.textContent = `
.mentor-history{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:100%;height:100%;min-height:0;padding:14px 18px 24px;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#171717);font:var(--dsw-font-xs-13,13px/1.5 system-ui,sans-serif)}
.mentor-history-header{display:flex;align-items:center;gap:10px;min-width:0;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb)}
.mentor-history-title{min-width:0;flex:1;margin:0;font-size:16px;line-height:22px;font-weight:650;overflow-wrap:anywhere}
.mentor-history-refresh{flex:none;min-height:30px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#4b5563);font:inherit;cursor:pointer}
.mentor-history-refresh:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}
.mentor-history-refresh:disabled{cursor:default;opacity:.55}
.mentor-history-notice{padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f8fafc);color:var(--dsw-alias-label-secondary,#4b5563);overflow-wrap:anywhere}
.mentor-history-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#b91c1c) 32%,var(--dsw-alias-border-l1,#e5e7eb));color:var(--dsw-alias-state-error-primary,#b91c1c)}
.mentor-history-list{display:flex;flex-direction:column;min-width:0}
.mentor-history-entry{display:flex;flex-direction:column;gap:8px;min-width:0;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb)}
.mentor-history-entry-header{display:flex;align-items:center;gap:8px;min-width:0}
.mentor-history-revision{flex:1;min-width:0;font-weight:650;overflow-wrap:anywhere}
.mentor-history-status{flex:none;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;line-height:16px}
.mentor-history-label{margin:0 0 3px;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;line-height:16px;font-weight:600}
.mentor-history-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.mentor-history-answer{padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2,#d1d5db)}
.mentor-history-evidence{min-width:0;color:var(--dsw-alias-label-secondary,#4b5563)}
.mentor-history-evidence summary{cursor:pointer;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:12px}
.mentor-history-evidence-item{margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,#e5e7eb)}
.mentor-history-evidence-source{margin:2px 0;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;overflow-wrap:anywhere}
.mentor-history-evidence-content{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font:var(--dsw-font-xxs-12,12px/1.5 ui-monospace,monospace)}
.mentor-history-skeleton{height:84px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb);background:linear-gradient(90deg,transparent,var(--dsw-alias-bg-layer-2,#f3f4f6),transparent);background-size:200% 100%;animation:mentor-history-pulse 1.4s ease-in-out infinite}
@keyframes mentor-history-pulse{to{background-position:-200% 0}}
.mentor-config{display:flex;flex-direction:column;gap:12px;min-width:0;padding:2px 0 6px}
.mentor-config-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.mentor-config-field label,.mentor-config-field>span{color:var(--dsw-alias-label-secondary,#4b5563);font-size:12px;font-weight:600}
.mentor-config-field select,.mentor-config-field input{box-sizing:border-box;width:100%;min-height:34px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#171717);font:inherit}
.mentor-config-field small{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;overflow-wrap:anywhere}
.mentor-config-check{display:flex;align-items:center;gap:8px;min-width:0}
.mentor-config-check input{min-height:0;width:auto}
.mentor-config-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mentor-config-actions button{min-height:32px;padding:6px 12px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#171717);font:inherit;cursor:pointer}
.mentor-config-actions button:disabled{cursor:default;opacity:.55}
@media (prefers-reduced-motion:reduce){.mentor-history-skeleton{animation:none;background:var(--dsw-alias-bg-layer-2,#f3f4f6)}}
@media (max-width:640px){.mentor-history{padding:12px 12px 20px}.mentor-history-header{align-items:flex-start}}
      `
      document.head.appendChild(style)
    }

    function createRpc(caller, sharedApi) {
      const call = (op, extra, signal) => {
        const request = { v: REQUEST_VERSION, op, ...extra }
        return caller.call(
          sharedApi ? '/api' : VIEW_CHANNEL,
          sharedApi ? SHARED_API_ENDPOINT : VIEW_ENDPOINT,
          request,
          signal,
        ).then((carrier) => {
          if (!carrier?.ok) return { ok: false, code: 'transport_failed' }
          const response = record(carrier.value)
          if (response?.v !== RESPONSE_VERSION || response.op !== op) return { ok: false, code: 'protocol_error' }
          return { ok: true, response }
        }).catch(() => ({ ok: false, code: 'transport_failed' }))
      }
      return {
        read(sessionId, signal) {
          return call('read', { sessionId }, signal).then((result) => {
            if (!result.ok || result.response.sessionId !== sessionId) {
              return { ok: false, code: result.code ?? 'protocol_error' }
            }
            return result
          })
        },
        readSettings(signal) { return call('settings-read', {}, signal) },
        saveSettings(settings, revision, signal) {
          return call('settings-save', { settings, revision: revision ?? null }, signal)
        },
      }
    }

    // Session history tab: reads the per-Session Mentor journal through the
    // Host RPC and renders the completed consultations of this Session.
    function createMentorHistoryView(t, rpc) {
      return function MentorHistoryView({ sessionId }) {
        const [history, setHistory] = React.useState({ loading: true, refreshing: false, records: [], truncated: false, error: null })
        const generation = React.useRef(0)
        const controller = React.useRef(null)

        const refreshHistory = React.useCallback(async () => {
          setHistory((previous) => ({ ...previous, loading: previous.records.length === 0, refreshing: true, error: null }))
          const current = ++generation.current
          controller.current?.abort()
          const nextController = new AbortController()
          controller.current = nextController
          const result = await rpc.read(String(sessionId), nextController.signal)
          if (current !== generation.current || nextController.signal.aborted) return
          if (!result.ok) {
            setHistory((previous) => ({ ...previous, loading: false, refreshing: false, error: 'readFailed' }))
            return
          }
          const view = result.response.result
          if (view?.kind === 'present' && Array.isArray(view.records)) {
            setHistory({ loading: false, refreshing: false, records: view.records, truncated: view.truncated === true, error: null })
          } else if (view?.kind === 'unavailable') {
            setHistory({ loading: false, refreshing: false, records: [], truncated: false, error: 'unavailable' })
          } else {
            setHistory((previous) => ({ ...previous, loading: false, refreshing: false, error: 'readFailed' }))
          }
        }, [rpc, sessionId])

        React.useEffect(() => {
          installStyle()
          refreshHistory()
          return () => {
            generation.current += 1
            controller.current?.abort()
          }
        }, [refreshHistory])

        const statusText = (status) => status === 'delivered' ? t('delivered')
          : status === 'undelivered' ? t('undelivered')
            : t('pending')
        const content = history.loading
          ? React.createElement('div', { className: 'mentor-history-list', 'aria-label': t('loading') },
              React.createElement('div', { className: 'mentor-history-skeleton' }),
              React.createElement('div', { className: 'mentor-history-skeleton' }),
              React.createElement('div', { className: 'mentor-history-skeleton' }))
          : history.error !== null
            ? React.createElement('div', { className: 'mentor-history-notice mentor-history-error', role: 'status' }, t(history.error))
            : history.records.length === 0
              ? React.createElement('div', { className: 'mentor-history-notice', role: 'status' }, t('empty'))
              : React.createElement(React.Fragment, null,
                  history.truncated ? React.createElement('div', { className: 'mentor-history-notice' }, t('truncated')) : null,
                  React.createElement('div', { className: 'mentor-history-list' }, history.records.map((item) =>
                    React.createElement('article', { className: 'mentor-history-entry', key: item.consultationId },
                      React.createElement('header', { className: 'mentor-history-entry-header' },
                        React.createElement('div', { className: 'mentor-history-revision' }, t('revision', { revision: item.revision })),
                        React.createElement('div', { className: 'mentor-history-status' }, statusText(item.deliveryStatus)),
                      ),
                      React.createElement('section', null,
                        React.createElement('h3', { className: 'mentor-history-label' }, t('question')),
                        React.createElement('p', { className: 'mentor-history-text' }, item.message),
                      ),
                      item.evidence?.length
                        ? React.createElement('details', { className: 'mentor-history-evidence' },
                            React.createElement('summary', null, `${t('evidence')} · ${item.evidence.length} ${t('evidenceCount')}`),
                            item.evidence.map((evidence) => React.createElement('div', { className: 'mentor-history-evidence-item', key: evidence.id },
                              React.createElement('strong', null, `${evidence.kind}: ${evidence.id}`),
                              React.createElement('div', { className: 'mentor-history-evidence-source' }, evidence.source),
                              React.createElement('pre', { className: 'mentor-history-evidence-content' }, evidence.content),
                            )),
                          )
                        : null,
                      React.createElement('section', { className: 'mentor-history-answer' },
                        React.createElement('h3', { className: 'mentor-history-label' }, t('answer')),
                        React.createElement('p', { className: 'mentor-history-text' }, item.answer),
                      ),
                    ),
                  )),
                )

        return React.createElement('div', { className: 'mentor-history', role: 'region', 'aria-label': t('title') },
          React.createElement('header', { className: 'mentor-history-header' },
            React.createElement('h2', { className: 'mentor-history-title' }, t('title')),
            React.createElement('button', {
              type: 'button',
              className: 'mentor-history-refresh',
              disabled: history.refreshing,
              onClick: refreshHistory,
              'aria-label': history.refreshing ? t('refreshing') : t('refresh'),
            }, history.refreshing ? t('refreshing') : t('refresh')),
          ),
          content,
        )
      }
    }

    // Global settings card: the plugin has exactly one configuration row, so
    // this is the only place model, reasoning, timeout, concurrency, and the
    // tool switch are edited. No Session is involved.
    function createMentorSettingsCard(t, rpc) {
      return function MentorSettingsCard(props) {
        const [state, setState] = React.useState({ loading: true, saving: false, data: null, draft: null, error: null, saved: false })

        const load = React.useCallback(async () => {
          setState((previous) => ({ ...previous, loading: true, error: null, saved: false }))
          const result = await rpc.readSettings()
          if (!result.ok) {
            setState((previous) => ({ ...previous, loading: false, error: 'settingsUnavailable' }))
            return
          }
          const view = result.response.result
          if (view?.kind !== 'settings') {
            setState((previous) => ({ ...previous, loading: false, error: view?.kind === 'fault' && view.code === 'read_only' ? 'settingsReadOnly' : 'settingsUnavailable' }))
            return
          }
          setState({ loading: false, saving: false, data: view, draft: draftFrom(view.values), error: null, saved: false })
        }, [rpc])

        React.useEffect(() => { installStyle() }, [])
        React.useEffect(() => { load() }, [load])

        const draft = state.draft
        const data = state.data
        const update = (key, value) => setState((previous) => previous.draft === null
          ? previous
          : { ...previous, saved: false, error: null, draft: { ...previous.draft, [key]: value } })

        const timeoutValue = draft === null ? NaN : Number(draft.requestTimeoutMs)
        const concurrencyValue = draft === null ? NaN : Number(draft.globalConcurrency)
        const numbersValid = Number.isSafeInteger(timeoutValue) && timeoutValue > 0
          && Number.isSafeInteger(concurrencyValue) && concurrencyValue > 0 && concurrencyValue <= 128
        const changed = draft !== null && data !== null
          && JSON.stringify(draft) !== JSON.stringify(draftFrom(data.values))

        const save = async () => {
          if (draft === null || data === null) return
          if (!numbersValid) {
            setState((previous) => ({ ...previous, error: 'invalidNumber', saved: false }))
            return
          }
          const route = parseRouteKey(draft.route)
          const payload = {
            enabled: draft.enabled === true,
            provider: route?.provider ?? '',
            model: route?.model ?? '',
            reasoningEffort: draft.reasoningEffort || '',
            requestTimeoutMs: timeoutValue,
            globalConcurrency: concurrencyValue,
          }
          setState((previous) => ({ ...previous, saving: true, error: null, saved: false }))
          const result = await rpc.saveSettings(payload, data.revision)
          const view = result.ok ? result.response.result : undefined
          if (view?.kind === 'settings') {
            setState({ loading: false, saving: false, data: view, draft: draftFrom(view.values), error: null, saved: true })
            return
          }
          if (view?.kind === 'fault' && view.code === 'conflict') {
            setState((previous) => ({ ...previous, saving: false, error: 'settingsConflict', saved: false }))
            load()
            return
          }
          const error = view?.kind === 'fault' && view.code === 'read_only' ? 'settingsReadOnly'
            : view?.kind === 'fault' && view.code === 'invalid_settings' ? 'settingsFailed'
              : view?.kind === 'fault' && view.code === 'save_failed' ? 'settingsWriteFailed'
                : 'settingsUnavailable'
          setState((previous) => ({ ...previous, saving: false, error, saved: false }))
        }

        if (props?.view === 'summary') return t('settingsSummary')
        if (state.loading) {
          return React.createElement('div', { className: 'mentor-history-notice', role: 'status' }, t('settingsLoading'))
        }
        if (state.error !== null && data === null) {
          return React.createElement('div', { className: 'mentor-history-notice mentor-history-error', role: 'status' }, t(state.error))
        }
        if (draft === null || data === null) {
          return React.createElement('div', { className: 'mentor-history-notice', role: 'status' }, t('settingsUnavailable'))
        }

        const catalog = data.catalog ?? { groups: [] }
        const route = parseRouteKey(draft.route)
        const activeRoute = route ?? catalog.default ?? undefined
        const modelInfo = activeRoute === undefined || activeRoute.provider === undefined
          ? undefined
          : catalog.groups?.find((group) => group.id === activeRoute.provider)?.models?.find((model) => model.id === activeRoute.model)
        const reasoningEfforts = Array.isArray(modelInfo?.reasoning?.efforts) ? modelInfo.reasoning.efforts : []
        const models = (catalog.groups ?? []).flatMap((group) => (group.models ?? []).map((model) => ({
          provider: group.id,
          providerName: group.name,
          model,
        })))
        const disabled = state.saving || data.writable !== true

        const numberField = (key, label, value, hint, max) => React.createElement('label', { className: 'mentor-config-field', key },
          React.createElement('span', null, t(label)),
          React.createElement('input', {
            type: 'number',
            min: 1,
            max,
            step: 1,
            value,
            disabled,
            onChange: (event) => update(key, event.target.value),
            'aria-label': t(label),
          }),
          hint === undefined ? null : React.createElement('small', null, t(hint)),
        )

        return React.createElement('div', { className: 'mentor-config' },
          React.createElement('label', { className: 'mentor-config-check' },
            React.createElement('input', {
              type: 'checkbox',
              checked: draft.enabled === true,
              disabled,
              onChange: (event) => update('enabled', event.target.checked),
              'aria-label': t('enabled'),
            }),
            React.createElement('span', null, t('enabled')),
          ),
          React.createElement('small', null, t('enabledHint')),
          React.createElement('label', { className: 'mentor-config-field' },
            React.createElement('span', null, t('model')),
            React.createElement('select', {
              value: draft.route,
              disabled,
              onChange: (event) => setState((previous) => previous.draft === null
                ? previous
                : { ...previous, saved: false, error: null, draft: { ...previous.draft, route: event.target.value, reasoningEffort: '' } }),
              'aria-label': t('model'),
            },
              React.createElement('option', { value: '' }, t('profileModel', {
                provider: catalog.default?.provider ?? '—',
                model: catalog.default?.model ?? '—',
              })),
              models.map((entry) => React.createElement('option', {
                value: routeKey(entry.provider, entry.model.id),
                key: routeKey(entry.provider, entry.model.id),
              }, `${entry.providerName} · ${entry.model.name || entry.model.id}`)),
            ),
          ),
          React.createElement('label', { className: 'mentor-config-field' },
            React.createElement('span', null, t('reasoning')),
            React.createElement('select', {
              value: draft.reasoningEffort,
              disabled: disabled || reasoningEfforts.length === 0,
              onChange: (event) => update('reasoningEffort', event.target.value),
              'aria-label': t('reasoning'),
            },
              React.createElement('option', { value: '' }, t('modelDefault')),
              reasoningEfforts.map((effort) => React.createElement('option', { value: effort.id, key: effort.id }, effort.name || effort.id)),
            ),
          ),
          React.createElement('div', { className: 'mentor-history-notice' }, t('serviceTier')),
          numberField('requestTimeoutMs', 'timeout', draft.requestTimeoutMs, undefined, 2147000000),
          numberField('globalConcurrency', 'concurrency', draft.globalConcurrency, 'concurrencyHint', 128),
          React.createElement('div', { className: 'mentor-history-notice' }, t('metricsNotice')),
          state.saved ? React.createElement('div', { className: 'mentor-history-notice', role: 'status' }, t('saved')) : null,
          state.error !== null ? React.createElement('div', { className: 'mentor-history-notice mentor-history-error', role: 'status' }, t(state.error)) : null,
          React.createElement('div', { className: 'mentor-config-actions' },
            React.createElement('button', {
              type: 'button',
              disabled: disabled || !changed || !numbersValid,
              onClick: () => { void save() },
            }, state.saving ? t('saving') : t('save')),
          ),
        )
      }
    }

    function apply(ctx) {
      const locale = ctx.get('locale')
      const slots = ctx.get('slots')
      const connection = ctx.get('connection')
      if (slots === undefined || connection === undefined) return
      const locales = { zh: ZH, en: EN }
      if (locale !== undefined) ctx.effect(() => locale.register(LOCALE_NS, locales), 'mentor locale')
      const t = locale !== undefined ? locale.bind(LOCALE_NS) : (key, params) => applyParams(ZH[key] || EN[key] || key, params)
      const rpc = createRpc(connection.rpc, Reflect.has(connection, 'generation'))

      // The per-Session tab shows history only; every setting is global.
      ctx.effect(() => slots.inject('conversation.view', () => slots.register({
        name: 'conversation.view',
        id: 'mentor-history',
        order: 30,
        label: () => t('tab'),
        locale: LOCALE_NS,
        inject: (sessionId) => ({ sessionId: String(sessionId), rpc }),
      }, createMentorHistoryView(t, rpc))), 'mentor history conversation tab')

      // The plugin's own global settings page, keyed by its configuration row.
      // `settings.section` is the top-level Settings entry (one nav item, one
      // page); the built-in plugins list additionally keeps it as a tab, while
      // the older collapsible `settings.plugin.item` / `plugins.item` cards are
      // gone — a click opens this page instead of unfolding a row.
      const SettingsCard = createMentorSettingsCard(t, rpc)
      const settingsPage = (name, order) => ({
        name,
        id: 'mentor',
        order,
        label: () => t('settingsTitle'),
        locale: LOCALE_NS,
        inject: () => ({ rpc }),
      })
      ctx.effect(() => slots.inject('settings.section', () => slots.register(
        settingsPage('settings.section', 25),
        SettingsCard,
      )), 'mentor global settings section')
      if (ctx.get('configForms') !== undefined) {
        ctx.effect(() => slots.inject('settings.plugins.tab', () => slots.register(
          settingsPage('settings.plugins.tab', 120),
          SettingsCard,
        )), 'mentor settings tab')
      }

      ctx.effect(() => () => {
        if (typeof document !== 'undefined') document.querySelector(`style[data-plugin="${PACKAGE_ID}"]`)?.remove()
      }, 'mentor stylesheet')
    }

    exports.inject = ['connection', 'locale', 'slots']
    exports.apply = apply
    return module.exports
  },
})
