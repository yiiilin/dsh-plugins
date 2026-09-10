/**
 * dsh-plugin-voice-input — Host half.
 *
 * Two-pass dictation for the Web GUI composer, entirely on this machine:
 *
 *   pass 1 (realtime)   — a streaming zipformer transducer decodes 16 kHz PCM
 *                         frames as they arrive and publishes partial text, so
 *                         the composer shows words while the user is speaking;
 *   pass 2 (corrective) — when the browser stops the recording, the complete
 *                         utterance is decoded again by a NON-realtime
 *                         SenseVoice model in a worker thread, and that text
 *                         replaces the streaming hypothesis.
 *
 * Both models run locally through `sherpa-onnx-node` (onnxruntime, CPU). No
 * audio ever leaves the machine: the browser only streams PCM to this Host over
 * the same authenticated WebSocket channel the terminal plugin uses.
 *
 * The browser half owns the mic button and the composer draft; this half owns
 * model provisioning, recognition, and the wire protocol below.
 *
 * Client → Host
 *   {type:'start'}                 begin a streaming session
 *   <binary>                       PCM, signed 16-bit little-endian, mono, 16 kHz
 *   {type:'stop'}                  finish: run the corrective pass, answer `final`
 *   {type:'cancel'}                drop the recording and its hypothesis
 *   {type:'status'}                ask for dependency/model readiness
 *
 * Host → Client
 *   {type:'hello', ...}            session opened, with current readiness
 *   {type:'partial', text}         full streaming hypothesis so far
 *   {type:'final', text, engine}   `offline` when the corrective pass produced it
 *   {type:'progress', ...}         model download progress
 *   {type:'capped', seconds}       recording hit maxRecordingSeconds
 *   {type:'error', code, message}  actionable failure, already localized by key
 */

import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import WebSocket, { WebSocketServer } from 'ws'
import z from '@deepseek-ai/schemastery'

export const name = 'voice-input'
export const inject = ['webServer']

export const Config = z.object({
  /** Model storage root; empty means `$DSH_HOME/plugins/dsh-plugin-voice-input/models`. */
  modelRoot: z.string().default(''),
  /** Base URL model files are fetched from (point this at a mirror when needed). */
  downloadBase: z.string().default('https://huggingface.co'),
  /** Realtime model: streaming transducer, decoded on the Host thread. */
  streamingModel: z.const('zipformer-bilingual-zh-en').default('zipformer-bilingual-zh-en'),
  /** Corrective model: non-realtime recognizer, decoded in a worker thread. */
  offlineModel: z.const('sense-voice-zh-en-ja-ko-yue').default('sense-voice-zh-en-ja-ko-yue'),
  /** CPU threads for the realtime recognizer (keep low: it runs continuously). */
  streamingThreads: z.natural().min(1).max(16).default(2),
  /** CPU threads for the corrective recognizer (runs once per utterance). */
  offlineThreads: z.natural().min(1).max(32).default(4),
  /** Language hint for the corrective model; `auto` covers zh/en/ja/ko/yue. */
  language: z.string().default('auto'),
  /** Download missing model files on the first recording attempt. */
  autoDownload: z.boolean().default(true),
  /** Hard cap on one recording; the corrective pass runs when it is reached. */
  maxRecordingSeconds: z.natural().min(5).max(1800).default(300),
  /** Silence, in seconds, that closes a streaming segment into committed text. */
  trailingSilenceSeconds: z.number().min(0.3).max(10).default(2.4),
})

const API_PREFIX = '/_dsh/voice-input'
const WS_PATH = `${API_PREFIX}/ws`
const DATA_DIR = ['plugins', 'dsh-plugin-voice-input']
const SAMPLE_RATE = 16000
const BYTES_PER_SAMPLE = 2
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024

/**
 * Model catalog. Every entry lists the exact upstream files it needs, so
 * provisioning is a plain HTTPS download with no archive extraction step.
 */
const STREAMING_MODELS = {
  'zipformer-bilingual-zh-en': {
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20',
    dir: 'streaming-zipformer-bilingual-zh-en-2023-02-20',
    files: {
      encoder: 'encoder-epoch-99-avg-1.int8.onnx',
      decoder: 'decoder-epoch-99-avg-1.int8.onnx',
      joiner: 'joiner-epoch-99-avg-1.int8.onnx',
      tokens: 'tokens.txt',
    },
  },
}

const OFFLINE_MODELS = {
  'sense-voice-zh-en-ja-ko-yue': {
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    dir: 'sense-voice-zh-en-ja-ko-yue-2024-07-17',
    files: {
      model: 'model.int8.onnx',
      tokens: 'tokens.txt',
    },
  },
}

/** Engine-level failure carrying a stable code the browser maps onto locale copy. */
class VoiceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'VoiceError'
    this.code = code
  }
}

function dshHome() {
  const env = process.env.DSH_HOME
  if (env !== undefined && env.trim().length > 0) return resolve(env.trim())
  return join(homedir(), '.dsh')
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJson(req, limit = 65536) {
  let body = ''
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new VoiceError('bad-request', 'request body too large')
    body += chunk
  }
  if (body.trim().length === 0) return {}
  const value = JSON.parse(body)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new VoiceError('bad-request', 'request body must be an object')
  }
  return value
}

async function exists(path) {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

/** Convert signed 16-bit little-endian PCM into the float samples sherpa wants. */
function pcm16ToFloat32(buffer) {
  const count = Math.floor(buffer.length / BYTES_PER_SAMPLE)
  const samples = new Float32Array(count)
  for (let index = 0; index < count; index += 1) {
    samples[index] = buffer.readInt16LE(index * BYTES_PER_SAMPLE) / 32768
  }
  return samples
}

function concatFloat32(chunks, total) {
  const samples = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    samples.set(chunk, offset)
    offset += chunk.length
  }
  return samples
}

/**
 * Long-lived corrective-pass worker. It owns the non-realtime recognizer so a
 * multi-second decode never stalls the daemon's event loop.
 */
class OfflineWorker {
  constructor(options) {
    this.options = options
    this.worker = undefined
    this.pending = new Map()
    this.sequence = 0
    this.ready = false
    this.failure = undefined
    this.stopping = false
  }

  start() {
    if (this.worker !== undefined) return this.worker
    const worker = new Worker(new URL('./offline-worker.js', import.meta.url), {
      workerData: { sampleRate: SAMPLE_RATE, ...this.options },
    })
    worker.on('message', (message) => this.#onMessage(message))
    worker.on('error', (error) => this.#onFailure(error))
    worker.on('exit', (code) => {
      if (this.stopping) return
      this.#onFailure(new Error(`voice-input: corrective worker exited with code ${code}`))
    })
    worker.unref?.()
    this.worker = worker
    return worker
  }

  #onMessage(message) {
    if (message === null || typeof message !== 'object') return
    if (message.type === 'ready') {
      this.ready = true
      this.failure = undefined
      for (const settle of this.pending.values()) settle.resolve()
      this.pending.clear()
      return
    }
    if (message.type === 'failed') {
      this.#onFailure(new Error(String(message.message)))
      return
    }
    if (message.type === 'result') {
      const entry = this.pending.get(message.id)
      if (entry === undefined) return
      this.pending.delete(message.id)
      if (message.ok === true) entry.resolve(String(message.text ?? ''))
      else entry.reject(new VoiceError('offline-failed', String(message.message ?? 'corrective pass failed')))
    }
  }

  #onFailure(error) {
    this.failure = error
    this.ready = false
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(error)
  }

  /** Load the corrective model; resolves once the worker reports ready. */
  prepare() {
    const worker = this.start()
    if (this.ready) return Promise.resolve()
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return new Promise((resolveReady, rejectReady) => {
      const id = 'prepare'
      this.pending.set(id, {
        resolve: () => resolveReady(),
        reject: (error) => rejectReady(error),
      })
      worker.postMessage({ type: 'prepare' })
    })
  }

  /**
   * Transcribe one complete utterance.
   * @param samples - 16 kHz mono float samples.
   * @returns the corrective transcript.
   */
  transcribe(samples) {
    const worker = this.start()
    this.sequence += 1
    const id = this.sequence
    return new Promise((resolveText, rejectText) => {
      this.pending.set(id, { resolve: resolveText, reject: rejectText })
      const copy = samples.slice()
      worker.postMessage({ type: 'transcribe', id, samples: copy }, [copy.buffer])
    })
  }

  async stop() {
    this.stopping = true
    const worker = this.worker
    this.worker = undefined
    this.ready = false
    if (worker === undefined) return
    try {
      await worker.terminate()
    } catch {
      /* the worker is already gone */
    }
  }
}

export function apply(ctx, config) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  const settings = config ?? {}
  const streamingEntry = STREAMING_MODELS[settings.streamingModel ?? 'zipformer-bilingual-zh-en']
  const offlineEntry = OFFLINE_MODELS[settings.offlineModel ?? 'sense-voice-zh-en-ja-ko-yue']
  if (streamingEntry === undefined || offlineEntry === undefined) {
    ctx.logger?.warn?.('voice-input: unknown model selection; plugin disabled')
    return
  }

  const modelRoot =
    typeof settings.modelRoot === 'string' && settings.modelRoot.trim().length > 0
      ? resolve(settings.modelRoot.trim())
      : join(dshHome(), ...DATA_DIR, 'models')
  const downloadBase = String(settings.downloadBase ?? 'https://huggingface.co').replace(/\/+$/, '')
  const streamingDir = join(modelRoot, streamingEntry.dir)
  const offlineDir = join(modelRoot, offlineEntry.dir)
  const maxRecordingSeconds = settings.maxRecordingSeconds ?? 300
  const maxSamples = maxRecordingSeconds * SAMPLE_RATE

  const require = createRequire(import.meta.url)
  const wss = new WebSocketServer({ noServer: true })
  const sessions = new Set()

  /** Shared recognition state: recognizers are built once and reused. */
  const engine = {
    sherpa: undefined,
    sherpaError: undefined,
    streaming: undefined,
    streamingError: undefined,
    offline: undefined,
    preparing: undefined,
  }

  function loadSherpa() {
    if (engine.sherpa !== undefined) return engine.sherpa
    try {
      engine.sherpa = require('sherpa-onnx-node')
      engine.sherpaError = undefined
    } catch (error) {
      engine.sherpaError = error
      throw new VoiceError(
        'dependency-missing',
        `sherpa-onnx-node is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return engine.sherpa
  }

  function streamingRecognizer() {
    if (engine.streaming !== undefined) return engine.streaming
    const sherpa = loadSherpa()
    if (engine.streamingError !== undefined) throw engine.streamingError
    try {
      engine.streaming = new sherpa.OnlineRecognizer({
        featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: join(streamingDir, streamingEntry.files.encoder),
            decoder: join(streamingDir, streamingEntry.files.decoder),
            joiner: join(streamingDir, streamingEntry.files.joiner),
          },
          tokens: join(streamingDir, streamingEntry.files.tokens),
          numThreads: settings.streamingThreads ?? 2,
          provider: 'cpu',
          debug: 0,
        },
        decodingMethod: 'greedy_search',
        enableEndpoint: true,
        rule1MinTrailingSilence: settings.trailingSilenceSeconds ?? 2.4,
        rule2MinTrailingSilence: 1.2,
        rule3MinUtteranceLength: 30,
      })
    } catch (error) {
      engine.streamingError = new VoiceError(
        'model-load-failed',
        `streaming model failed to load: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw engine.streamingError
    }
    return engine.streaming
  }

  function offlineWorker() {
    if (engine.offline === undefined) {
      engine.offline = new OfflineWorker({
        model: join(offlineDir, offlineEntry.files.model),
        tokens: join(offlineDir, offlineEntry.files.tokens),
        language: settings.language ?? 'auto',
        numThreads: settings.offlineThreads ?? 4,
      })
    }
    return engine.offline
  }

  // --- model provisioning ---------------------------------------------------

  function modelPaths(entry, dir) {
    return Object.values(entry.files).map((name) => ({
      name,
      path: join(dir, name),
    }))
  }

  async function missingFiles(entry, dir) {
    const missing = []
    for (const item of modelPaths(entry, dir)) {
      if (!(await exists(item.path))) missing.push(item.name)
    }
    return missing
  }

  async function downloadFile(url, destination, onBytes) {
    const response = await fetch(url, { redirect: 'follow' })
    if (!response.ok || response.body === null) {
      throw new VoiceError('download-failed', `${url} answered HTTP ${response.status}`)
    }
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
      throw new VoiceError('download-failed', `${url} is larger than the download cap`)
    }
    await mkdir(dirname(destination), { recursive: true })
    const temporary = `${destination}.part`
    const sink = createWriteStream(temporary)
    let received = 0
    try {
      for await (const chunk of Readable.fromWeb(response.body)) {
        received += chunk.length
        if (received > MAX_DOWNLOAD_BYTES) throw new VoiceError('download-failed', 'download exceeded the size cap')
        onBytes(received, declared)
        if (!sink.write(chunk)) await once(sink, 'drain')
      }
      await new Promise((resolveEnd, rejectEnd) => {
        sink.end((error) => (error === undefined || error === null ? resolveEnd() : rejectEnd(error)))
      })
    } catch (error) {
      sink.destroy()
      await unlink(temporary).catch(() => {})
      throw error
    }
    if (received === 0) {
      await unlink(temporary).catch(() => {})
      throw new VoiceError('download-failed', `${url} returned an empty body`)
    }
    await rename(temporary, destination)
    return received
  }

  /**
   * Ensure both models are present, downloading what is missing. Progress is
   * published to every connected browser so the button can show it.
   */
  function prepareModels() {
    if (engine.preparing !== undefined) return engine.preparing
    const plan = [
      { stage: 'streaming', entry: streamingEntry, dir: streamingDir },
      { stage: 'offline', entry: offlineEntry, dir: offlineDir },
    ]
    const progress = { active: true, stage: 'streaming', percent: 0, received: 0, total: 0, error: undefined }
    engine.preparingProgress = progress
    const work = (async () => {
      const planItems = []
      for (const item of plan) {
        for (const file of modelPaths(item.entry, item.dir)) {
          if (!(await exists(file.path))) {
            planItems.push({ stage: item.stage, repo: item.entry.repo, name: file.name, path: file.path })
          }
        }
      }
      const filesTotal = planItems.length
      let fileIndex = 0
      for (const item of planItems) {
        progress.stage = item.stage
        progress.percent = filesTotal === 0 ? 100 : Math.round((fileIndex / filesTotal) * 100)
        broadcastAll({ type: 'progress', ...progress })
        const url = `${downloadBase}/${item.repo}/resolve/main/${item.name}`
        await downloadFile(url, item.path, (received, declared) => {
          progress.received = received
          progress.total = declared
          const within = declared > 0 ? Math.min(1, received / declared) : 0
          progress.percent = Math.min(99, Math.round(((fileIndex + within) / Math.max(1, filesTotal)) * 100))
          broadcastAll({ type: 'progress', ...progress })
        })
        fileIndex += 1
        progress.percent = filesTotal === 0 ? 100 : Math.round((fileIndex / filesTotal) * 100)
        broadcastAll({ type: 'progress', ...progress })
      }
      // Load both engines now so the first recording has no cold-start stall.
      streamingRecognizer()
      await offlineWorker().prepare()
      progress.active = false
      progress.percent = 100
      broadcastAll({ type: 'ready', models: await readiness() })
      return progress
    })()
    engine.preparing = work
    work.catch((error) => {
      progress.active = false
      progress.error = error instanceof Error ? error.message : String(error)
      broadcastAll({ type: 'error', code: 'prepare-failed', message: progress.error })
    }).finally(() => {
      engine.preparing = undefined
    })
    return work
  }

  async function readiness() {
    const streamingMissing = await missingFiles(streamingEntry, streamingDir)
    const offlineMissing = await missingFiles(offlineEntry, offlineDir)
    return {
      streaming: streamingMissing.length === 0,
      offline: offlineMissing.length === 0,
      streamingMissing,
      offlineMissing,
    }
  }

  async function statusSnapshot() {
    let sherpaOnnx = true
    let sherpaError
    try {
      loadSherpa()
    } catch (error) {
      sherpaOnnx = false
      sherpaError = error instanceof Error ? error.message : String(error)
    }
    const models = await readiness()
    return {
      ok: true,
      sampleRate: SAMPLE_RATE,
      sherpaOnnx,
      ...(sherpaError === undefined ? {} : { sherpaError }),
      models,
      ready: sherpaOnnx && models.streaming && models.offline,
      preparing: engine.preparingProgress?.active === true ? { ...engine.preparingProgress } : null,
      config: {
        modelRoot,
        streamingModel: settings.streamingModel ?? 'zipformer-bilingual-zh-en',
        offlineModel: settings.offlineModel ?? 'sense-voice-zh-en-ja-ko-yue',
        language: settings.language ?? 'auto',
        autoDownload: settings.autoDownload !== false,
        maxRecordingSeconds,
      },
    }
  }

  // --- recognition sessions -------------------------------------------------

  function broadcastAll(message) {
    for (const session of sessions) session.send(message)
  }

  /**
   * One browser socket: a realtime stream, the retained PCM of the utterance,
   * and the corrective pass that runs when the browser stops recording.
   */
  function createSession(socket) {
    const session = {
      socket,
      recognizer: undefined,
      stream: undefined,
      chunks: [],
      sampleCount: 0,
      committed: '',
      partial: '',
      lastSent: undefined,
      decoding: false,
      running: false,
      capped: false,
      closed: false,
      send(message) {
        if (socket.readyState !== WebSocket.OPEN) return
        try {
          socket.send(JSON.stringify(message))
        } catch {
          /* the socket went away between the check and the write */
        }
      },
      fail(code, message) {
        this.send({ type: 'error', code, message })
      },
      reset() {
        this.chunks = []
        this.sampleCount = 0
        this.committed = ''
        this.partial = ''
        this.lastSent = undefined
        this.capped = false
        if (this.recognizer !== undefined && this.stream !== undefined) {
          try {
            this.recognizer.reset(this.stream)
          } catch {
            /* a fresh stream is created on the next start anyway */
          }
        }
        this.stream = undefined
      },
      release() {
        this.closed = true
        this.reset()
        this.recognizer = undefined
      },
    }

    session.start = () => {
      session.reset()
      try {
        session.recognizer = streamingRecognizer()
      } catch (error) {
        session.fail(error.code ?? 'model-load-failed', error.message ?? String(error))
        return
      }
      session.stream = session.recognizer.createStream()
      session.running = true
    }

    const publishPartial = () => {
      const full = `${session.committed}${session.partial}`
      // An empty hypothesis is not news: publishing it would only make the
      // browser rewrite the composer draft before the first word exists.
      if (full === '' || full === session.lastSent) return
      session.lastSent = full
      session.send({ type: 'partial', text: full })
    }

    /** Feed one PCM frame through the realtime recognizer. */
    session.push = (buffer) => {
      if (!session.running || session.stream === undefined || session.recognizer === undefined) return
      if (session.sampleCount >= maxSamples) {
        if (!session.capped) {
          session.capped = true
          session.send({ type: 'capped', seconds: maxRecordingSeconds })
          void session.finish(true)
        }
        return
      }
      const samples = pcm16ToFloat32(buffer)
      session.chunks.push(samples)
      session.sampleCount += samples.length
      try {
        session.stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
        while (session.recognizer.isReady(session.stream)) session.recognizer.decode(session.stream)
        const text = session.recognizer.getResult(session.stream).text ?? ''
        if (session.recognizer.isEndpoint(session.stream)) {
          session.committed += text
          session.partial = ''
          session.recognizer.reset(session.stream)
        } else {
          session.partial = text
        }
      } catch (error) {
        session.fail('decode-failed', error instanceof Error ? error.message : String(error))
        session.running = false
        return
      }
      publishPartial()
    }

    /** Drain the realtime stream, then run the corrective pass over the whole utterance. */
    session.finish = async (auto = false) => {
      if (session.decoding) return
      session.decoding = true
      session.running = false
      let streamingText = `${session.committed}${session.partial}`
      if (session.stream !== undefined && session.recognizer !== undefined) {
        try {
          session.stream.inputFinished()
          while (session.recognizer.isReady(session.stream)) session.recognizer.decode(session.stream)
          const tail = session.recognizer.getResult(session.stream).text ?? ''
          streamingText = `${session.committed}${tail}`
        } catch {
          /* keep the last published hypothesis */
        }
      }
      streamingText = streamingText.trim()

      const total = session.sampleCount
      const samples = total === 0 ? new Float32Array(0) : concatFloat32(session.chunks, total)
      session.chunks = []
      session.sampleCount = 0
      session.stream = undefined

      let text = streamingText
      let engine_ = 'streaming'
      if (samples.length > 0) {
        try {
          const corrected = (await offlineWorker().transcribe(samples)).trim()
          if (corrected.length > 0) {
            text = corrected
            engine_ = 'offline'
          }
        } catch (error) {
          session.fail('offline-failed', error instanceof Error ? error.message : String(error))
        }
      }
      if (!session.closed) session.send({ type: 'final', text, engine: engine_, auto })
      session.decoding = false
    }

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        session.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
        return
      }
      let message
      try {
        message = JSON.parse(data.toString())
      } catch {
        session.fail('bad-request', 'control frame must be JSON')
        return
      }
      if (message === null || typeof message !== 'object') return
      switch (message.type) {
        case 'start': {
          session.start()
          if (session.running) session.send({ type: 'started', sampleRate: SAMPLE_RATE })
          return
        }
        case 'stop': {
          void session.finish(false)
          return
        }
        case 'cancel': {
          session.reset()
          session.running = false
          return
        }
        default:
          return
      }
    })
    socket.on('close', () => {
      sessions.delete(session)
      session.release()
    })
    socket.on('error', () => {
      sessions.delete(session)
      session.release()
    })
    return session
  }

  // --- routes ---------------------------------------------------------------

  const route = (path, handler) => {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path,
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: 'method not allowed' })
              return
            }
            try {
              const args = await readJson(req)
              const result = await handler(args)
              sendJson(res, 200, { ok: true, ...result })
            } catch (error) {
              sendJson(res, 200, {
                ok: false,
                code: error instanceof VoiceError ? error.code : 'internal',
                error: error instanceof Error ? error.message : String(error),
              })
            }
          },
        }),
      `voice-input route ${path}`,
    )
  }

  route(`${API_PREFIX}/status`, async () => ({ status: await statusSnapshot() }))

  route(`${API_PREFIX}/prepare`, async () => {
    if (settings.autoDownload === false) {
      throw new VoiceError('download-disabled', 'model download is disabled by configuration')
    }
    void prepareModels()
    return { preparing: true }
  })

  ctx.effect(
    () =>
      webServer.registerUpgrade({
        path: WS_PATH,
        handler: (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (websocket) => {
            const session = createSession(websocket)
            sessions.add(session)
            // Answer readiness before any control frame the browser may send,
            // so a client that starts streaming immediately is never guessing.
            void readiness().then((models) => {
              session.send({
                type: 'hello',
                sampleRate: SAMPLE_RATE,
                models,
                preparing: engine.preparingProgress?.active === true ? { ...engine.preparingProgress } : null,
              })
            })
          })
        },
      }),
    `voice-input WebSocket ${WS_PATH}`,
  )

  ctx.effect(
    () => () => {
      for (const session of sessions) {
        session.release()
      }
      sessions.clear()
      void new Promise((resolveClose) => wss.close(() => resolveClose()))
      void engine.offline?.stop()
      engine.offline = undefined
    },
    'voice-input session cleanup',
  )

  ctx.logger?.info?.('voice-input ready: models live under %s', modelRoot)
}
