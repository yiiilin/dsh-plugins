import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_DTYPE,
  DEFAULT_MODEL,
  EMBEDDING_DIMS,
  createEmbedder,
} from '../lib/embedding.js'

const DIMS = 4
const tensor = (rows) => ({ dims: [rows.length, rows[0]?.length ?? 0], tolist: () => rows })
const vectors = (texts) => tensor(texts.map((text) => [text.length, 0, 0, 0]))

const fake = (handler) => {
  const calls = []
  return {
    calls,
    loadPipeline: async () => async (texts, options) => {
      calls.push({ texts, options })
      return handler(texts, options, calls.length)
    },
  }
}

test('exposes the frozen 512-dim contract by default', () => {
  const embedder = createEmbedder()
  assert.equal(embedder.dims, EMBEDDING_DIMS)
  assert.equal(embedder.dims, 512)
  assert.equal(typeof embedder.embed, 'function')
  assert.equal(typeof embedder.close, 'function')
  assert.equal(DEFAULT_MODEL, 'onnx-community/bge-small-zh-v1.5-ONNX')
  assert.equal(DEFAULT_DTYPE, 'q8')
  assert.equal(DEFAULT_BATCH_SIZE, 8)
})

test('rejects invalid batchSize and dims', () => {
  assert.throws(() => createEmbedder({ batchSize: 0 }), TypeError)
  assert.throws(() => createEmbedder({ batchSize: 2.5 }), TypeError)
  assert.throws(() => createEmbedder({ dims: 0 }), TypeError)
  assert.equal(createEmbedder({ batchSize: 1 }).dims, 512)
})

test('refuses a relative cacheDir so the ONNX cache cannot land in cwd', () => {
  assert.throws(() => createEmbedder({ cacheDir: 'work-journal/embed' }), /absolute/u)
  assert.doesNotThrow(() => createEmbedder({ cacheDir: '/tmp/wj-embed-cache' }))
})

test('loads the pipeline lazily and only once', async () => {
  let loads = 0
  const embedder = createEmbedder({
    dims: DIMS,
    loadPipeline: async () => {
      loads += 1
      return async (texts) => vectors(texts)
    },
  })
  assert.equal(loads, 0, 'createEmbedder must not load the model')
  await embedder.embed(['第一段'])
  assert.equal(loads, 1)
  await embedder.embed(['第二段'])
  assert.equal(loads, 1, 'the pipeline must be reused across calls')
})

test('splits work into the default batches of 8', async () => {
  const probe = fake((texts) => vectors(texts))
  const embedder = createEmbedder({ dims: DIMS, loadPipeline: probe.loadPipeline })
  const texts = Array.from({ length: 20 }, (_, index) => `t${index}`)
  const result = await embedder.embed(texts)
  assert.deepEqual(
    probe.calls.map((call) => call.texts.length),
    [8, 8, 4],
  )
  assert.equal(result.length, 20)
  assert.ok(result.every((vector) => vector instanceof Float32Array))
})

test('honours a custom batch size and asks for mean pooling + normalization', async () => {
  const probe = fake((texts) => vectors(texts))
  const embedder = createEmbedder({ dims: DIMS, batchSize: 3, loadPipeline: probe.loadPipeline })
  const result = await embedder.embed(Array.from({ length: 7 }, (_, index) => `t${index}`))
  assert.deepEqual(
    probe.calls.map((call) => call.texts.length),
    [3, 3, 1],
  )
  assert.equal(result.length, 7)
  for (const call of probe.calls) assert.deepEqual(call.options, { pooling: 'mean', normalize: true })
})

test('keeps input order and returns null for missing or blank texts', async () => {
  const probe = fake((texts) => vectors(texts))
  const embedder = createEmbedder({ dims: DIMS, loadPipeline: probe.loadPipeline })
  const result = await embedder.embed(['第一段', '', '   ', '第四段'])
  assert.deepEqual(
    result.map((vector) => (vector ? vector[0] : null)),
    [3, null, null, 3],
  )
  // Blank entries must not reach the tokenizer at all.
  assert.deepEqual(probe.calls[0].texts, ['第一段', '第四段'])
})

test('isolates a failing batch and still runs the remaining batches', async () => {
  const probe = fake((texts, _options, call) => {
    if (call === 2) throw new Error('onnx exploded')
    return vectors(texts)
  })
  const embedder = createEmbedder({ dims: DIMS, loadPipeline: probe.loadPipeline })
  const result = await embedder.embed(Array.from({ length: 20 }, (_, index) => `t${index}`))
  assert.equal(probe.calls.length, 3, 'the batch after the failure must still run')
  assert.ok(result.slice(0, 8).every(Boolean))
  assert.deepEqual(result.slice(8, 16), new Array(8).fill(null))
  assert.ok(result.slice(16).every(Boolean))
})

test('drops rows whose width does not match dims', async () => {
  const probe = fake((texts) => tensor(texts.map((text, index) => (index === 0 ? [1, 2, 3] : [text.length, 0, 0, 0]))))
  const embedder = createEmbedder({ dims: DIMS, loadPipeline: probe.loadPipeline })
  const result = await embedder.embed(['坏行', '好行'])
  assert.equal(result[0], null)
  assert.equal(result[1][0], 2)
})

test('accepts a flat single-text tensor', async () => {
  const probe = fake(() => ({ dims: [DIMS], tolist: () => [5, 0, 0, 0] }))
  const embedder = createEmbedder({ dims: DIMS, loadPipeline: probe.loadPipeline })
  const [vector] = await embedder.embed(['x'])
  assert.ok(vector instanceof Float32Array)
  assert.deepEqual([...vector], [5, 0, 0, 0])
})

test('returns an empty array for empty input without loading the model', async () => {
  let loads = 0
  const embedder = createEmbedder({
    dims: DIMS,
    loadPipeline: async () => {
      loads += 1
      return async () => tensor([])
    },
  })
  assert.deepEqual(await embedder.embed([]), [])
  assert.equal(loads, 0)
})

test('rejects a non-array input', async () => {
  const probe = fake((texts) => vectors(texts))
  const embedder = createEmbedder({ dims: DIMS, loadPipeline: probe.loadPipeline })
  await assert.rejects(embedder.embed('不是数组'), TypeError)
})

test('serializes concurrent embeds so only one batch is in flight', async () => {
  let inFlight = 0
  let peak = 0
  const probe = fake(async (texts) => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 5))
    inFlight -= 1
    return vectors(texts)
  })
  const embedder = createEmbedder({ dims: DIMS, loadPipeline: probe.loadPipeline })
  const [first, second] = await Promise.all([embedder.embed(['aa']), embedder.embed(['bb'])])
  assert.equal(peak, 1, 'concurrent batches would double the ONNX peak memory')
  assert.equal(first[0][0], 2)
  assert.equal(second[0][0], 2)
})

test('aborts before the first batch without loading the model', async () => {
  let loads = 0
  const embedder = createEmbedder({
    dims: DIMS,
    loadPipeline: async () => {
      loads += 1
      return async () => tensor([])
    },
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(embedder.embed(['x'], controller.signal), (error) => error.name === 'AbortError')
  assert.equal(loads, 0)
})

test('abort during an in-flight batch rejects and stops later batches', async () => {
  const controller = new AbortController()
  const probe = fake((texts) => {
    controller.abort()
    return vectors(texts)
  })
  const embedder = createEmbedder({ dims: DIMS, loadPipeline: probe.loadPipeline })
  const texts = Array.from({ length: 16 }, (_, index) => `t${index}`)
  await assert.rejects(embedder.embed(texts, controller.signal), (error) => error.name === 'AbortError')
  assert.equal(probe.calls.length, 1)
})

test('close disposes a loaded pipeline once and is idempotent', async () => {
  let disposed = 0
  const embedder = createEmbedder({
    dims: DIMS,
    loadPipeline: async () => {
      const extractor = async (texts) => vectors(texts)
      extractor.dispose = async () => {
        disposed += 1
      }
      return extractor
    },
  })
  await embedder.embed(['一'])
  await embedder.close()
  await embedder.close()
  assert.equal(disposed, 1)
  await assert.rejects(embedder.embed(['二']), /closed/u)
})

test('close before the first load never loads the model', async () => {
  let loads = 0
  const embedder = createEmbedder({
    dims: DIMS,
    loadPipeline: async () => {
      loads += 1
      return async () => tensor([])
    },
  })
  await embedder.close()
  assert.equal(loads, 0)
  await assert.rejects(embedder.embed(['一']), /closed/u)
})

test('a failed model load is retried on the next call', async () => {
  let loads = 0
  const embedder = createEmbedder({
    dims: DIMS,
    loadPipeline: async () => {
      loads += 1
      if (loads === 1) throw new Error('模型加载失败')
      return async (texts) => vectors(texts)
    },
  })
  await assert.rejects(embedder.embed(['一']), /模型加载失败/u)
  const [vector] = await embedder.embed(['一'])
  assert.equal(vector[0], 1)
  assert.equal(loads, 2)
})

// The model-grade checks are opt-in: point WJ_EMBED_TEST_CACHE at a Hugging
// Face cache holding the model so CI never needs the network or 25 MB of ONNX.
const MODEL_REPO = 'onnx-community/bge-small-zh-v1.5-ONNX'
const modelCache = process.env.WJ_EMBED_TEST_CACHE
const hasLocalModel = Boolean(modelCache) && existsSync(join(modelCache, MODEL_REPO))

const loadRealModel = async () => {
  if (!hasLocalModel) {
    return { skip: 'set WJ_EMBED_TEST_CACHE to a cache dir containing onnx-community/bge-small-zh-v1.5-ONNX' }
  }
  try {
    await import('@huggingface/transformers')
    return { skip: false }
  } catch {
    return { skip: '@huggingface/transformers is not installed' }
  }
}
const modelCase = await loadRealModel()

test('embeds real Chinese text into normalized 512-dim vectors', { skip: modelCase.skip }, async () => {
  const embedder = createEmbedder({ cacheDir: modelCache })
  try {
    const [vector] = await embedder.embed(['今天修复了 work-journal 的分批逻辑'])
    assert.ok(vector instanceof Float32Array)
    assert.equal(vector.length, 512)
    assert.equal(embedder.dims, 512)
    const norm = Math.sqrt([...vector].reduce((sum, value) => sum + value * value, 0))
    assert.ok(Math.abs(norm - 1) < 1e-3, `expected a unit vector, got norm ${norm}`)
    assert.ok([...vector].some((value) => value !== 0))
  } finally {
    await embedder.close()
  }
})

test('ranks a related Chinese sentence above an unrelated one', { skip: modelCase.skip }, async () => {
  const embedder = createEmbedder({ cacheDir: modelCache })
  const cosine = (a, b) => [...a].reduce((sum, value, index) => sum + value * b[index], 0)
  try {
    const [query, related, unrelated] = await embedder.embed([
      '修复 embedding 分批导致的内存溢出',
      '把 embedding 推理按 batch 拆小，避免 OOM',
      '今天中午吃了番茄鸡蛋面',
    ])
    assert.ok(cosine(query, related) > cosine(query, unrelated))
  } finally {
    await embedder.close()
  }
})
