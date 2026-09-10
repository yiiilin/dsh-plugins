/**
 * dsh-plugin-voice-input — corrective (non-realtime) recognizer worker.
 *
 * The offline model is the expensive half of the two-pass design: it decodes a
 * complete utterance at once and is what replaces the realtime hypothesis. It
 * runs here, on its own thread, so a multi-second decode can never stall the
 * daemon's event loop or the composer UI.
 *
 * The worker loads the model once, keeps it warm, and answers one request at a
 * time over the parent port:
 *
 *   {type:'prepare'}                     → {type:'ready'}
 *   {type:'transcribe', id, samples}     → {type:'result', id, ok, text|message}
 */

import { createRequire } from 'node:module'
import { parentPort, workerData } from 'node:worker_threads'

const require = createRequire(import.meta.url)

const sampleRate = Number(workerData?.sampleRate ?? 16000)
const options = {
  model: String(workerData?.model ?? ''),
  tokens: String(workerData?.tokens ?? ''),
  language: String(workerData?.language ?? 'auto'),
  numThreads: Number(workerData?.numThreads ?? 4),
}

const post = (message) => {
  try {
    parentPort?.postMessage(message)
  } catch {
    /* the parent is gone; nothing left to report to */
  }
}

let recognizer
let loadError

function load() {
  if (recognizer !== undefined) return recognizer
  if (loadError !== undefined) throw loadError
  try {
    const sherpa = require('sherpa-onnx-node')
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate, featureDim: 80 },
      modelConfig: {
        senseVoice: {
          model: options.model,
          language: options.language,
          useInverseTextNormalization: 1,
        },
        tokens: options.tokens,
        numThreads: options.numThreads,
        provider: 'cpu',
        debug: 0,
      },
    })
  } catch (error) {
    loadError = error instanceof Error ? error : new Error(String(error))
    throw loadError
  }
  return recognizer
}

function transcribe(samples) {
  const engine = load()
  const stream = engine.createStream()
  stream.acceptWaveform({ samples, sampleRate })
  engine.decode(stream)
  const result = engine.getResult(stream)
  return typeof result?.text === 'string' ? result.text : ''
}

parentPort?.on('message', (message) => {
  if (message === null || typeof message !== 'object') return
  if (message.type === 'prepare') {
    try {
      load()
      post({ type: 'ready' })
    } catch (error) {
      post({ type: 'failed', message: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (message.type === 'transcribe') {
    const id = message.id
    try {
      post({ type: 'result', id, ok: true, text: transcribe(message.samples) })
    } catch (error) {
      post({
        type: 'result',
        id,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
})
