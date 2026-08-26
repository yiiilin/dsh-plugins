/*
 * dsh-plugin-terminal-tab — browser bundle.
 *
 * xterm.js owns the terminal DOM, keyboard handling, cursor, ANSI rendering,
 * scrollback and input composition. One WebSocket is opened for each PTY tab.
 */

window.__ModuleLoader__.load({
  id: '@yiln-dsh/dsh-plugin-terminal-tab',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    let React = require('react');
    const inject = ['slots'];
    const API_PREFIX = '/_dsh/terminal-tab';
    const WS_PATH = `${API_PREFIX}/ws`;
    const STYLE_ID = 'dsh-plugin-terminal-tab-style';
    let xtermPromise;

    async function api(method, payload) {
      const response = await fetch(`${API_PREFIX}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
      let value;
      try {
        value = await response.json();
      } catch (error) {
        throw new Error(`terminal API returned HTTP ${response.status}`);
      }
      if (!response.ok || value.ok === false) throw new Error(value.error || `terminal API returned HTTP ${response.status}`);
      return value;
    }

    function errorText(error) {
      return error && typeof error.message === 'string' ? error.message : '终端操作失败';
    }

    function loadXterm() {
      if (window.Terminal) return Promise.resolve(window.Terminal);
      if (xtermPromise) return xtermPromise;
      xtermPromise = new Promise((resolve, reject) => {
        if (document.querySelector('link[data-dsh-terminal-xterm-css]') === null) {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = `${API_PREFIX}/xterm.css`;
          link.dataset.dshTerminalXtermCss = 'true';
          document.head.appendChild(link);
        }
        const script = document.createElement('script');
        script.src = `${API_PREFIX}/xterm.js`;
        script.async = true;
        script.onload = () => window.Terminal ? resolve(window.Terminal) : reject(new Error('xterm.js did not expose Terminal'));
        script.onerror = () => reject(new Error('could not load xterm.js'));
        document.head.appendChild(script);
      });
      return xtermPromise;
    }

    function TerminalTabs({ sessions, selectedId, onSelect, onClose, onRename, closingIds }) {
      return React.createElement('div', { className: 'dtt-tab-strip', role: 'tablist', 'aria-label': '终端' },
        sessions.map((item, index) => {
          const title = item.name || `终端 ${index + 1}`;
          const active = item.sessionId === selectedId;
          const closing = closingIds.indexOf(item.sessionId) >= 0;
          const exited = item.status && item.status.kind === 'exited';
          return React.createElement('div', {
            key: item.sessionId,
            className: active ? 'dtt-tab-wrap dtt-tab-wrap-active' : 'dtt-tab-wrap',
          },
            React.createElement('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': active,
              className: 'dtt-tab',
              onClick: () => { if (!closing) onSelect(item.sessionId); },
              onDoubleClick: () => { if (!closing) onRename(item.sessionId); },
              disabled: closing,
              title: closing ? '正在关闭' : '双击重命名',
            },
              React.createElement('span', { className: exited ? 'dtt-tab-status dtt-tab-status-exited' : 'dtt-tab-status' }),
              title,
            ),
            React.createElement('button', {
              type: 'button',
              className: closing ? 'dtt-tab-close dtt-tab-close-loading' : 'dtt-tab-close',
              onClick: (event) => onClose(item.sessionId, event),
              disabled: closing,
              title: closing ? '正在关闭' : '关闭终端',
              'aria-label': closing ? `正在关闭${title}` : `关闭${title}`,
            }, closing ? React.createElement('span', { className: 'dtt-tab-spinner', 'aria-hidden': 'true' }) : 'x'),
          );
        }),
      );
    }

    function TerminalView({ sessionId }) {
      const [sessions, setSessions] = React.useState([]);
      const [activeId, setActiveId] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [creating, setCreating] = React.useState(false);
      const [closingIds, setClosingIds] = React.useState([]);
      const [nameDialogOpen, setNameDialogOpen] = React.useState(false);
      const [renameId, setRenameId] = React.useState(null);
      const [nameDraft, setNameDraft] = React.useState('');
      const hostRef = React.useRef(null);
      const viewRef = React.useRef(null);
      const runtimeRef = React.useRef(null);
      const closingRef = React.useRef([]);
      const hiddenRef = React.useRef([]);

      const disposeRuntime = () => {
        const runtime = runtimeRef.current;
        if (runtime === null) return;
        runtimeRef.current = null;
        if (runtime.dataDisposable) runtime.dataDisposable.dispose();
        if (runtime.resizeDisposable) runtime.resizeDisposable.dispose();
        if (runtime.socket) runtime.socket.close();
        if (runtime.terminal) runtime.terminal.dispose();
      };

      React.useEffect(() => {
        const view = viewRef.current;
        const scrollBody = view && view.closest('[data-conversation-scroll]');
        if (!scrollBody) return undefined;
        const previousHeight = scrollBody.style.getPropertyValue('--dsh-composer-height');
        scrollBody.setAttribute('data-dsh-terminal-active', 'true');
        scrollBody.style.setProperty('--dsh-composer-height', '0px');
        return () => {
          scrollBody.removeAttribute('data-dsh-terminal-active');
          if (previousHeight === '') scrollBody.style.removeProperty('--dsh-composer-height');
          else scrollBody.style.setProperty('--dsh-composer-height', previousHeight);
        };
      }, [sessionId]);

      React.useEffect(() => {
        let alive = true;
        let loading = false;
        const refresh = async () => {
          if (loading) return;
          loading = true;
          try {
            const result = await api('list', { sessionId });
            if (!alive) return;
            const rawNext = result.sessions || [];
            hiddenRef.current = hiddenRef.current.filter((id) => rawNext.some((item) => item.sessionId === id));
            const next = rawNext.filter((item) => closingRef.current.indexOf(item.sessionId) < 0 && hiddenRef.current.indexOf(item.sessionId) < 0);
            setSessions((current) => {
              const pending = current.filter((item) => closingRef.current.indexOf(item.sessionId) >= 0 && !next.some((fresh) => fresh.sessionId === item.sessionId));
              return next.concat(pending);
            });
            setActiveId((current) => current && next.some((item) => item.sessionId === current)
              ? current
              : (next.length > 0 ? next[0].sessionId : null));
            setError(null);
          } catch (cause) {
            if (alive) setError(errorText(cause));
          } finally {
            loading = false;
          }
        };
        void refresh();
        const timer = window.setInterval(() => void refresh(), 1000);
        return () => {
          alive = false;
          window.clearInterval(timer);
        };
      }, [sessionId]);

      React.useEffect(() => {
        let alive = true;
        let runtime = null;

        if (!activeId) {
          disposeRuntime();
          return undefined;
        }

        void loadXterm().then((Terminal) => {
          if (!alive || hostRef.current === null) return;
          const terminal = new Terminal({
            cursorBlink: true,
            convertEol: true,
            scrollback: 10000,
            fontSize: 13,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            theme: {
              background: '#0b0e12',
              foreground: '#d6f5d6',
              cursor: '#72d18e',
              cursorAccent: '#0b0e12',
              selectionBackground: 'rgba(114, 209, 142, .28)',
            },
          });
          terminal.open(hostRef.current);
          terminal.resize(160, 40);
          terminal.focus();

          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const query = `sessionId=${encodeURIComponent(sessionId)}&terminalId=${encodeURIComponent(activeId)}`;
          const socket = new WebSocket(`${protocol}//${window.location.host}${WS_PATH}?${query}`);
          runtime = { terminal, socket, dataDisposable: null, resizeDisposable: null };
          runtimeRef.current = runtime;
          socket.addEventListener('open', () => terminal.focus());
          socket.addEventListener('message', (event) => {
            try {
              const message = JSON.parse(event.data);
              if (message.type === 'snapshot' || message.type === 'output') {
                if (typeof message.data === 'string') terminal.write(message.data);
              } else if (message.type === 'error') {
                setError(typeof message.message === 'string' ? message.message : '终端连接失败');
              }
            } catch (cause) {
              setError(errorText(cause));
            }
          });
          socket.addEventListener('error', () => setError('终端 WebSocket 连接失败'));
          socket.addEventListener('close', () => {
            if (alive && runtimeRef.current === runtime && terminal !== undefined) terminal.write('\r\n\x1b[90m[WebSocket closed]\x1b[0m\r\n');
          });
          runtime.dataDisposable = terminal.onData((data) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data }));
          });
          runtime.resizeDisposable = terminal.onResize(({ cols, rows }) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows }));
          });
        }).catch((cause) => {
          if (alive) setError(errorText(cause));
        });

        return () => {
          alive = false;
          if (runtime !== null && runtimeRef.current === runtime) disposeRuntime();
        };
      }, [sessionId, activeId]);

      const openRenameDialog = (id) => {
        const session = sessions.find((item) => item.sessionId === id);
        if (!session || closingRef.current.indexOf(id) >= 0) return;
        setRenameId(id);
        setNameDraft(session.name || '');
        setNameDialogOpen(true);
        setError(null);
      };

      const createTerminal = async () => {
        if (creating) return;
        const usedNames = sessions.map((item, index) => item.name || `终端 ${index + 1}`);
        let number = 1;
        while (usedNames.indexOf(`终端 ${number}`) >= 0) number += 1;
        setCreating(true);
        setError(null);
        try {
          const result = await api('spawn', { sessionId, name: `终端 ${number}` });
          const session = result.session;
          if (session && typeof session.sessionId === 'string') {
            setSessions((current) => current.some((item) => item.sessionId === session.sessionId) ? current : current.concat(session));
            setActiveId(session.sessionId);
          }
        } catch (cause) {
          setError(errorText(cause));
        } finally {
          setCreating(false);
        }
      };

      const submitName = async (event) => {
        event.preventDefault();
        if (creating || renameId === null) return;
        setCreating(true);
        setError(null);
        try {
          const result = await api('rename', { sessionId, id: renameId, name: nameDraft.trim() });
          if (result.session) setSessions((current) => current.map((item) => item.sessionId === renameId ? result.session : item));
          setNameDialogOpen(false);
        } catch (cause) {
          setError(errorText(cause));
        } finally {
          setCreating(false);
        }
      };

      const closeTerminal = async (id, event) => {
        event.stopPropagation();
        if (closingRef.current.indexOf(id) >= 0) return;
        closingRef.current = closingRef.current.concat(id);
        hiddenRef.current = hiddenRef.current.concat(id);
        setClosingIds(closingRef.current.slice());
        setError(null);
        const closingActive = activeId === id;
        const remaining = sessions.filter((item) => item.sessionId !== id && closingRef.current.indexOf(item.sessionId) < 0);
        if (closingActive) {
          disposeRuntime();
          setActiveId(remaining.length > 0 ? remaining[0].sessionId : null);
        }
        try {
          await api('kill', { sessionId, id });
          setSessions((current) => current.filter((item) => item.sessionId !== id));
        } catch (cause) {
          setError(errorText(cause));
          hiddenRef.current = hiddenRef.current.filter((item) => item !== id);
          try {
            const result = await api('list', { sessionId });
            setSessions(result.sessions || []);
            if (closingActive) setActiveId((result.sessions || [])[0]?.sessionId || null);
          } catch (refreshError) {
            setError(errorText(refreshError));
          }
        } finally {
          closingRef.current = closingRef.current.filter((item) => item !== id);
          setClosingIds(closingRef.current.slice());
        }
      };

      const active = sessions.find((item) => item.sessionId === activeId);
      return React.createElement('div', { className: 'dtt-xterm', ref: viewRef, role: 'application', 'aria-label': '终端' },
        React.createElement('div', { className: 'dtt-terminal-bar' },
          React.createElement(TerminalTabs, {
            sessions,
            selectedId: activeId,
            closingIds,
            onSelect: (id) => {
              setError(null);
              setActiveId(id);
            },
            onRename: openRenameDialog,
            onClose: (id, event) => void closeTerminal(id, event),
          }),
          React.createElement('button', {
            type: 'button',
            className: 'dtt-new-terminal',
            onClick: () => void createTerminal(),
            disabled: creating,
            title: '新建终端',
            'aria-label': '新建终端',
          }, creating ? '...' : '+'),
          error ? React.createElement('span', { className: 'dtt-xterm-error', role: 'status' }, error) : null,
        ),
        active
          ? React.createElement('div', { className: 'dtt-xterm-host', ref: hostRef })
          : React.createElement('div', { className: 'dtt-xterm-empty' }, '暂无终端'),
        nameDialogOpen ? React.createElement('div', {
          className: 'dtt-name-overlay',
          onMouseDown: () => setNameDialogOpen(false),
        },
          React.createElement('form', {
            className: 'dtt-name-dialog',
            onSubmit: submitName,
            onMouseDown: (event) => event.stopPropagation(),
          },
            React.createElement('h3', { className: 'dtt-name-title' }, '重命名终端'),
            React.createElement('label', { className: 'dtt-name-label' },
              '终端名称',
              React.createElement('input', {
                className: 'dtt-name-input',
                value: nameDraft,
                onChange: (event) => setNameDraft(event.target.value),
                placeholder: '例如：前端开发',
                maxLength: 80,
                autoFocus: true,
              }),
            ),
            React.createElement('div', { className: 'dtt-name-actions' },
              React.createElement('button', { type: 'button', className: 'dtt-name-cancel', onClick: () => setNameDialogOpen(false) }, '取消'),
              React.createElement('button', { type: 'submit', className: 'dtt-name-submit', disabled: creating }, creating ? '保存中...' : '保存'),
            ),
          ),
        ) : null,
      );
    }

    function apply(ctx) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.setAttribute('data-plugin', 'dsh-plugin-terminal-tab');
      style.textContent = `
.dtt-new-terminal{appearance:none;width:28px;height:26px;flex:0 0 auto;padding:0;border:1px solid #33424e;border-radius:4px;background:#151c23;color:#b9c7d0;font:18px/1 inherit;cursor:pointer}
.dtt-new-terminal:hover:not(:disabled){background:#26323c;color:#fff}
.dtt-new-terminal:disabled{opacity:.55;cursor:default}
[data-conversation-scroll][data-dsh-terminal-active] > [data-composer-seat]{display:none!important}
.dtt-name-overlay{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.52)}
.dtt-name-dialog{width:min(340px,calc(100% - 32px));box-sizing:border-box;padding:16px;border:1px solid #33424e;border-radius:8px;background:#151c23;color:#d6f5d6;box-shadow:0 16px 48px rgba(0,0,0,.4);font:13px/1.4 sans-serif}
.dtt-name-title{margin:0 0 14px;font-size:14px;font-weight:600}
.dtt-name-label{display:flex;flex-direction:column;gap:6px;color:#9baab5;font-size:12px}
.dtt-name-input{box-sizing:border-box;width:100%;height:32px;padding:0 9px;border:1px solid #3b4b58;border-radius:5px;outline:0;background:#0b0e12;color:#e4fbe4;font:13px/1.4 inherit}
.dtt-name-input:focus{border-color:#72d18e;box-shadow:0 0 0 2px rgba(114,209,142,.18)}
.dtt-name-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.dtt-name-cancel,.dtt-name-submit{height:30px;padding:0 11px;border:1px solid #33424e;border-radius:5px;background:#151c23;color:#b9c7d0;font:12px/1 inherit;cursor:pointer}
.dtt-name-submit{border-color:#4f9463;background:#24412d;color:#d6f5d6}
.dtt-name-cancel:hover,.dtt-name-submit:hover:not(:disabled){background:#26323c;color:#fff}
.dtt-name-submit:disabled{opacity:.55;cursor:default}
.dtt-xterm{position:relative;height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:#0b0e12;color:#d6f5d6}
.dtt-terminal-bar{display:flex;align-items:center;gap:8px;min-height:40px;flex:0 0 auto;padding:6px 10px;border-bottom:1px solid #27313a;background:#11161c;overflow-x:auto}
.dtt-tab-strip{display:flex;align-items:center;gap:5px;min-width:0;overflow-x:auto}
.dtt-tab-wrap{display:inline-flex;align-items:center;flex:0 0 auto;border:1px solid #2c3945;border-radius:4px;background:#151c23}
.dtt-tab-wrap-active{border-color:#5fae74;background:#1d2b23}
.dtt-tab{appearance:none;display:inline-flex;align-items:center;gap:6px;height:26px;min-width:84px;padding:0 8px;border:0;background:transparent;color:#9baab5;font:12px/1 inherit;cursor:pointer;text-align:left}
.dtt-tab-wrap-active .dtt-tab{color:#d6f5d6;font-weight:600}
.dtt-tab-status{width:6px;height:6px;flex:0 0 auto;border-radius:50%;background:#65c98a}
.dtt-tab-status-exited{background:#7e8992}
.dtt-tab-close{appearance:none;width:22px;height:22px;padding:0;border:0;border-radius:3px;background:transparent;color:#7e8992;font:14px/1 inherit;cursor:pointer}
.dtt-tab-close:hover{background:#28323b;color:#fff}
.dtt-tab-close:disabled{cursor:default;opacity:.75}
.dtt-tab-spinner{display:block;width:11px;height:11px;border:2px solid #6f7d87;border-top-color:#8de8a7;border-radius:50%;animation:dtt-tab-spin .8s linear infinite}
@keyframes dtt-tab-spin{to{transform:rotate(360deg)}}
.dtt-xterm-error{max-width:min(42vw,420px);padding:4px 7px;border-radius:4px;background:#402128;color:#ffb4b4;font:12px/1.3 sans-serif;overflow-wrap:anywhere}
.dtt-xterm-host{flex:1 1 auto;min-height:0;padding:12px 14px;background:#0b0e12}
.dtt-xterm-host .xterm{height:100%;width:100%}
.dtt-xterm-host .xterm-viewport{background:#0b0e12!important}
.dtt-xterm-empty{display:flex;align-items:center;justify-content:center;flex:1 1 auto;min-height:180px;color:#6f7d87;background:#0b0e12;font:13px/1.4 sans-serif}
`;
      document.head.appendChild(style);
      ctx.effect(() => () => style.remove(), 'terminal-tab stylesheet');

      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'terminal',
        order: 20,
        label: '终端',
      }, TerminalView));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
