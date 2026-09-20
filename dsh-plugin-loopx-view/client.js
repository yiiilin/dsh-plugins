window.__ModuleLoader__.load({
  id: '@yiln-dsh/dsh-plugin-loopx-view',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');

    const REQUEST_VERSION = 'loopx_view_request_v1';
    const RESPONSE_VERSION = 'loopx_view_response_v1';
    const VIEW_CHANNEL = '/loopx-view';
    const VIEW_ENDPOINT = 'read';
    const SHARED_API_CHANNEL = '/api';
    const SHARED_API_ENDPOINT = 'loopx.view';
    const GOALBAR_CHANNEL = '/loopx';
    const GOALBAR_ENDPOINT = 'goalbar';
    const GOALBAR_VERSION = 'loopx_goalbar_request_v2';
    const GOALBAR_RESPONSE_VERSION = 'loopx_goalbar_response_v2';
    const LOCALE_NS = 'loopx.view';
    const PACKAGE_ID = '@yiln-dsh/dsh-plugin-loopx-view';

    const ZH = {
      'tab': 'LoopX',
      'loading': '正在读取当前会话的 LoopX 状态…',
      'refresh': '刷新',
      'refreshing': '刷新中…',
      'start': '启动',
      'pause': '暂停',
      'goal': '目标',
      'agent': 'Agent',
      'status': '状态',
      'next': '下一步',
      'gate': '门禁',
      'waiting': '等待',
      'progress': '待办进度',
      'flow': '执行流程',
      'graph': '任务依赖图',
      'dependencies': '依赖关系',
      'noGraph': '当前 Goal 没有可展示的任务图。',
      'noBinding': '当前会话还没有唯一的 LoopX Goal/Agent 绑定。',
      'ambiguousBinding': '当前会话存在多个 LoopX 绑定，页面已安全隐藏。',
      'cliUnavailable': 'LoopX CLI 当前不可用。',
      'bindingFailed': '无法读取当前会话的 LoopX 绑定。',
      'statusFailed': '绑定已找到，但无法读取 Goal 状态。',
      'sessionUnavailable': '当前会话不可用，请刷新后重试。',
      'transportFailed': '暂时无法连接 LoopX，请刷新后重试。',
      'active': '已激活',
      'stopped': '已停止',
      'running': '运行中',
      'idle': '空闲',
      'open': '待处理',
      'ready': '就绪',
      'blocked': '受阻',
      'done': '已完成',
      'unknown': '未知',
      'flow.goal': 'Goal',
      'flow.deliverable': 'Todo / 交付物',
      'flow.lease': 'Claim / Lease',
      'flow.run': 'Agent Turn / Run',
      'flow.validation': 'Validation',
      'flow.evidence': 'Evidence',
      'flow.next': 'Next Action',
      'edge.depends_on': '依赖',
      'edge.validates': '验证',
      'edge.supersedes': '替代',
      'edge.default': '关联',
      'error.unknown': 'LoopX 返回了无法识别的状态。',
    };
    const EN = {
      'tab': 'LoopX',
      'loading': 'Reading LoopX state for this Session…',
      'refresh': 'Refresh',
      'refreshing': 'Refreshing…',
      'start': 'Start',
      'pause': 'Pause',
      'goal': 'Goal',
      'agent': 'Agent',
      'status': 'Status',
      'next': 'Next action',
      'gate': 'Gate',
      'waiting': 'Waiting',
      'progress': 'Todo progress',
      'flow': 'Execution flow',
      'graph': 'Task dependency graph',
      'dependencies': 'Dependencies',
      'noGraph': 'No task graph is available for this Goal.',
      'noBinding': 'This Session has no unique LoopX Goal/Agent binding.',
      'ambiguousBinding': 'This Session has multiple LoopX bindings; the view is hidden.',
      'cliUnavailable': 'The LoopX CLI is unavailable.',
      'bindingFailed': 'The current Session binding could not be read.',
      'statusFailed': 'The binding was found, but Goal status could not be read.',
      'sessionUnavailable': 'The current Session is unavailable. Refresh to retry.',
      'transportFailed': 'LoopX is temporarily unreachable. Refresh to retry.',
      'active': 'Active',
      'stopped': 'Stopped',
      'running': 'Running',
      'idle': 'Idle',
      'open': 'Open',
      'ready': 'Ready',
      'blocked': 'Blocked',
      'done': 'Done',
      'unknown': 'Unknown',
      'flow.goal': 'Goal',
      'flow.deliverable': 'Todo / Deliverable',
      'flow.lease': 'Claim / Lease',
      'flow.run': 'Agent Turn / Run',
      'flow.validation': 'Validation',
      'flow.evidence': 'Evidence',
      'flow.next': 'Next action',
      'edge.depends_on': 'depends on',
      'edge.validates': 'validates',
      'edge.supersedes': 'supersedes',
      'edge.default': 'related',
      'error.unknown': 'LoopX returned an unsupported state.',
    };

    function applyParams(template, params) {
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
    }

    function installStyle() {
      if (typeof document === 'undefined' || document.querySelector(`style[data-plugin="${PACKAGE_ID}"]`) !== null) return;
      const style = document.createElement('style');
      style.dataset.plugin = PACKAGE_ID;
      style.textContent = `
.loopx-view{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;width:100%;height:100%;min-height:0;padding:18px 24px 32px;color:var(--dsw-alias-label-primary,#171717);background:var(--dsw-alias-bg-layer-1,#fff);overflow:auto;font:var(--dsw-font-xs-13,13px/1.5 system-ui,sans-serif)}
.loopx-view-header{display:flex;align-items:flex-start;gap:12px;min-width:0;padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e7eb)}
.loopx-view-title{min-width:0;flex:1}.loopx-view-title h1{margin:0;font-size:18px;line-height:26px;font-weight:650;overflow-wrap:anywhere}.loopx-view-subtitle{margin-top:4px;color:var(--dsw-alias-label-tertiary,#6b7280);font:var(--dsw-font-xxs-12,12px/18px ui-monospace,monospace);overflow-wrap:anywhere}
.loopx-view-actions{display:flex;flex:none;align-items:center;gap:6px}.loopx-view button{font:inherit}.loopx-view-button{min-height:30px;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#4b5563);cursor:pointer}.loopx-view-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f3f4f6);color:var(--dsw-alias-label-primary,#111827)}.loopx-view-button:disabled{cursor:default;opacity:.55}.loopx-view-button-primary{background:var(--dsw-alias-label-primary,#171717);border-color:var(--dsw-alias-label-primary,#171717);color:var(--dsw-alias-bg-base,#fff)}.loopx-view-button-primary:hover:not(:disabled){background:var(--dsw-alias-label-secondary,#374151);color:#fff}
.loopx-view-error,.loopx-view-empty{padding:12px 14px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#f8fafc);color:var(--dsw-alias-label-secondary,#4b5563);overflow-wrap:anywhere}.loopx-view-error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#b91c1c) 32%,var(--dsw-alias-border-l1,#e5e7eb));color:var(--dsw-alias-state-error-primary,#b91c1c)}
.loopx-view-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.loopx-view-card{min-width:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-base,#fff)}.loopx-view-card-label{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;line-height:16px}.loopx-view-card-value{margin-top:3px;min-height:19px;font-weight:600;overflow-wrap:anywhere}.loopx-view-card-value.mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;font-weight:500}
.loopx-view-section{display:flex;flex-direction:column;gap:8px}.loopx-view-section h2{margin:0;font-size:13px;line-height:19px;font-weight:650}.loopx-view-flow{display:flex;flex-direction:column;gap:0}.loopx-flow-node{position:relative;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-base,#fff)}.loopx-flow-node+.loopx-flow-node{margin-top:12px}.loopx-flow-node+.loopx-flow-node:before{content:'↓';position:absolute;top:-18px;left:50%;transform:translateX(-50%);color:var(--dsw-alias-label-caption,#9ca3af);font-size:14px}.loopx-flow-node[data-state=blocked]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#b91c1c) 42%,var(--dsw-alias-border-l1,#e5e7eb))}.loopx-flow-node[data-state=done]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#15803d) 7%,var(--dsw-alias-bg-base,#fff))}.loopx-flow-kind{color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;line-height:16px}.loopx-flow-title{margin-top:2px;font-weight:600;line-height:19px;overflow-wrap:anywhere}.loopx-flow-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:5px;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;line-height:16px}.loopx-view-list{display:flex;flex-direction:column;gap:6px}.loopx-view-list-item{padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);overflow-wrap:anywhere}.loopx-view-list-item strong{font-weight:600}.loopx-view-list-item small{display:block;margin-top:3px;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px}
@media (max-width:640px){.loopx-view{padding:14px 14px 26px}.loopx-view-summary{grid-template-columns:1fr}.loopx-view-header{flex-direction:column}.loopx-view-actions{width:100%}.loopx-view-button{flex:1}}
      `;
      document.head.appendChild(style);
    }

    function record(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
    }

    function callCarrier(caller, channel, endpoint, request, signal) {
      return caller.call(channel, endpoint, request, signal).then(carrier => {
        if (!carrier?.ok) return { ok: false, code: 'transport_failed' };
        const value = carrier.value;
        if (record(value)?.v !== RESPONSE_VERSION || value.op !== request.op || value.sessionId !== request.sessionId) return { ok: false, code: 'protocol_error' };
        return { ok: true, response: value };
      }).catch(() => ({ ok: false, code: 'transport_failed' }));
    }

    function createViewRpc(caller, sharedApi) {
      return {
        read(sessionId, signal) {
          const request = { v: REQUEST_VERSION, op: 'read', sessionId };
          return callCarrier(caller, sharedApi ? SHARED_API_CHANNEL : VIEW_CHANNEL, sharedApi ? SHARED_API_ENDPOINT : VIEW_ENDPOINT, request, signal);
        },
      };
    }

    function createGoalBarRpc(caller, sharedApi) {
      const call = (op, sessionId, extra, signal) => {
        const request = { v: GOALBAR_VERSION, op, sessionId, ...extra };
        return caller.call(sharedApi ? '/api' : GOALBAR_CHANNEL, sharedApi ? 'loopx.goalbar' : `goalbar/${op}`, request, signal).then(carrier => {
          if (!carrier?.ok) return { ok: false, code: 'transport_failed' };
          const value = carrier.value;
          return record(value)?.v === GOALBAR_RESPONSE_VERSION && value.op === op && value.sessionId === sessionId
            ? { ok: true, response: value }
            : { ok: false, code: 'protocol_error' };
        }).catch(() => ({ ok: false, code: 'transport_failed' }));
      };
      return {
        start(sessionId, expected, signal) { return call('start', sessionId, { expected }, signal); },
        pause(sessionId, expected, signal) { return call('pause', sessionId, { expected }, signal); },
      };
    }

    function stateLabel(t, value) {
      const key = typeof value === 'string' && value !== '' ? value : 'unknown';
      return t(key) || t('unknown');
    }

    function flowNodes(snapshot, t) {
      const nodes = Array.isArray(snapshot?.graph?.nodes) ? snapshot.graph.nodes : [];
      const order = ['deliverable', 'lease', 'run', 'validation', 'evidence'];
      const flow = [];
      flow.push({ kind: t('flow.goal'), title: snapshot.goalId, state: snapshot.goalActivation });
      for (const kind of order) {
        const matching = nodes.filter(node => node.kind === kind);
        if (matching.length === 0) {
          flow.push({ kind: t(`flow.${kind}`), title: t('unknown'), state: 'unknown' });
        } else {
          for (const node of matching.slice(0, 6)) {
            flow.push({ kind: t(`flow.${kind}`), title: node.title || node.nodeId, state: node.state, meta: node.ownerAgent });
          }
        }
      }
      flow.push({ kind: t('flow.next'), title: snapshot.nextAction || t('unknown'), state: snapshot.status });
      return flow;
    }

    function createLoopXView(t) {
      return function LoopXView({ sessionId, rpc, goalbarRpc, schedule }) {
        const [state, setState] = React.useState({ loading: true, refreshing: false, snapshot: null, hidden: null, error: null });
        const [action, setAction] = React.useState(null);
        const generation = React.useRef(0);
        const controller = React.useRef(null);

        const refresh = React.useCallback(async () => {
          const current = ++generation.current;
          controller.current?.abort();
          const nextController = new AbortController();
          controller.current = nextController;
          setState(previous => ({ ...previous, loading: previous.snapshot === null, refreshing: true, error: null }));
          const result = await rpc.read(String(sessionId), nextController.signal);
          if (current !== generation.current || nextController.signal.aborted) return;
          if (!result.ok) {
            setState({ loading: false, refreshing: false, snapshot: null, hidden: null, error: result.code });
            return;
          }
          const view = result.response.result;
          if (view.kind === 'present') setState({ loading: false, refreshing: false, snapshot: view.snapshot, hidden: null, error: null });
          else if (view.kind === 'hidden') setState({ loading: false, refreshing: false, snapshot: null, hidden: view.reason, error: null });
          else setState({ loading: false, refreshing: false, snapshot: null, hidden: null, error: view.code });
        }, [rpc, sessionId]);

        React.useEffect(() => {
          installStyle();
          refresh();
          const stop = typeof schedule === 'function' ? schedule(refresh, 10000) : () => {};
          return () => { controller.current?.abort(); stop?.(); };
        }, [refresh, schedule]);

        const runAction = async requested => {
          const snapshot = state.snapshot;
          if (snapshot === null || action !== null) return;
          setAction(requested);
          const result = requested === 'start'
            ? await goalbarRpc.start(String(sessionId), { goalId: snapshot.goalId, loopxAgentId: snapshot.loopxAgentId })
            : await goalbarRpc.pause(String(sessionId), { goalId: snapshot.goalId, loopxAgentId: snapshot.loopxAgentId });
          setAction(null);
          if (!result.ok) setState(previous => ({ ...previous, error: result.code, refreshing: false }));
          else refresh();
        };

        if (state.loading) return React.createElement('div', { className: 'loopx-view' }, React.createElement('div', { className: 'loopx-view-empty' }, t('loading')));
        if (state.hidden === 'binding_missing') return React.createElement('div', { className: 'loopx-view' }, React.createElement('div', { className: 'loopx-view-empty' }, t('noBinding')), React.createElement('button', { className: 'loopx-view-button', onClick: refresh }, state.refreshing ? t('refreshing') : t('refresh')));
        if (state.hidden === 'binding_ambiguous') return React.createElement('div', { className: 'loopx-view' }, React.createElement('div', { className: 'loopx-view-error' }, t('ambiguousBinding')), React.createElement('button', { className: 'loopx-view-button', onClick: refresh }, t('refresh')));
        if (state.error !== null || state.snapshot === null) {
          const errorKey = state.error === 'cli_unavailable' ? 'cliUnavailable' : state.error === 'binding_read_failed' ? 'bindingFailed' : state.error === 'status_read_failed' ? 'statusFailed' : state.error === 'session_unavailable' ? 'sessionUnavailable' : state.error === 'transport_failed' ? 'transportFailed' : 'error.unknown';
          return React.createElement('div', { className: 'loopx-view' }, React.createElement('div', { className: 'loopx-view-error' }, t(errorKey)), React.createElement('button', { className: 'loopx-view-button', onClick: refresh }, t('refresh')));
        }

        const snapshot = state.snapshot;
        const flow = flowNodes(snapshot, t);
        return React.createElement('div', { className: 'loopx-view', role: 'region', 'aria-label': t('tab') },
          React.createElement('header', { className: 'loopx-view-header' },
            React.createElement('div', { className: 'loopx-view-title' },
              React.createElement('h1', null, t('tab')),
              React.createElement('div', { className: 'loopx-view-subtitle' }, `${t('goal')}: ${snapshot.goalId}`),
            ),
            React.createElement('div', { className: 'loopx-view-actions' },
              React.createElement('button', { className: 'loopx-view-button', disabled: state.refreshing, onClick: refresh }, state.refreshing ? t('refreshing') : t('refresh')),
              React.createElement('button', { className: 'loopx-view-button loopx-view-button-primary', disabled: action !== null || snapshot.agentStatus === 'running', onClick: () => runAction('start') }, action === 'start' ? t('refreshing') : t('start')),
              React.createElement('button', { className: 'loopx-view-button', disabled: action !== null || snapshot.goalActivation !== 'active', onClick: () => runAction('pause') }, action === 'pause' ? t('refreshing') : t('pause')),
            ),
          ),
          React.createElement('section', { className: 'loopx-view-summary' },
            React.createElement('div', { className: 'loopx-view-card' }, React.createElement('div', { className: 'loopx-view-card-label' }, t('status')), React.createElement('div', { className: 'loopx-view-card-value' }, stateLabel(t, snapshot.status))),
            React.createElement('div', { className: 'loopx-view-card' }, React.createElement('div', { className: 'loopx-view-card-label' }, t('agent')), React.createElement('div', { className: 'loopx-view-card-value mono' }, `${snapshot.loopxAgentId} · ${stateLabel(t, snapshot.agentStatus)}`)),
            React.createElement('div', { className: 'loopx-view-card' }, React.createElement('div', { className: 'loopx-view-card-label' }, t('progress')), React.createElement('div', { className: 'loopx-view-card-value' }, `${snapshot.progress.done} / ${snapshot.progress.total}`)),
            React.createElement('div', { className: 'loopx-view-card' }, React.createElement('div', { className: 'loopx-view-card-label' }, t('gate')), React.createElement('div', { className: 'loopx-view-card-value' }, snapshot.gate || t('unknown'))),
          ),
          React.createElement('section', { className: 'loopx-view-section' }, React.createElement('h2', null, t('flow')), React.createElement('div', { className: 'loopx-view-flow' }, flow.map((node, index) => React.createElement('article', { className: 'loopx-flow-node', 'data-state': node.state, key: `${node.kind}-${index}` }, React.createElement('div', { className: 'loopx-flow-kind' }, node.kind), React.createElement('div', { className: 'loopx-flow-title' }, node.title), node.meta ? React.createElement('div', { className: 'loopx-flow-meta' }, node.meta) : null)))),
          React.createElement('section', { className: 'loopx-view-section' }, React.createElement('h2', null, t('next')), React.createElement('div', { className: 'loopx-view-list-item' }, snapshot.nextAction || t('unknown'), snapshot.waitingOn ? React.createElement('small', null, `${t('waiting')}: ${snapshot.waitingOn}`) : null)),
          React.createElement('section', { className: 'loopx-view-section' }, React.createElement('h2', null, t('dependencies')), snapshot.graph?.edges?.length ? React.createElement('div', { className: 'loopx-view-list' }, snapshot.graph.edges.slice(0, 40).map((edge, index) => React.createElement('div', { className: 'loopx-view-list-item', key: `${edge.from}-${edge.to}-${index}` }, React.createElement('strong', null, t(`edge.${edge.relation}`) || t('edge.default')), ` ${edge.from} → ${edge.to}`, edge.reason ? React.createElement('small', null, edge.reason) : null))) : React.createElement('div', { className: 'loopx-view-empty' }, t('noGraph'))),
        );
      };
    }

    function apply(ctx) {
      const locale = ctx.get('locale');
      const slots = ctx.get('slots');
      const connection = ctx.get('connection');
      if (slots === undefined || connection === undefined) return;
      installStyle();
      const locales = { zh: ZH, en: EN };
      if (locale !== undefined) ctx.effect(() => locale.register(LOCALE_NS, locales), 'loopx-view locale');
      const t = locale !== undefined ? locale.bind(LOCALE_NS) : (key, params) => applyParams(ZH[key] || EN[key] || key, params);
      const rpc = createViewRpc(connection.rpc, Reflect.has(connection, 'generation'));
      const goalbarRpc = createGoalBarRpc(connection.rpc, Reflect.has(connection, 'generation'));
      const schedule = (callback, delay) => {
        if (typeof ctx.interval !== 'function') return () => {};
        return ctx.interval(callback, delay);
      };
      ctx.effect(() => slots.inject('conversation.view', () => slots.register({
        name: 'conversation.view',
        id: 'loopx',
        order: 20,
        label: () => t('tab'),
        locale: LOCALE_NS,
        inject: sessionId => ({ sessionId: String(sessionId), rpc, goalbarRpc, schedule }),
      }, createLoopXView(t))), 'loopx-view conversation tab');
      ctx.effect(() => () => {
        if (typeof document !== 'undefined') document.querySelector(`style[data-plugin="${PACKAGE_ID}"]`)?.remove();
      }, 'loopx-view stylesheet');
    }

    exports.inject = ['connection', 'locale', 'slots', 'timer'];
    exports.apply = apply;
    return module.exports;
  },
});
