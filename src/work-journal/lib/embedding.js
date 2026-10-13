/**
 * Local embedding service for the work-journal index (T5).
 *
 * Model: `onnx-community/bge-small-zh-v1.5-ONNX`, dtype `q8`, 512 dims.
 * Frozen contract: /tmp/wj-team/INTERFACE.md
 *
 *   createEmbedder({ cacheDir, model, dtype }) -> {
 *     embed(texts, signal?): Promise<Array<Float32Array | null>>,
 *     dims: 512,
 *     close(): Promise<void>,
 *   }
 *
 * Memory contract: inference is batched (default 8). ONNX activation memory
 * scales with batch size, and a single 120-text batch has already OOM-killed
 * the host once — do not raise `batchSize` casually. Concurrent `embed()`
 * calls are serialized for the same reason: two batches in flight would
 * double the peak.
 *
 * Failure contract:
 *   - `texts[i]` that is missing/empty yields `null` at the same index;
 *   - a batch that throws yields `null` placeholders and the remaining batches
 *     still run, so one bad text cannot lose the caller's whole input;
 *   - an aborted signal throws an `AbortError` (checked before each batch; an
 *     in-flight batch still finishes, ONNX inference is not cancellable);
 *   - an unusable model (dependency missing, load failure) throws — there is
 *     nothing to degrade to, so the caller decides to fall back to keyword
 *     search and should never cache that failure as a permanent state.
 */

import { isAbsolute } from 'node:path'

export const DEFAULT_MODEL = 'onnx-community/bge-small-zh-v1.5-ONNX'
export const DEFAULT_DTYPE = 'q8'
export const EMBEDDING_DIMS = 512
export const DEFAULT_BATCH_SIZE = 8

const abortError = (signal) => {
  const reason = signal?.reason
  return reason instanceof Error ? reason : new DOMException('The operation was aborted', 'AbortError')
}

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw abortError(signal)
}

// A single-text batch may come back flat (`[dims]`) instead of `[1][dims]`.
const rowsOf = (output, expected) => {
  if (!output || typeof output.tolist !== 'function') return null
  const rows = output.tolist()
  if (!Array.isArray(rows)) return null
  if (expected === 1 && typeof rows[0] === 'number') return [rows]
  return rows.length === expected ? rows : null
}

export function createEmbedder(options = {}) {
  const {
    cacheDir,
    model = DEFAULT_MODEL,
    dtype = DEFAULT_DTYPE,
    batchSize = DEFAULT_BATCH_SIZE,
    dims = EMBEDDING_DIMS,
    allowRemoteModels = true,
    // Test/advanced seam: bypass the HF loader with any
    // `(texts, opts) -> Tensor-like` extractor factory.
    loadPipeline,
  } = options

  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new TypeError(`batchSize must be a positive integer, got ${batchSize}`)
  }
  if (!Number.isInteger(dims) || dims < 1) {
    throw new TypeError(`dims must be a positive integer, got ${dims}`)
  }
  // A relative cacheDir would silently drop ~25 MB of ONNX into the process cwd.
  if (cacheDir !== undefined && !isAbsolute(cacheDir)) {
    throw new TypeError(`cacheDir must be an absolute path, got ${cacheDir}`)
  }

  let extractorPromise = null
  let closed = false
  let queue = Promise.resolve()

  const loadExtractor = async () => {
    if (typeof loadPipeline === 'function') return loadPipeline()
    const { pipeline, env } = await import('@huggingface/transformers')
    if (cacheDir) env.cacheDir = cacheDir
    env.allowRemoteModels = allowRemoteModels
    return pipeline('feature-extraction', model, { dtype })
  }

  // Lazy: `createEmbedder` must stay cheap, the ONNX session loads on first use.
  const getExtractor = () => {
    if (!extractorPromise) {
      extractorPromise = Promise.resolve()
        .then(loadExtractor)
        .catch((error) => {
          extractorPromise = null // a failed load must not be cached forever
          throw error
        })
    }
    return extractorPromise
  }

  const run = async (texts, signal) => {
    const out = new Array(texts.length).fill(null)
    if (texts.length === 0) return out
    throwIfAborted(signal)

    const pending = []
    for (let index = 0; index < texts.length; index += 1) {
      const text = texts[index]
      if (typeof text === 'string' && text.trim() !== '') pending.push(index)
    }
    if (pending.length === 0) return out

    const extractor = await getExtractor()
    throwIfAborted(signal)

    for (let start = 0; start < pending.length; start += batchSize) {
      throwIfAborted(signal)
      const batch = pending.slice(start, start + batchSize)
      let output
      try {
        output = await extractor(batch.map((index) => texts[index]), { pooling: 'mean', normalize: true })
      } catch (error) {
        if (signal?.aborted) throw abortError(signal)
        continue // leave this batch's nulls in place, keep the remaining batches
      }
      const rows = rowsOf(output, batch.length)
      if (!rows) continue
      for (let offset = 0; offset < batch.length; offset += 1) {
        const row = rows[offset]
        if (!Array.isArray(row) || row.length !== dims) continue
        out[batch[offset]] = Float32Array.from(row)
      }
    }
    return out
  }

  return {
    dims,
    embed(texts, signal) {
      if (closed) return Promise.reject(new Error('embedder is closed'))
      if (!Array.isArray(texts)) return Promise.reject(new TypeError('texts must be an array'))
      const task = queue.then(() => run(texts, signal))
      queue = task.then(
        () => undefined,
        () => undefined,
      )
      return task
    },
    async close() {
      closed = true
      const pending = extractorPromise
      extractorPromise = null
      if (!pending) return
      try {
        const extractor = await pending
        if (extractor && typeof extractor.dispose === 'function') await extractor.dispose()
      } catch {
        // Best effort: closing must never throw in a plugin teardown path.
      }
    },
  }
}
