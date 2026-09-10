/*
 * dsh-plugin-voice-input — browser half.
 *
 * Contributes one mic button to the composer's trailing cluster (immediately
 * left of the model seat, the context meter, and the send button) and drives a
 * two-pass dictation session against the Host:
 *
 *   speaking  — 16 kHz mono PCM frames stream to the Host, whose realtime model
 *               publishes partial text; every partial is written into the
 *               composer draft, so words appear while the user is still talking;
 *   stopping  — the Host re-decodes the complete utterance with a non-realtime
 *               model, and that corrected text replaces the live hypothesis.
 *
 * The button owns no recognition state beyond the current phase: audio, models,
 * and text all live on the Host, and the draft is written through the session's
 * own `inputActions` seat.
 */

window.__ModuleLoader__.load({
  id: '@yiln-dsh/dsh-plugin-voice-input',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const { Tooltip } = primitives;

    const inject = ['slots'];
    const API_PREFIX = '/_dsh/voice-input';
    const WS_PATH = `${API_PREFIX}/ws`;
    const STYLE_ID = 'dsh-plugin-voice-input-style';
    const SAMPLE_RATE = 16000;
    const PARTIAL_INTERVAL_MS = 180;
    const STATUS_POLL_MS = 1500;

    const LOCALE_NS = 'voice-input';
    const ZH_DICT = {
      'button.idle': '语音输入',
      'button.record': '开始语音输入',
      'button.stop': '结束并矫正',
      'button.starting': '正在准备语音识别',
      'button.downloading': '正在下载语音模型 {percent}%',
      'button.recording': '正在识别，点击结束并矫正',
      'button.correcting': '正在用非实时模型矫正',
      'button.retry': '重试语音输入',
      'notice.download.start': '首次使用需要下载本地语音模型（约 400 MB），正在后台下载…',
      'notice.download.progress': '正在下载本地语音模型 {percent}%',
      'notice.download.failed': '语音模型下载失败：{message}',
      'notice.ready': '语音模型已就绪',
      'notice.insecure': '当前地址（{origin}）不是安全上下文，浏览器不提供麦克风。请改用 HTTPS 或 http://localhost 打开。',
      'notice.blocked': '浏览器已记住对 {origin} 的拒绝，不会再弹出授权：请点地址栏左侧的图标，把「麦克风」改成「允许」后重试（Chrome：网站设置 → 麦克风）。',
      'notice.denied': '麦克风授权未通过（{name}）。请点地址栏左侧的图标允许麦克风后重试。',
      'notice.no.microphone': '没有找到可用的麦克风设备（{name}）。',
      'notice.mic.busy': '麦克风被占用或系统拒绝访问（{name}），请关闭占用它的程序后重试。',
      'notice.mic.failed': '打开麦克风失败（{name}）：{message}',
      'notice.host.unreachable': '无法连接语音识别服务：{message}',
      'notice.dependency': 'DSH 主机缺少 sherpa-onnx-node，请重新安装本插件以安装依赖。',
      'notice.download.disabled': '模型下载已被配置禁用，请手动放置模型后再使用。',
      'notice.capped': '已达到单次录音上限（{seconds} 秒），已自动结束并开始矫正。',
      'notice.empty': '没有识别到语音内容。',
      'notice.failed': '语音识别失败：{message}',
      'notice.cancelled': '已取消本次语音输入。',
    };
    const EN_DICT = {
      'button.idle': 'Voice input',
      'button.record': 'Start voice input',
      'button.stop': 'Stop and correct',
      'button.starting': 'Preparing speech recognition',
      'button.downloading': 'Downloading speech models {percent}%',
      'button.recording': 'Listening — click to stop and correct',
      'button.correcting': 'Correcting with the non-realtime model',
      'button.retry': 'Retry voice input',
      'notice.download.start': 'First use downloads the local speech models (~400 MB) in the background…',
      'notice.download.progress': 'Downloading local speech models {percent}%',
      'notice.download.failed': 'Speech model download failed: {message}',
      'notice.ready': 'Speech models are ready',
      'notice.insecure': 'This address ({origin}) is not a secure context, so the browser exposes no microphone. Open the GUI over HTTPS or from http://localhost.',
      'notice.blocked': 'The browser has remembered a denial for {origin} and will not prompt again: click the icon at the left of the address bar, set Microphone to Allow, then retry (Chrome: Site settings → Microphone).',
      'notice.denied': 'Microphone access was not granted ({name}). Allow the microphone from the address bar and retry.',
      'notice.no.microphone': 'No microphone device is available ({name}).',
      'notice.mic.busy': 'The microphone is busy or the system refused access ({name}); close whatever is using it and retry.',
      'notice.mic.failed': 'Could not open the microphone ({name}): {message}',
      'notice.host.unreachable': 'Cannot reach the speech recognition service: {message}',
      'notice.dependency': 'This DSH host is missing sherpa-onnx-node; reinstall the plugin to install it.',
      'notice.download.disabled': 'Model download is disabled by configuration; place the models manually.',
      'notice.capped': 'The {seconds}s recording limit was reached; finishing and correcting automatically.',
      'notice.empty': 'No speech was recognized.',
      'notice.failed': 'Speech recognition failed: {message}',
      'notice.cancelled': 'Voice input was cancelled.',
    };

    function applyParams(template, params) {
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }

    const STYLE_TEXT = `
.dvi-root{position:relative;display:inline-flex;align-items:center;flex:none}
.dvi-button{box-sizing:border-box;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;flex:none;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer;transition:background-color .15s ease,color .15s ease}
.dvi-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#e7e5e4);color:var(--dsw-alias-label-primary,#111827)}
.dvi-button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:2px}
.dvi-button:disabled{cursor:default;opacity:.6}
.dvi-button-recording{background:var(--dsw-alias-interactive-bg-hover-danger,#fee2e2);color:var(--dsw-alias-state-error-primary,#b91c1c)}
.dvi-button-recording::after{content:"";position:absolute;inset:-3px;border-radius:999px;border:1.5px solid var(--dsw-alias-state-error-primary,#b91c1c);opacity:.5;animation:dvi-pulse 1.6s ease-out infinite;pointer-events:none}
.dvi-button-correcting{color:var(--dsw-alias-brand-primary,#2563eb)}
@keyframes dvi-pulse{0%{transform:scale(.86);opacity:.55}70%{transform:scale(1.12);opacity:0}100%{opacity:0}}
.dvi-spinner{width:13px;height:13px;border:1.5px solid currentColor;border-top-color:transparent;border-radius:50%;animation:dvi-spin .8s linear infinite}
@keyframes dvi-spin{to{transform:rotate(360deg)}}
.dvi-bubble{position:absolute;right:0;bottom:calc(100% + 8px);z-index:20;width:max-content;max-width:min(68vw,380px);padding:7px 10px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#111827);font:12px/1.5 inherit;white-space:normal;overflow-wrap:anywhere;text-align:left;box-shadow:0 6px 20px rgba(15,23,42,.14)}
.dvi-bubble-error{border-color:var(--dsw-alias-state-error-primary,#b91c1c);color:var(--dsw-alias-state-error-primary,#b91c1c)}
.dvi-bubble-warn{border-color:var(--dsw-alias-state-warn-primary,#b45309);color:var(--dsw-alias-state-warn-label,#b45309)}
`;

    /** Linear-interpolating resampler for devices that refuse a 16 kHz context. */
    function createResampler(ratio) {
      let tail = new Float32Array(0);
      return (input) => {
        const data = tail.length === 0 ? input : new Float32Array([...tail, ...input]);
        const length = Math.floor((data.length - 1) / ratio);
        if (length <= 0) {
          tail = data;
          return null;
        }
        const out = new Float32Array(length);
        for (let index = 0; index < length; index += 1) {
          const position = index * ratio;
          const left = Math.floor(position);
          const fraction = position - left;
          out[index] = data[left] * (1 - fraction) + data[left + 1] * fraction;
        }
        tail = data.slice(Math.floor(length * ratio));
        return out;
      };
    }

    /** Append dictated text to the draft, inserting a separator only where one belongs. */
    function joinDraft(base, text) {
      if (base === '') return text;
      if (text === '') return base;
      if (/[\s\n]$/.test(base) || /^[\s\n]/.test(text)) return `${base}${text}`;
      const cjk = /[\u3000-\u9fff\uff00-\uffef]/;
      const last = base.slice(-1);
      const first = text.slice(0, 1);
      return cjk.test(last) && cjk.test(first) ? `${base}${text}` : `${base} ${text}`;
    }

    function delay(ms) {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    }

    function createVoiceInputButton(t) {
      return function VoiceInputButton(props) {
        const inputActions = props.inputActions;
        const sessionId = props.sessionId;
        const useInput = typeof props.useInput === 'function' ? props.useInput : () => undefined;

        // `useInput` is a selector hook and must be called with a selector.
        // Selecting only the draft keeps this button out of every unrelated
        // composer update (phase, images, queue notices).
        const draft = useInput((state) => (state === undefined || state === null ? '' : state.draft));

        const [phase, setPhase] = React.useState('idle');
        const [bubble, setBubble] = React.useState(null);
        const [progress, setProgress] = React.useState(null);
        const [noticeSeq, setNoticeSeq] = React.useState(0);

        const draftRef = React.useRef('');
        const baseRef = React.useRef('');
        const actionsRef = React.useRef(undefined);
        const socketRef = React.useRef(undefined);
        const audioRef = React.useRef(undefined);
        const phaseRef = React.useRef('idle');
        const aliveRef = React.useRef(true);
        const partialAtRef = React.useRef(0);
        const noticeTimerRef = React.useRef(undefined);

        draftRef.current = typeof draft === 'string' ? draft : '';
        actionsRef.current = inputActions;
        phaseRef.current = phase;

        const notify = React.useCallback((level, text) => {
          if (!aliveRef.current) return;
          setNoticeSeq((seq) => seq + 1);
          setBubble({ level, text });
          if (noticeTimerRef.current !== undefined) clearTimeout(noticeTimerRef.current);
          if (level !== 'error') {
            noticeTimerRef.current = setTimeout(() => {
              if (aliveRef.current) setBubble(null);
            }, 4200);
          }
        }, []);

        const api = React.useCallback(async (method, payload) => {
          const response = await fetch(`${API_PREFIX}/${method}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload || {}),
          });
          let value;
          try {
            value = await response.json();
          } catch (error) {
            throw new Error(`HTTP ${response.status}`);
          }
          if (value.ok !== true) throw new Error(value.error || `HTTP ${response.status}`);
          return value;
        }, []);

        const teardownAudio = React.useCallback(() => {
          const audio = audioRef.current;
          audioRef.current = undefined;
          if (audio === undefined) return;
          try {
            audio.processor.onaudioprocess = null;
          } catch (error) {
            /* the node is already gone */
          }
          for (const node of [audio.processor, audio.source, audio.silent]) {
            try {
              node.disconnect();
            } catch (error) {
              /* not connected */
            }
          }
          try {
            for (const track of audio.stream.getTracks()) track.stop();
          } catch (error) {
            /* the track list is already released */
          }
          try {
            void audio.context.close();
          } catch (error) {
            /* already closed */
          }
        }, []);

        const closeSocket = React.useCallback((code) => {
          const socket = socketRef.current;
          socketRef.current = undefined;
          if (socket === undefined) return;
          socket.onmessage = null;
          socket.onerror = null;
          socket.onclose = null;
          try {
            socket.close(code ?? 1000);
          } catch (error) {
            /* already closed */
          }
        }, []);

        const setDraftFrom = React.useCallback((text) => {
          const actions = actionsRef.current;
          if (actions === undefined) return;
          actions.setDraft(joinDraft(baseRef.current, text));
        }, []);

        const stopCapture = React.useCallback(() => {
          teardownAudio();
          const socket = socketRef.current;
          if (socket !== undefined && socket.readyState === 1) {
            socket.send(JSON.stringify({ type: 'stop' }));
            setPhase('correcting');
            return true;
          }
          setPhase('idle');
          return false;
        }, [teardownAudio]);

        const cancelCapture = React.useCallback((silent) => {
          teardownAudio();
          const socket = socketRef.current;
          if (socket !== undefined && socket.readyState === 1) socket.send(JSON.stringify({ type: 'cancel' }));
          closeSocket();
          setDraftFrom('');
          setPhase('idle');
          setProgress(null);
          if (silent !== true) notify('info', t('notice.cancelled'));
        }, [closeSocket, notify, setDraftFrom, teardownAudio, t]);

        /**
         * Ask for the microphone on the click itself, before any model or Host
         * round-trip, so a permission problem is reported immediately instead of
         * after a download. The probe stream is released right away — the real
         * capture opens later, once the models and the socket are ready, and the
         * browser does not prompt twice for the same origin.
         */
        const acquireMicrophone = React.useCallback(async () => {
          const origin = window.location.origin;
          if (window.isSecureContext === false) {
            throw Object.assign(new Error(t('notice.insecure', { origin })), { friendly: true });
          }
          const media = navigator.mediaDevices;
          if (media === undefined || typeof media.getUserMedia !== 'function') {
            throw Object.assign(new Error(t('notice.insecure', { origin })), { friendly: true });
          }
          if (typeof navigator.permissions?.query === 'function') {
            try {
              const status = await navigator.permissions.query({ name: 'microphone' });
              // A remembered denial never prompts again: say so instead of
              // letting the user click into the same rejection.
              if (status.state === 'denied') {
                throw Object.assign(new Error(t('notice.blocked', { origin })), { friendly: true });
              }
            } catch (error) {
              if (error && error.friendly === true) throw error;
            }
          }
          try {
            return await media.getUserMedia({
              audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
          } catch (error) {
            const name = error && error.name ? String(error.name) : 'Error';
            if (name === 'NotFoundError' || name === 'OverconstrainedError') {
              throw Object.assign(new Error(t('notice.no.microphone', { name })), { friendly: true });
            }
            if (name === 'NotReadableError' || name === 'AbortError' || name === 'TrackStartError') {
              throw Object.assign(new Error(t('notice.mic.busy', { name })), { friendly: true });
            }
            if (name === 'NotAllowedError' || name === 'SecurityError') {
              throw Object.assign(new Error(t('notice.denied', { name })), { friendly: true });
            }
            throw Object.assign(
              new Error(t('notice.mic.failed', { name, message: error && error.message ? String(error.message) : '' })),
              { friendly: true },
            );
          }
        }, [t]);

        const stopStream = React.useCallback((stream) => {
          try {
            for (const track of stream.getTracks()) track.stop();
          } catch (error) {
            /* the track list is already released */
          }
        }, []);

        const openMicrophone = React.useCallback(async (socket) => {
          const stream = await acquireMicrophone();
          const AudioCtor = window.AudioContext || window.webkitAudioContext;
          if (typeof AudioCtor !== 'function') {
            stopStream(stream);
            throw Object.assign(new Error(t('notice.insecure', { origin: window.location.origin })), { friendly: true });
          }
          const context = new AudioCtor({ sampleRate: SAMPLE_RATE });
          if (typeof context.resume === 'function') await context.resume();
          const source = context.createMediaStreamSource(stream);
          const processor = context.createScriptProcessor(4096, 1, 1);
          const silent = context.createGain();
          silent.gain.value = 0;
          source.connect(processor);
          processor.connect(silent);
          silent.connect(context.destination);
          const resample = createResampler(context.sampleRate / SAMPLE_RATE);
          processor.onaudioprocess = (event) => {
            const target = socketRef.current;
            if (target === undefined || target.readyState !== 1) return;
            const channel = event.inputBuffer.getChannelData(0);
            const frames = context.sampleRate === SAMPLE_RATE ? channel : resample(channel);
            if (frames === null || frames.length === 0) return;
            const pcm = new Int16Array(frames.length);
            for (let index = 0; index < frames.length; index += 1) {
              const value = Math.max(-1, Math.min(1, frames[index]));
              pcm[index] = value < 0 ? value * 0x8000 : value * 0x7fff;
            }
            target.send(pcm.buffer);
          };
          audioRef.current = { stream, context, source, processor, silent };
        }, [t]);

        const handleMessage = React.useCallback((event) => {
          let message;
          try {
            message = JSON.parse(typeof event.data === 'string' ? event.data : '');
          } catch (error) {
            return;
          }
          if (message === null || typeof message !== 'object') return;
          switch (message.type) {
            case 'partial': {
              const now = Date.now();
              if (now - partialAtRef.current < PARTIAL_INTERVAL_MS) return;
              partialAtRef.current = now;
              setDraftFrom(String(message.text ?? ''));
              return;
            }
            case 'final': {
              const text = String(message.text ?? '').trim();
              if (text === '') {
                setDraftFrom('');
                notify('warn', t('notice.empty'));
              } else {
                setDraftFrom(text);
              }
              // The Host can finish on its own (recording cap), so the mic is
              // released here rather than only on the click-to-stop path.
              teardownAudio();
              setPhase('idle');
              setProgress(null);
              closeSocket();
              return;
            }
            case 'capped': {
              notify('warn', t('notice.capped', { seconds: message.seconds }));
              setPhase('correcting');
              return;
            }
            case 'progress': {
              setProgress(typeof message.percent === 'number' ? message.percent : null);
              return;
            }
            case 'error': {
              notify('error', t('notice.failed', { message: String(message.message ?? '') }));
              if (message.code === 'dependency-missing') notify('error', t('notice.dependency'));
              teardownAudio();
              setPhase('idle');
              setProgress(null);
              closeSocket();
              return;
            }
            default:
              return;
          }
        }, [closeSocket, notify, setDraftFrom, t, teardownAudio]);

        const startCapture = React.useCallback(async () => {
          baseRef.current = draftRef.current;
          partialAtRef.current = 0;
          const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const query = sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(String(sessionId))}`;
          const socket = new WebSocket(`${protocol}//${window.location.host}${WS_PATH}${query}`);
          socket.binaryType = 'arraybuffer';
          socketRef.current = socket;
          socket.onmessage = handleMessage;
          socket.onerror = () => {
            if (!aliveRef.current) return;
            notify('error', t('notice.host.unreachable', { message: 'WebSocket' }));
            teardownAudio();
            setPhase('idle');
            closeSocket();
          };
          socket.onclose = () => {
            if (!aliveRef.current) return;
            if (phaseRef.current === 'recording') {
              notify('error', t('notice.host.unreachable', { message: 'WebSocket closed' }));
              teardownAudio();
              setPhase('idle');
            }
          };
          await new Promise((resolveOpen, rejectOpen) => {
            socket.onopen = () => resolveOpen();
            const timer = setTimeout(() => rejectOpen(new Error('timeout')), 8000);
            socket.addEventListener('open', () => clearTimeout(timer), { once: true });
          });
          socket.onopen = null;
          socket.send(JSON.stringify({ type: 'start' }));
          await openMicrophone(socket);
          setPhase('recording');
        }, [closeSocket, handleMessage, notify, openMicrophone, sessionId, t, teardownAudio]);

        /**
         * Poll the Host until both models are ready, mirroring download progress
         * into the button so a first-use download is visible instead of silent.
         */
        const waitForModels = React.useCallback(async () => {
          let idlePolls = 0;
          for (let attempt = 0; attempt < 2400; attempt += 1) {
            if (!aliveRef.current) return false;
            await delay(STATUS_POLL_MS);
            if (!aliveRef.current) return false;
            let status;
            try {
              status = (await api('status')).status;
            } catch (error) {
              idlePolls += 1;
              if (idlePolls > 4) {
                notify('error', t('notice.host.unreachable', { message: error.message }));
                return false;
              }
              continue;
            }
            idlePolls = 0;
            if (status.ready === true) {
              setProgress(null);
              notify('info', t('notice.ready'));
              return true;
            }
            if (status.preparing !== null && status.preparing !== undefined) {
              setProgress(typeof status.preparing.percent === 'number' ? status.preparing.percent : null);
              continue;
            }
            setProgress(null);
            notify('error', t('notice.download.failed', { message: 'incomplete' }));
            return false;
          }
          notify('error', t('notice.download.failed', { message: 'timeout' }));
          return false;
        }, [api, notify, t]);

        const onToggle = React.useCallback(async () => {
          if (phaseRef.current === 'recording') {
            stopCapture();
            return;
          }
          if (phaseRef.current === 'correcting' || phaseRef.current === 'starting') return;
          setBubble(null);
          setPhase('starting');
          try {
            // 1. Microphone first, while the click is still the user's gesture:
            //    a denied or blocked permission must not hide behind a download.
            stopStream(await acquireMicrophone());
            // 2. Then the models, downloading them if this is the first use.
            const status = (await api('status')).status;
            if (status.sherpaOnnx !== true) {
              notify('error', t('notice.dependency'));
              setPhase('idle');
              return;
            }
            if (status.ready !== true) {
              if (status.config !== undefined && status.config.autoDownload === false) {
                notify('error', t('notice.download.disabled'));
                setPhase('idle');
                return;
              }
              notify('info', t('notice.download.start'));
              await api('prepare');
              const ready = await waitForModels();
              if (!ready) {
                setPhase('idle');
                return;
              }
            }
            await startCapture();
          } catch (error) {
            notify('error', error && error.friendly === true ? error.message : t('notice.failed', { message: error.message }));
            teardownAudio();
            closeSocket();
            setPhase('idle');
            setProgress(null);
          }
        }, [acquireMicrophone, api, closeSocket, notify, startCapture, stopCapture, stopStream, t, teardownAudio, waitForModels]);

        React.useEffect(() => {
          aliveRef.current = true;
          const onKeyDown = (event) => {
            if (event.key !== 'Escape') return;
            if (phaseRef.current !== 'recording' && phaseRef.current !== 'correcting') return;
            event.preventDefault();
            cancelCapture(false);
          };
          window.addEventListener('keydown', onKeyDown);
          return () => {
            aliveRef.current = false;
            window.removeEventListener('keydown', onKeyDown);
            if (noticeTimerRef.current !== undefined) clearTimeout(noticeTimerRef.current);
            teardownAudio();
            const socket = socketRef.current;
            if (socket !== undefined && socket.readyState === 1) socket.send(JSON.stringify({ type: 'cancel' }));
            closeSocket();
          };
        }, [cancelCapture, closeSocket, teardownAudio]);

        const busy = phase === 'starting' || phase === 'correcting';
        const label = phase === 'recording'
          ? t('button.recording')
          : phase === 'correcting'
            ? t('button.correcting')
            : phase === 'starting'
              ? (progress === null ? t('button.starting') : t('button.downloading', { percent: progress }))
              : t('button.record');

        const icon = busy
          ? React.createElement('span', { className: 'dvi-spinner' })
          : React.createElement(
              'svg',
              { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, fill: 'none' },
              React.createElement('path', {
                d: 'M8 1.75a2.2 2.2 0 0 0-2.2 2.2v3.9a2.2 2.2 0 0 0 4.4 0v-3.9A2.2 2.2 0 0 0 8 1.75Z',
                stroke: 'currentColor',
                strokeWidth: 1.2,
              }),
              React.createElement('path', {
                d: 'M3.9 7.4v.45a4.1 4.1 0 0 0 8.2 0V7.4M8 11.95v2.3M5.9 14.25h4.2',
                stroke: 'currentColor',
                strokeWidth: 1.2,
                strokeLinecap: 'round',
              }),
            );

        const bubbleNode = bubble === null
          ? null
          : React.createElement(
              'div',
              {
                className: `dvi-bubble${bubble.level === 'error' ? ' dvi-bubble-error' : bubble.level === 'warn' ? ' dvi-bubble-warn' : ''}`,
                role: 'status',
                'data-seq': noticeSeq,
              },
              bubble.text,
            );

        return React.createElement(
          'span',
          { className: 'dvi-root', 'data-voice-input': phase },
          bubbleNode,
          React.createElement(
            Tooltip,
            { label, side: 'top', delayMs: 400 },
            React.createElement(
              'button',
              {
                type: 'button',
                className: `dvi-button${phase === 'recording' ? ' dvi-button-recording' : ''}${busy ? ' dvi-button-correcting' : ''}`,
                'aria-label': label,
                'aria-pressed': phase === 'recording',
                disabled: busy,
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => {
                  void onToggle();
                },
              },
              icon,
            ),
          ),
        );
      };
    }

    function apply(ctx) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = STYLE_TEXT;
      document.head.appendChild(style);
      ctx.effect(() => () => style.remove(), 'voice-input stylesheet');

      const locale = ctx.get('locale');
      if (locale !== undefined) {
        ctx.effect(() => locale.register(LOCALE_NS, { zh: ZH_DICT, en: EN_DICT }), 'voice-input: locale');
      }
      const t = locale !== undefined
        ? locale.bind(LOCALE_NS)
        : (key, params) => applyParams(ZH_DICT[key] ?? EN_DICT[key] ?? key, params);

      const Button = createVoiceInputButton(t);
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'voice-input',
        order: 10,
        locale: LOCALE_NS,
        inject: (sessionId) => ({ sessionId }),
      }, Button));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
