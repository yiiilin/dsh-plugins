/**
 * @yiln-dsh/dsh-plugin-web-browser — browser bundle.
 *
 * Registers a "浏览器" view next to the terminal in the conversation view
 * tabs. The panel talks to the
 * Host over the /_dsh/web-browser WebSocket: the Host runs a server-side
 * Chromium and streams JPEG screencast frames; this view renders them as an
 * <img>, and forwards mouse / wheel / keyboard events back for injection.
 */

window.__ModuleLoader__.load({
  id: '@yiln-dsh/dsh-plugin-web-browser',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    let React = require('react');
    const inject = ['slots'];
    const API_PREFIX = '/_dsh/web-browser';
    const WS_PATH = `${API_PREFIX}/ws`;
    const STYLE_ID = 'dsh-plugin-web-browser-style';
    const MAX_TABS = 12;
    // Must match the Host's SCREENCAST_MAX_* so pointer coordinates map 1:1.
    const SCREENCAST_MAX_WIDTH = 1280;
    const SCREENCAST_MAX_HEIGHT = 900;
    // CDP Input modifiers bitmask.
    const MOD_ALT = 1, MOD_CTRL = 2, MOD_META = 4, MOD_SHIFT = 8;

    const LOCALE_NS = 'web-browser';
    const ZH_DICT = {
      'browser.title': '浏览器',
      'browser.region': '浏览器面板',
      'browser.address.placeholder': '输入网址，回车打开',
      'browser.address.label': '地址栏',
      'browser.back': '后退',
      'browser.forward': '前进',
      'browser.reload': '刷新',
      'browser.newTab': '新建标签页',
      'browser.closeTab': '关闭标签页',
      'browser.openFailed': '打开失败',
      'browser.connection.failed': '浏览器连接失败',
      'browser.connecting': '连接中…',
      'browser.empty': '输入网址开始浏览',
      'browser.launch.failed': '浏览器启动失败',
      'browser.loading': '加载中…',
      'browser.error': '操作失败',
      'browser.newTabDefault': '新标签页',
      'browser.mobileInput.hint': '移动端输入',
    };
    const EN_DICT = {
      'browser.title': 'Browser',
      'browser.region': 'Browser panel',
      'browser.address.placeholder': 'Enter a URL and press Enter',
      'browser.address.label': 'Address bar',
      'browser.back': 'Back',
      'browser.forward': 'Forward',
      'browser.reload': 'Reload',
      'browser.newTab': 'New tab',
      'browser.closeTab': 'Close tab',
      'browser.openFailed': 'Failed to open',
      'browser.connection.failed': 'Browser connection failed',
      'browser.connecting': 'Connecting…',
      'browser.empty': 'Enter a URL to start browsing',
      'browser.launch.failed': 'Browser launch failed',
      'browser.loading': 'Loading…',
      'browser.error': 'Operation failed',
      'browser.newTabDefault': 'New tab',
      'browser.mobileInput.hint': 'Mobile input',
    };

    function applyParams(template, params) {
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
    }

    function svgIcon(children, size = 16) {
      return React.createElement('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, children);
    }

    const backIcon = React.createElement(React.Fragment, null,
      React.createElement('polyline', { points: '15 5 8 12 15 19' }),
    );
    const forwardIcon = React.createElement(React.Fragment, null,
      React.createElement('polyline', { points: '9 5 16 12 9 19' }),
    );
    const reloadIcon = React.createElement(React.Fragment, null,
      React.createElement('path', { d: 'M21 12a9 9 0 1 1-2.6-6.4' }),
      React.createElement('polyline', { points: '21 3 21 9 15 9' }),
    );
    const plusIcon = React.createElement(React.Fragment, null,
      React.createElement('line', { x1: 12, y1: 5, x2: 12, y2: 19 }),
      React.createElement('line', { x1: 5, y1: 12, x2: 19, y2: 12 }),
    );
    const closeIcon = React.createElement(React.Fragment, null,
      React.createElement('line', { x1: 18, y1: 6, x2: 6, y2: 18 }),
      React.createElement('line', { x1: 6, y1: 6, x2: 18, y2: 18 }),
    );
    const globeIcon = React.createElement(React.Fragment, null,
      React.createElement('circle', { cx: 12, cy: 12, r: 9 }),
      React.createElement('path', { d: 'M3 12h18' }),
      React.createElement('path', { d: 'M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z' }),
    );
    const lockIcon = React.createElement(React.Fragment, null,
      React.createElement('rect', { x: 5, y: 10, width: 14, height: 10, rx: 2 }),
      React.createElement('path', { d: 'M8 10V7a4 4 0 0 1 8 0v3' }),
      React.createElement('line', { x1: 12, y1: 14, x2: 12, y2: 17 }),
    );

    function normalizeUrl(input) {
      const text = String(input || '').trim();
      if (text === '') return '';
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return text;
      if (/^[\w-]+(\.[\w-]+)+/.test(text)) return `http://${text}`;
      return `http://${text}`;
    }

    function createBrowserPage(t) {
      return function BrowserPage({ sessionId }) {
      const sessionIdValue = typeof sessionId === 'string' ? sessionId : '';

      const [tabs, setTabs] = React.useState([]);
      const [activeId, setActiveId] = React.useState(null);
      const [connected, setConnected] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [address, setAddress] = React.useState('');
      const [frameUrl, setFrameUrl] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [loadingTabId, setLoadingTabId] = React.useState(null);
      const socketRef = React.useRef(null);
      const objectUrlRef = React.useRef(null);
      const frameRef = React.useRef(null);
      const lastDrag = React.useRef(null);
      const browserStateInitializedRef = React.useRef(false);

      const updateFrame = (blob) => {
        // Assign directly to the <img> to avoid a React re-render per frame.
        const img = frameRef.current;
        if (img !== null) {
          if (objectUrlRef.current !== null) {
            try { URL.revokeObjectURL(objectUrlRef.current); } catch (_e) { /* noop */ }
          }
          const url = URL.createObjectURL(blob);
          objectUrlRef.current = url;
          img.src = url;
          setLoading(false);
          return;
        }
        // First frame: mount the <img>.
        if (objectUrlRef.current !== null) {
          try { URL.revokeObjectURL(objectUrlRef.current); } catch (_e) { /* noop */ }
        }
        const url = URL.createObjectURL(blob);
        objectUrlRef.current = url;
        setFrameUrl(url);
        setLoading(false);
      };
      const clearFrame = () => {
        if (objectUrlRef.current !== null) {
          try { URL.revokeObjectURL(objectUrlRef.current); } catch (_e) { /* noop */ }
        }
        objectUrlRef.current = null;
        setFrameUrl(null);
      };

      React.useEffect(() => () => clearFrame(), []);

      React.useEffect(() => {
        browserStateInitializedRef.current = false;
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(`${wsProtocol}//${window.location.host}${WS_PATH}?sessionId=${encodeURIComponent(sessionIdValue)}`);
        socketRef.current = socket;
        socket.addEventListener('open', () => setConnected(true));
        socket.addEventListener('message', (event) => {
          if (typeof event.data === 'string') {
            let message;
            try {
              message = JSON.parse(event.data);
            } catch (_e) {
              return;
            }
            if (message.type === 'ready') {
              setConnected(true);
            } else if (message.type === 'tabs') {
              const nextTabs = Array.isArray(message.tabs) ? message.tabs : [];
              const firstSnapshot = !browserStateInitializedRef.current;
              browserStateInitializedRef.current = true;
              setTabs(nextTabs);
              const nextActiveId = message.activeTabId || (nextTabs.length > 0 ? nextTabs[0].id : null);
              if (nextActiveId !== null) setActiveId(nextActiveId);
              else setActiveId(null);
              const nextActive = nextTabs.find((tab) => tab.id === nextActiveId);
              setAddress(nextActive && nextActive.url !== 'about:blank' ? nextActive.url : '');
              // Clear stale loading state when there is no tab to load.
              if (nextTabs.length === 0) {
                setLoadingTabId(null);
                setLoading(false);
                // Opening the Browser view starts with one Chrome-like blank
                // tab. Do this only for the first snapshot: closing the last
                // tab later must remain an intentional empty state.
                if (firstSnapshot && socket.readyState === WebSocket.OPEN) {
                  setLoading(true);
                  socket.send(JSON.stringify({ type: 'open', url: 'about:blank' }));
                }
              }
              setError(null);
            } else if (message.type === 'tab') {
              setTabs((current) => current.map((tab) => tab.id === message.tab.id ? message.tab : tab));
            } else if (message.type === 'nav-error') {
              setError(message.message || t('browser.openFailed'));
            } else if (message.type === 'loading') {
              // Refresh button spinner: track which tab is loading.
              setLoadingTabId(message.loading === true ? message.tabId : null);
              if (message.loading === true) setLoading(true);
              else setLoading(false);
            } else if (message.type === 'error') {
              setError(message.message || t('browser.error'));
              setLoading(false);
            }
          } else {
            // binary JPEG frame
            updateFrame(event.data);
          }
        });
        socket.addEventListener('close', () => {
          setConnected(false);
          setLoading(false);
        });
        socket.addEventListener('error', () => {
          setConnected(false);
          setError(t('browser.connection.failed'));
        });
        return () => {
          socket.close();
          socketRef.current = null;
        };
      }, [sessionIdValue]);

      const send = (message) => {
        const socket = socketRef.current;
        if (socket !== null && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(message));
        }
      };

      const openUrl = (raw) => {
        const url = normalizeUrl(raw);
        if (url === '') return;
        setAddress(url);
        setError(null);
        setLoading(true);
        send({ type: tabs.length === 0 ? 'open' : 'goto', url });
      };

      const newTab = () => {
        if (tabs.length >= MAX_TABS) return;
        setAddress('');
        setLoading(true);
        setError(null);
        send({ type: 'open', url: 'about:blank' });
      };

      const closeTab = (id) => {
        send({ type: 'close-tab', id });
        if (id === activeId) clearFrame();
      };

      const navigate = (action) => {
        setError(null);
        setLoading(true);
        send({ type: 'navigate', action });
      };

      const selectTab = (id) => {
        const selected = tabs.find((tab) => tab.id === id);
        setAddress(selected && selected.url !== 'about:blank' ? selected.url : '');
        setError(null);
        setLoading(true);
        setActiveId(id);
        send({ type: 'select-tab', id });
      };

      const onAddressKeyDown = (event) => {
        if (event.key === 'Enter') {
          openUrl(event.target.value);
        }
      };

      const pointerPosition = (event) => {
        const img = frameRef.current;
        if (img === null) return { x: 0, y: 0 };
        const rect = img.getBoundingClientRect();
        const scaleX = SCREENCAST_MAX_WIDTH / rect.width;
        const scaleY = SCREENCAST_MAX_HEIGHT / rect.height;
        const x = Math.round((event.clientX - rect.left) * scaleX);
        const y = Math.round((event.clientY - rect.top) * scaleY);
        return { x: Math.max(0, x), y: Math.max(0, y) };
      };

      const modifiers = (event) => {
        let mods = 0;
        if (event.altKey) mods |= MOD_ALT;
        if (event.ctrlKey) mods |= MOD_CTRL;
        if (event.metaKey) mods |= MOD_META;
        if (event.shiftKey) mods |= MOD_SHIFT;
        return mods;
      };

      const onPointerDown = (event) => {
        if (frameRef.current === null) return;
        const pos = pointerPosition(event);
        lastDrag.current = pos;
        send({
          type: 'input',
          subtype: 'mousedown',
          x: pos.x, y: pos.y,
          button: event.button === 2 ? 'right' : 'left',
          clickCount: event.detail || 1,
          modifiers: modifiers(event),
        });
      };

      const onPointerMove = (event) => {
        if (frameRef.current === null) return;
        const pos = pointerPosition(event);
        const dragging = lastDrag.current !== null;
        send({
          type: 'input',
          subtype: 'mousemove',
          x: pos.x, y: pos.y,
          button: dragging ? 'left' : 'none',
          buttons: dragging ? 1 : 0,
          modifiers: modifiers(event),
        });
      };

      const onPointerUp = (event) => {
        if (frameRef.current === null) return;
        const pos = pointerPosition(event);
        lastDrag.current = null;
        send({
          type: 'input',
          subtype: 'mouseup',
          x: pos.x, y: pos.y,
          button: event.button === 2 ? 'right' : 'left',
          modifiers: modifiers(event),
        });
      };

      const onWheel = (event) => {
        if (frameRef.current === null) return;
        const pos = pointerPosition(event);
        send({
          type: 'input',
          subtype: 'wheel',
          x: pos.x, y: pos.y,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          modifiers: modifiers(event),
        });
      };

      const onKeyDown = (event) => {
        if (frameRef.current === null) return;
        event.preventDefault();
        send({
          type: 'input',
          subtype: 'keydown',
          key: event.key,
          code: event.code,
          text: event.key.length === 1 ? event.key : undefined,
          modifiers: modifiers(event),
        });
      };

      const onKeyUp = (event) => {
        if (frameRef.current === null) return;
        send({
          type: 'input',
          subtype: 'keyup',
          key: event.key,
          code: event.code,
          modifiers: modifiers(event),
        });
      };

      const active = tabs.find((tab) => tab.id === activeId) || null;
      // A fresh tab (about:blank or empty URL) shows a Chrome-style new-tab
      // page instead of a frame.
      const isNewTab = active !== null && (active.url === 'about:blank' || active.url === '');
      const activeLoading = active !== null && loadingTabId === activeId;
      const addressIsSecure = /^https:\/\//i.test(address);

      // Hide the DSH composer whenever this view is mounted (being mounted
      // means it is the active conversation view), so the frame fills the
      // whole conversation area even before any browser tab exists.
      const viewRef = React.useRef(null);
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
      }, []);

      // Touch devices: a hidden keyboard host that summons the mobile keyboard
      // and forwards typed text into the server-side page (the screencast
      // <img> itself cannot receive mobile keyboard input).
      const [isCoarse, setIsCoarse] = React.useState(false);

      // When the mobile keyboard opens, iOS/Android shrink visualViewport but
      // not the layout viewport, so a height:100% shell would extend under the
      // keyboard. PWA standalone on iPhone Chrome does not reliably fire
      // visualViewport resize/scroll events, so we poll every 200ms and also
      // listen to focus/blur of the keyboard host as a fast path.
      const keyboardOpenRef = React.useRef(false);
      React.useEffect(() => {
        if (!isCoarse) return undefined;
        const shell = viewRef.current;
        if (shell === null) return undefined;
        const scrollBody = shell.closest('[data-conversation-scroll]');
        const apply = () => {
          const vv = window.visualViewport;
          const open = vv !== null && typeof vv === 'object'
            ? vv.height < window.innerHeight - 1
            : false;
          if (open !== keyboardOpenRef.current) {
            keyboardOpenRef.current = open;
            if (open) {
              // Shrink both the scroll body (the DSH layout root) and the
              // shell to the visible height so the frame sits exactly on top
              // of the keyboard.
              if (scrollBody !== null) {
                scrollBody.style.height = `${vv.height}px`;
                scrollBody.style.maxHeight = `${vv.height}px`;
              }
              shell.style.height = `${vv.height}px`;
              shell.style.maxHeight = `${vv.height}px`;
            } else {
              if (scrollBody !== null) {
                scrollBody.style.height = '';
                scrollBody.style.maxHeight = '';
              }
              shell.style.height = '';
              shell.style.maxHeight = '';
            }
          }
        };
        const onResize = () => { requestAnimationFrame(apply); };
        // Poll: PWA standalone may not fire visualViewport events at all.
        const timer = window.setInterval(apply, 200);
        if (typeof window.visualViewport === 'object') {
          window.visualViewport.addEventListener('resize', onResize);
          window.visualViewport.addEventListener('scroll', onResize);
        }
        // Fast path: keyboard host focus = keyboard opening.
        const host = mobileInputRef.current;
        const onFocus = () => { keyboardOpenRef.current = true; apply(); };
        const onBlur = () => { keyboardOpenRef.current = false; apply(); };
        if (host !== null) {
          host.addEventListener('focus', onFocus);
          host.addEventListener('blur', onBlur);
        }
        apply();
        return () => {
          window.clearInterval(timer);
          if (typeof window.visualViewport === 'object') {
            window.visualViewport.removeEventListener('resize', onResize);
            window.visualViewport.removeEventListener('scroll', onResize);
          }
          if (host !== null) {
            host.removeEventListener('focus', onFocus);
            host.removeEventListener('blur', onBlur);
          }
          if (scrollBody !== null) {
            scrollBody.style.height = '';
            scrollBody.style.maxHeight = '';
          }
          shell.style.height = '';
          shell.style.maxHeight = '';
          keyboardOpenRef.current = false;
        };
      }, [isCoarse]);

      // Touch scroll: a touch drag produces touchmove, not wheel, so without
      // this the drag would scroll the DSH page instead of the browser page.
      // We translate touch deltas into wheel deltas for the server-side page
      // and preventDefault so the outer container never scrolls.
      const touchRef = React.useRef(null);
      const attachTouchScroll = (img) => {
        if (img === null) return undefined;
        const onTouchStart = (event) => {
          const touch = event.touches && event.touches[0];
          if (touch === undefined) return;
          touchRef.current = { x: touch.clientX, y: touch.clientY };
        };
        const onTouchMove = (event) => {
          const start = touchRef.current;
          if (start === null) return;
          const touch = event.touches && event.touches[0];
          if (touch === undefined) return;
          const deltaX = start.x - touch.clientX;
          const deltaY = start.y - touch.clientY;
          touchRef.current = { x: touch.clientX, y: touch.clientY };
          if (deltaX !== 0 || deltaY !== 0) {
            event.preventDefault();
            send({
              type: 'input',
              subtype: 'wheel',
              x: 0, y: 0,
              deltaX,
              deltaY,
            });
          }
        };
        const onTouchEnd = () => { touchRef.current = null; };
        img.addEventListener('touchstart', onTouchStart, { passive: true });
        // non-passive so preventDefault can stop the outer page scroll
        img.addEventListener('touchmove', onTouchMove, { passive: false });
        img.addEventListener('touchend', onTouchEnd, { passive: true });
        return () => {
          img.removeEventListener('touchstart', onTouchStart);
          img.removeEventListener('touchmove', onTouchMove);
          img.removeEventListener('touchend', onTouchEnd);
          touchRef.current = null;
        };
      };
      React.useEffect(() => {
        if (!isCoarse) return undefined;
        return attachTouchScroll(frameRef.current);
      }, [isCoarse, frameUrl, active]);
      const mobileTextRef = React.useRef('');
      const mobileInputRef = React.useRef(null);
      React.useEffect(() => {
        if (typeof window.matchMedia !== 'function') return undefined;
        const query = window.matchMedia('(pointer: coarse)');
        const update = () => setIsCoarse(query.matches);
        update();
        query.addEventListener('change', update);
        return () => query.removeEventListener('change', update);
      }, []);

      // Note: we deliberately do NOT resize the shell on visualViewport
      // changes. On iOS Safari/Chrome, synchronously mutating layout during
      // the keyboard-open resize event interrupts the keyboard animation and
      // blurs the focused input (keyboard flashes and retracts). iOS already
      // shrinks the visual viewport natively; the shell simply tracks its
      // parent, which is what keeps the frame above the keyboard.
      // Live forwarding: each keystroke in the hidden host is immediately
      // injected into the server-side page (Playwright insertText handles CJK),
      // so the page behaves as if the keyboard typed straight into it.
      const sendText = (text) => {
        if (text === '') return;
        send({ type: 'input', subtype: 'keydown', key: text, text });
      };
      const onMobileChange = (event) => {
        const next = event.target.value;
        const prev = mobileTextRef.current;
        mobileTextRef.current = next;
        if (next.length > prev.length) {
          // added characters: forward the tail
          sendText(next.slice(prev.length));
        } else if (next.length < prev.length) {
          // removed characters: forward Backspace per removed char
          const removed = prev.length - next.length;
          for (let i = 0; i < removed; i++) {
            send({ type: 'input', subtype: 'keydown', key: 'Backspace', code: 'Backspace' });
            send({ type: 'input', subtype: 'keyup', key: 'Backspace', code: 'Backspace' });
          }
        }
      };
      const onMobileKeyDown = (event) => {
        if (event.key === 'Enter') {
          // Keep the keyboard closed on done: blur the host input.
          event.preventDefault();
          if (mobileInputRef.current !== null) mobileInputRef.current.blur();
        }
      };

      return React.createElement('div', {
        ref: viewRef,
        className: 'dsh-wb-shell',
        role: 'region',
        'aria-label': t('browser.region'),
      },
        tabs.length > 0
          ? React.createElement('div', { className: 'dsh-wb-tabs-row' },
              React.createElement('div', { className: 'dsh-wb-tabs', role: 'tablist', 'aria-label': t('browser.title') },
                tabs.map((tab) => React.createElement('div', {
                  key: tab.id,
                  className: (tab.id === activeId ? 'dsh-wb-tab dsh-wb-tab-active' : 'dsh-wb-tab') + (tab.id === loadingTabId ? ' dsh-wb-tab-loading' : ''),
                  role: 'tab',
                  'aria-selected': tab.id === activeId,
                },
                  React.createElement('button', {
                    type: 'button',
                    className: 'dsh-wb-tab-main',
                    onClick: () => selectTab(tab.id),
                    title: tab.url === 'about:blank' ? t('browser.newTabDefault') : (tab.title || tab.url),
                  },
                    React.createElement('span', { className: 'dsh-wb-tab-favicon', 'aria-hidden': 'true' }, svgIcon(globeIcon, 13)),
                    React.createElement('span', { className: 'dsh-wb-tab-label' }, tab.url === 'about:blank' ? t('browser.newTabDefault') : (tab.title || tab.url || t('browser.newTabDefault'))),
                  ),
                  React.createElement('button', {
                    type: 'button',
                    className: 'dsh-wb-tab-close',
                    onClick: () => closeTab(tab.id),
                    title: t('browser.closeTab'),
                    'aria-label': t('browser.closeTab'),
                  }, svgIcon(closeIcon, 11)),
                )),
              ),
              React.createElement('button', {
                type: 'button',
                className: 'dsh-wb-new-tab',
                onClick: newTab,
                disabled: tabs.length >= MAX_TABS,
                title: t('browser.newTab'),
                'aria-label': t('browser.newTab'),
              }, svgIcon(plusIcon, 13)),
            )
          : null,
        React.createElement('div', { className: 'dsh-wb-nav-row' },
          React.createElement('button', {
            type: 'button',
            className: 'dsh-wb-nav',
            onClick: () => navigate('back'),
            disabled: !connected || !active,
            title: t('browser.back'),
            'aria-label': t('browser.back'),
          }, svgIcon(backIcon, 15)),
          React.createElement('button', {
            type: 'button',
            className: 'dsh-wb-nav',
            onClick: () => navigate('forward'),
            disabled: !connected || !active,
            title: t('browser.forward'),
            'aria-label': t('browser.forward'),
          }, svgIcon(forwardIcon, 15)),
          React.createElement('button', {
            type: 'button',
            className: 'dsh-wb-nav' + (activeLoading ? ' dsh-wb-nav-loading' : ''),
            onClick: () => navigate('reload'),
            disabled: !connected || !active || activeLoading,
            title: activeLoading ? t('browser.loading') : t('browser.reload'),
            'aria-label': activeLoading ? t('browser.loading') : t('browser.reload'),
          }, activeLoading
            ? React.createElement('span', { className: 'dsh-wb-nav-spinner', 'aria-hidden': 'true' })
            : svgIcon(reloadIcon, 14)),
          React.createElement('div', { className: 'dsh-wb-address-shell' },
            React.createElement('span', {
              className: addressIsSecure ? 'dsh-wb-address-status dsh-wb-address-status-secure' : 'dsh-wb-address-status',
              'aria-hidden': 'true',
            }, svgIcon(addressIsSecure ? lockIcon : globeIcon, 14)),
            React.createElement('input', {
              type: 'text',
              className: 'dsh-wb-address',
              value: address,
              onChange: (event) => setAddress(event.target.value),
              onKeyDown: onAddressKeyDown,
              placeholder: t('browser.address.placeholder'),
              'aria-label': t('browser.address.label'),
              spellCheck: false,
              autoCapitalize: 'off',
              autoCorrect: 'off',
            }),
          ),
        ),
        activeLoading
          ? React.createElement('div', { className: 'dsh-wb-loading-line', 'aria-hidden': 'true' })
          : null,
        React.createElement('div', { className: 'dsh-wb-view' },
          !connected
            ? React.createElement('div', { className: 'dsh-wb-status' }, t('browser.connecting'))
            : isNewTab
              ? React.createElement('div', { className: 'dsh-wb-ntp', role: 'region', 'aria-label': t('browser.title') })
              : frameUrl === null
                ? (error
                    ? React.createElement('div', { className: 'dsh-wb-error', role: 'status' }, error)
                    : React.createElement('div', { className: 'dsh-wb-status' }, t('browser.empty')))
                : React.createElement('div', { className: 'dsh-wb-page-stage' },
                    React.createElement('img', {
                  ref: frameRef,
                  className: 'dsh-wb-frame',
                  src: frameUrl,
                  alt: '',
                  onPointerDown,
                  onPointerMove,
                  onPointerUp,
                  onWheel,
                  tabIndex: 0,
                  onKeyDown,
                  onKeyUp,
                  onClick: () => {
                    // iOS: focus() inside a click gesture is the reliable way
                    // to summon the keyboard; pointerup-based focus can be
                    // dropped by the OS.
                    if (isCoarse && mobileInputRef.current !== null) {
                      mobileInputRef.current.focus();
                    }
                  },
                }),
          ),
           loading && frameUrl !== null
            ? React.createElement('div', { className: 'dsh-wb-loading', role: 'status' }, t('browser.loading'))
            : null,
          error && frameUrl !== null
            ? React.createElement('div', { className: 'dsh-wb-error-float', role: 'status' }, error)
            : null,
        ),
        // Invisible keyboard host: a real <input> that summons the mobile
        // system keyboard when focused, but shows no UI. Tapping the frame
        // focuses it, so the keyboard rises from the bottom of the browser
        // viewport with the page (dvh) shrinking above it — no visible input
        // bar, no dialog. Typed text is forwarded to the server-side page.
        isCoarse && active && !isNewTab
          ? React.createElement('input', {
              ref: mobileInputRef,
              type: 'text',
              className: 'dsh-wb-mobile-host',
              onChange: onMobileChange,
              onKeyDown: onMobileKeyDown,
              'aria-label': t('browser.mobileInput.hint'),
              spellCheck: false,
              autoCapitalize: 'off',
              autoCorrect: 'off',
              enterKeyHint: 'done',
            })
          : null,
      );
      };
    }

    function apply(ctx) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.setAttribute('data-plugin', 'dsh-plugin-web-browser');
      style.textContent = `
.dsh-wb-shell{position:relative;width:100%;height:100%;min-width:0;min-height:0;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base,#f4f6f8);color:var(--dsw-alias-label-primary,#202124);--dwb-chrome-bg:var(--dsw-alias-bg-layer-1,#f4f6f8);--dwb-strip-bg:var(--dsw-alias-bg-layer-2,#e9edf1);--dwb-surface:var(--dsw-alias-bg-base,#fff);--dwb-border:var(--dsw-alias-border-l2,rgba(15,23,42,.14));--dwb-muted:var(--dsw-alias-label-secondary,#68707a);--dwb-accent:var(--dsw-alias-brand-primary,#4169e1)}
.dsh-wb-tabs-row{flex:0 0 38px;display:flex;align-items:flex-end;gap:6px;min-width:0;box-sizing:border-box;padding:4px 10px 0;border-bottom:1px solid var(--dwb-border);background:var(--dwb-strip-bg)}
.dsh-wb-nav-row{flex:0 0 48px;display:flex;align-items:center;gap:6px;min-width:0;box-sizing:border-box;padding:7px 12px;border-bottom:1px solid var(--dwb-border);background:var(--dwb-chrome-bg)}
.dsh-wb-view{position:relative;flex:1 1 0;min-width:0;min-height:0;display:flex;overflow:hidden;background:#e9edf1}
.dsh-wb-tabs{display:flex;align-items:flex-end;align-self:stretch;gap:2px;min-width:0;flex:1 1 auto;overflow-x:auto;scrollbar-width:none}
.dsh-wb-tabs::-webkit-scrollbar{display:none}
.dsh-wb-tab{position:relative;display:inline-flex;align-items:center;flex:0 0 auto;max-width:220px;height:32px;margin:0 1px;box-sizing:border-box;border:1px solid transparent;border-bottom:0;border-radius:8px 8px 0 0;background:transparent;overflow:hidden}
.dsh-wb-tab-active{border-color:var(--dwb-border);background:var(--dwb-surface);box-shadow:0 -1px 2px rgba(15,23,42,.04)}
.dsh-wb-tab-active:after{content:"";position:absolute;right:12px;bottom:0;left:12px;height:2px;border-radius:2px 2px 0 0;background:var(--dwb-accent)}
.dsh-wb-tab-main{appearance:none;display:flex;align-items:center;gap:7px;min-width:0;height:100%;flex:1 1 auto;padding:0 9px;border:0;background:transparent;color:var(--dwb-muted);cursor:pointer;font:12px/1 inherit;text-align:left;overflow:hidden}
.dsh-wb-tab-active .dsh-wb-tab-main{color:var(--dsw-alias-label-primary,#202124);font-weight:600}
.dsh-wb-tab-favicon{width:17px;height:17px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;color:var(--dwb-muted)}
.dsh-wb-tab-active .dsh-wb-tab-favicon{color:var(--dwb-accent)}
.dsh-wb-tab-loading .dsh-wb-tab-favicon{animation:dsh-wb-tab-pulse 1s ease-in-out infinite}
@keyframes dsh-wb-tab-pulse{50%{opacity:.35;transform:scale(.82)}}
.dsh-wb-tab-label{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-wb-tab-close{appearance:none;width:24px;height:24px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;margin-right:3px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dwb-muted);cursor:pointer}
.dsh-wb-tab-close:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dwb-strip-bg));color:var(--dsw-alias-label-primary,#202124)}
.dsh-wb-new-tab{appearance:none;width:30px;height:30px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;margin-bottom:1px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dwb-muted);cursor:pointer}
.dsh-wb-new-tab:hover:not(:disabled){background:rgba(15,23,42,.07);color:var(--dsw-alias-label-primary,#202124)}
.dsh-wb-new-tab:active,.dsh-wb-nav:active{transform:scale(.96)}
.dsh-wb-new-tab:disabled{opacity:.45;cursor:default}
.dsh-wb-nav{appearance:none;width:30px;height:30px;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dwb-muted);cursor:pointer}
.dsh-wb-nav:hover:not(:disabled){background:rgba(15,23,42,.07);color:var(--dsw-alias-label-primary,#202124)}
.dsh-wb-nav:disabled{opacity:.4;cursor:default}
.dsh-wb-nav-spinner{display:block;width:13px;height:13px;border:2px solid var(--dwb-border);border-top-color:var(--dwb-accent);border-radius:50%;animation:dsh-wb-spin .7s linear infinite}
@keyframes dsh-wb-spin{to{transform:rotate(360deg)}}
.dsh-wb-address-shell{min-width:0;flex:1 1 auto;height:34px;display:flex;align-items:center;box-sizing:border-box;border:1px solid var(--dwb-border);border-radius:10px;background:var(--dwb-surface);box-shadow:inset 0 1px 1px rgba(15,23,42,.03)}
.dsh-wb-address-shell:focus-within{border-color:var(--dwb-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--dwb-accent) 16%,transparent)}
.dsh-wb-address-status{width:32px;height:100%;flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;color:var(--dwb-muted)}
.dsh-wb-address-status-secure{color:#26834b}
.dsh-wb-address{min-width:0;flex:1 1 auto;height:100%;box-sizing:border-box;padding:0 10px 0 0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary,#202124);font:12px/1 inherit}
.dsh-wb-address::placeholder{color:var(--dsw-alias-label-secondary,#7b8490)}
.dsh-wb-loading-line{position:relative;flex:0 0 2px;height:2px;overflow:hidden;background:color-mix(in srgb,var(--dwb-accent) 20%,transparent)}
.dsh-wb-loading-line:after{content:"";position:absolute;inset:0;background:var(--dwb-accent);transform:translateX(-60%);animation:dsh-wb-progress 1.15s ease-in-out infinite}
@keyframes dsh-wb-progress{0%{transform:translateX(-100%) scaleX(.35)}50%{transform:translateX(0) scaleX(.75)}100%{transform:translateX(140%) scaleX(.35)}}
.dsh-wb-page-stage{width:100%;height:100%;min-width:0;min-height:0;display:flex;align-items:flex-start;justify-content:center;overflow:hidden;background:#fff}
.dsh-wb-frame{display:block;width:100%;height:100%;max-width:100%;max-height:100%;object-fit:contain;object-position:top center;outline:0;touch-action:none;background:#fff}
.dsh-wb-ntp{width:100%;height:100%;min-height:0;box-sizing:border-box;display:block;overflow:hidden;background:var(--dwb-surface)}
.dsh-wb-status,.dsh-wb-error{max-width:80%;padding:24px;color:var(--dwb-muted);font:13px/1.5 sans-serif;text-align:center}
.dsh-wb-error{color:var(--dsw-alias-state-error-primary,#b91c1c)}
.dsh-wb-loading,.dsh-wb-error-float{position:absolute;top:12px;left:50%;z-index:2;transform:translateX(-50%);max-width:70%;padding:5px 10px;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:rgba(255,255,255,.92);box-shadow:0 3px 12px rgba(15,23,42,.1);color:var(--dsw-alias-label-secondary,#68707a);font:11px/1.35 sans-serif}
.dsh-wb-error-float{color:var(--dsw-alias-state-error-primary,#b91c1c)}
.dsh-wb-mobile-host{position:fixed!important;left:0!important;top:0!important;width:2px!important;height:2px!important;padding:0!important;margin:0!important;border:0!important;outline:0!important;background:transparent!important;color:transparent!important;opacity:.01!important;font-size:16px!important}
@media (max-width:640px){
  .dsh-wb-tabs-row{padding-right:6px;padding-left:6px}
  .dsh-wb-tab{max-width:168px}
  .dsh-wb-nav-row{gap:3px;padding-right:8px;padding-left:8px}
  .dsh-wb-address-status{width:30px}
}
`;
      document.head.appendChild(style);
      ctx.effect(() => () => style.remove(), 'web-browser stylesheet');

      const locale = ctx.get('locale');
      if (locale !== undefined) {
        ctx.effect(() => locale.register(LOCALE_NS, { zh: ZH_DICT, en: EN_DICT }), 'web-browser: locale');
      }
      const t = locale !== undefined
        ? locale.bind(LOCALE_NS)
        : (key, params) => applyParams(ZH_DICT[key] ?? EN_DICT[key] ?? key, params);
      const BrowserPage = createBrowserPage(t);

      ctx.effect(() => {
        const slots = ctx.get('slots');
        if (slots === undefined) return;
        const disposeSlot = slots.inject('conversation.view', () => slots.register({
          name: 'conversation.view',
          id: 'browser',
          order: 30,
          label: t('browser.title'),
        }, BrowserPage));
        return disposeSlot;
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
