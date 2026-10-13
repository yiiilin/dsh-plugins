import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { openReportStore } from '../lib/report-store.js'

/**
 * A scratch store rooted in a fresh temp directory.
 *
 * Every test passes an absolute `index.sqlite` path and never touches
 * `DSH_HOME`, so the suite cannot reach a real deployment's data.
 */
async function scratch(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wj-report-store-'))
  const store = openReportStore(join(dir, 'index.sqlite'), options)
  return {
    dir,
    store,
    async cleanup() {
      await store.close()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** Metadata for a `day` report, matching the frozen JSON shape. */
function meta(key, overrides = {}) {
  // A week key (`2026-W41`) is not a date, so the span must be supplied for it.
  const start = overrides.startTime ?? Date.parse(`${key}T00:00:00Z`)
  return {
    version: 1,
    key,
    kind: 'day',
    label: key,
    startTime: start,
    endTime: overrides.endTime ?? start + 86399999,
    generatedAt: start + 86400000,
    model: { provider: 'sub2api-gpt', model: 'deepseek-flash' },
    status: 'ok',
    sessionCount: 1,
    error: null,
    ...overrides,
  }
}

/**
 * A 512-dimension unit vector at `angle` in the first two coordinates.
 *
 * Two vectors are then exactly `angle` radians apart, which makes a cosine
 * assertion readable instead of dependent on an opaque fixture.
 */
function unit(angle) {
  const vector = new Float32Array(512)
  vector[0] = Math.cos(angle)
  vector[1] = Math.sin(angle)
  return vector
}

/** An embedder backed by a `text -> Float32Array` table. */
function tableEmbedder(table) {
  return async (texts) => texts.map((text) => {
    const vector = table[text]
    if (vector === undefined) throw new Error(`no fixture vector for ${text}`)
    return vector
  })
}

/** List every path under `dir`, relative and slash-separated. */
async function tree(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1)).sort()
}

test('creates the frozen schema, including the trigram FTS and vec0 tables', async () => {
  const context = await scratch()
  try {
    const { store } = context
    await store.upsert(meta('2026-10-12'), '# 2026-10-12\n\n今天修存储层\n')
    // Inspect the file directly: the schema contract belongs to the database,
    // not to whatever read path the store happens to expose.
    const path = join(context.dir, 'index.sqlite')
    await store.close()
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      const names = db.prepare("SELECT name, type FROM sqlite_master WHERE name IN ('reports','reports_fts','reports_vec','idx_reports_time') ORDER BY name").all()
      assert.deepEqual(
        names.map((row) => [row.name, row.type]),
        [['idx_reports_time', 'index'], ['reports', 'table'], ['reports_fts', 'table'], ['reports_vec', 'table']],
      )
      const columns = db.prepare('PRAGMA table_info(reports)').all().map((row) => row.name)
      assert.deepEqual(columns, [
        'key', 'kind', 'label', 'start_time', 'end_time', 'generated_at',
        'status', 'model_provider', 'model_name', 'session_count', 'body',
      ])
      // The trigram tokenizer is the whole reason Chinese keyword search works.
      const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'reports_fts'").get().sql
      assert.match(ddl, /tokenize\s*=\s*'trigram'/u)
    } finally {
      db.close()
    }
  } finally {
    await context.cleanup()
  }
})

test('rejects metadata that would escape the reports tree or break an enum', async () => {
  const context = await scratch()
  try {
    const { store } = context
    await assert.rejects(store.upsert(meta('../escape'), 'body'), /invalid report key/u)
    await assert.rejects(store.upsert(meta('.hidden'), 'body'), /invalid report key/u)
    await assert.rejects(store.upsert(meta('a/b'), 'body'), /invalid report key/u)
    await assert.rejects(store.upsert(meta('2026-10-12', { kind: 'year' }), 'body'), /unknown report kind/u)
    await assert.rejects(store.upsert(meta('2026-10-12', { status: 'done' }), 'body'), /unknown report status/u)
    await assert.rejects(store.upsert(meta('2026-10-12', { startTime: 1.5 }), 'body'), /startTime must be an integer/u)
    await assert.rejects(store.upsert(meta('2026-10-12', { version: 2 }), 'body'), /unsupported report metadata version/u)
    // A rejected write leaves nothing behind: no row, no report file. The
    // index file itself (and its WAL sidecars) exist because the store is open.
    assert.deepEqual(await store.list(), [])
    assert.deepEqual(await tree(context.dir), ['index.sqlite', 'index.sqlite-shm', 'index.sqlite-wal'])
    assert.ok(!existsSync(join(context.dir, 'reports')))
  } finally {
    await context.cleanup()
  }
})

test('upserts files and index, then lists newest-first', async () => {
  const context = await scratch()
  try {
    const { store } = context
    await store.upsert(meta('2026-10-12', { sessionCount: 3 }), '# 12 号\n')
    await store.upsert(meta('2026-10-14', { sessionCount: 7, kind: 'day' }), '# 14 号\n')
    await store.upsert(meta('2026-10-13'), '# 13 号\n')
    await store.upsert(
      meta('2026-W41', {
        kind: 'week',
        label: '2026 第 41 周',
        // The week starts before the days it contains, which is what pins the
        // `start_time DESC` order below.
        startTime: Date.parse('2026-10-05T00:00:00Z'),
      }),
      '# 第 41 周\n',
    )

    const all = await store.list()
    assert.deepEqual(all.map((entry) => entry.key), ['2026-10-14', '2026-10-13', '2026-10-12', '2026-W41'])
    // The interface's `list` order is `start_time DESC`, and the week starts
    // before the days it contains.
    assert.ok(all.every((entry) => entry.version === 1 && entry.status === 'ok' && entry.error === null))
    assert.equal(all[0].sessionCount, 7)
    assert.deepEqual(all[0].model, { provider: 'sub2api-gpt', model: 'deepseek-flash' })

    assert.deepEqual((await store.list({ kind: 'day' })).map((entry) => entry.key), ['2026-10-14', '2026-10-13', '2026-10-12'])
    assert.deepEqual((await store.list({ kind: 'week' })).map((entry) => entry.key), ['2026-W41'])
    assert.deepEqual((await store.list({ limit: 2 }).then((rows) => rows.map((row) => row.key))), ['2026-10-14', '2026-10-13'])
    assert.deepEqual((await store.list({ offset: 3 }).then((rows) => rows.map((row) => row.key))), ['2026-W41'])
    await assert.rejects(store.list({ kind: 'year' }), /unknown report kind/u)

    // The two files are laid out exactly as the interface documents.
    const files = await tree(join(context.dir, 'reports'))
    assert.deepEqual(files, [
      'day/2026-10-12.json', 'day/2026-10-12.md',
      'day/2026-10-13.json', 'day/2026-10-13.md',
      'day/2026-10-14.json', 'day/2026-10-14.md',
      'week/2026-W41.json', 'week/2026-W41.md',
    ])
    assert.equal(await readFile(join(context.dir, 'reports/day/2026-10-14.md'), 'utf8'), '# 14 号\n')
    assert.deepEqual(JSON.parse(await readFile(join(context.dir, 'reports/day/2026-10-14.json'), 'utf8')), meta('2026-10-14', { sessionCount: 7 }))
  } finally {
    await context.cleanup()
  }
})

test('upsert replaces an existing report instead of duplicating it', async () => {
  const context = await scratch()
  try {
    const { store } = context
    await store.upsert(meta('2026-10-12', { sessionCount: 1 }), '旧正文 存储层\n')
    await store.upsert(meta('2026-10-12', { sessionCount: 9, label: '重跑' }), '新正文 存储层\n')
    const rows = await store.list()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sessionCount, 9)
    assert.equal(rows[0].label, '重跑')
    const found = await store.get('2026-10-12')
    assert.equal(found.body, '新正文 存储层\n')
    // The FTS row must be replaced too, or a search would match stale prose.
    assert.deepEqual((await store.search('旧正文', { mode: 'keyword' })).map((hit) => hit.key), [])
    assert.deepEqual((await store.search('新正文', { mode: 'keyword' })).map((hit) => hit.key), ['2026-10-12'])
  } finally {
    await context.cleanup()
  }
})

test('get returns the metadata and body, and nothing for an unknown key', async () => {
  const context = await scratch()
  try {
    const { store } = context
    await store.upsert(meta('2026-10-12'), '# 正文\n\n内容\n')
    const found = await store.get('2026-10-12')
    assert.equal(found.body, '# 正文\n\n内容\n')
    assert.deepEqual(found.meta, meta('2026-10-12'))
    assert.equal(await store.get('2026-01-01'), undefined)
    // A traversal-shaped key is refused rather than read off disk.
    assert.equal(await store.get('../../etc/passwd'), undefined)
  } finally {
    await context.cleanup()
  }
})

test('records a failure, keeps the previous body, and surfaces the reason', async () => {
  const context = await scratch()
  try {
    const { store } = context
    await store.upsert(meta('2026-10-12'), '# 好报告\n')
    // A re-run that failed must not blank the report a reader already has.
    await store.upsert(
      meta('2026-10-12', { status: 'failed', error: 'model timed out', sessionCount: 0 }),
      '',
    )
    const failed = await store.get('2026-10-12')
    assert.equal(failed.meta.status, 'failed')
    assert.equal(failed.meta.error, 'model timed out')
    // The reason lives in the metadata file, because the frozen `reports`
    // table has no error column.
    assert.equal(JSON.parse(await readFile(join(context.dir, 'reports/day/2026-10-12.json'), 'utf8')).error, 'model timed out')
    const onDisk = await readFile(join(context.dir, 'reports/day/2026-10-12.md'), 'utf8')
    assert.equal(onDisk, '# 好报告\n')
    // The row must agree with the file: a `get` that returns a different body
    // than the Markdown on disk is worse than either answer alone.
    assert.equal(failed.body, onDisk)
    // The preserved body stays searchable, because it is still the report.
    assert.deepEqual((await store.search('好报告', { mode: 'keyword' })).map((hit) => hit.key), ['2026-10-12'])
    // The failure is visible through `list` too, which is what the panel reads.
    const [listed] = await store.list()
    assert.equal(listed.status, 'failed')
    assert.equal(listed.error, 'model timed out')
    // A `generating` row reads back as in-progress.
    await store.upsert(meta('2026-10-15', { status: 'generating' }), '')
    assert.equal((await store.get('2026-10-15')).meta.status, 'generating')
  } finally {
    await context.cleanup()
  }
})

test('a failure with no prior report writes metadata only, no empty body file', async () => {
  const context = await scratch()
  try {
    const { store } = context
    await store.upsert(meta('2026-10-16', { status: 'failed', error: 'no sessions' }), '')
    const failed = await store.get('2026-10-16')
    assert.equal(failed.meta.status, 'failed')
    assert.equal(failed.meta.error, 'no sessions')
    assert.equal(failed.body, '')
    // The interface allows the `.md` to be absent for a failed report; an empty
    // file would read as an empty report instead of as a failure.
    assert.deepEqual(await tree(join(context.dir, 'reports/day')), ['2026-10-16.json'])
  } finally {
    await context.cleanup()
  }
})

test('keyword search matches Chinese and ASCII through the trigram index', async () => {
  const context = await scratch()
  try {
    const { store } = context
    await store.upsert(meta('2026-10-12'), '今天我在修复工作日志的存储层，用 SQLite 做全文检索，顺带处理中文分词问题\n')
    await store.upsert(meta('2026-10-13'), '明天要写报告，聚合活动记录并渲染 Markdown\n')
    await store.upsert(meta('2026-10-14'), '修复了 DSH 插件的 webserver 鉴权漏洞\n')

    const hits = await store.search('存储层', { mode: 'keyword' })
    assert.deepEqual(hits.map((hit) => hit.key), ['2026-10-12'])
    assert.ok(hits[0].score > 0, 'bm25 is negated so a better match scores higher')
    assert.match(hits[0].snippet, /存储层/u)

    assert.deepEqual((await store.search('webserver', { mode: 'keyword' })).map((hit) => hit.key), ['2026-10-14'])
    // Two-character terms are below the trigram minimum, so they are answered by
    // a LIKE scan. Without that fallback this would wrongly return nothing.
    assert.deepEqual(
      (await store.search('修复', { mode: 'keyword' })).map((hit) => hit.key).sort(),
      ['2026-10-12', '2026-10-14'],
    )
    // A mixed query intersects the indexed term with the scanned one.
    assert.deepEqual((await store.search('修复 漏洞', { mode: 'keyword' })).map((hit) => hit.key), ['2026-10-14'])
    assert.deepEqual(await store.search('不存在的词汇', { mode: 'keyword' }), [])
    assert.deepEqual(await store.search('   ', { mode: 'keyword' }), [])
    await assert.rejects(store.search('x', { mode: 'fuzzy' }), /unknown search mode/u)
  } finally {
    await context.cleanup()
  }
})

test('keyword search respects the limit and never repeats a report', async () => {
  const context = await scratch()
  try {
    const { store } = context
    await store.upsert(meta('2026-10-12'), '存储层 存储层 存储层\n')
    await store.upsert(meta('2026-10-13'), '存储层 又一处\n')
    await store.upsert(meta('2026-10-14'), '存储层 再三处\n')
    const limited = await store.search('存储层', { mode: 'keyword', limit: 2 })
    assert.equal(limited.length, 2)
    assert.equal(new Set(limited.map((hit) => hit.key)).size, 2)
    assert.equal((await store.search('存储层', { mode: 'keyword' })).length, 3)
    // A repeated term and two matching phrases must still yield one row per key.
    assert.equal((await store.search('存储层 存储层', { mode: 'keyword' })).length, 3)
  } finally {
    await context.cleanup()
  }
})

test('semantic search returns nearest neighbours by cosine similarity', async (t) => {
  // The embedder needs a real vector fixture; when `sqlite-vec` is not
  // installed the store degrades to keyword-only and there is nothing to test.
  const probe = await scratch()
  const supported = probe.store.vectorSupport
  await probe.cleanup()
  if (!supported) {
    t.skip('sqlite-vec is not installed in this checkout')
    return
  }

  const embedder = tableEmbedder({
    // Keys are the bodies as `upsert` sees them: trimmed.
    '正文 A 存储层': unit(0),
    '正文 B 存储层': unit(0.1),
    '正文 C 存储层': unit(Math.PI / 2),
    query: unit(0),
  })
  const context = await scratch({ embed: embedder })
  try {
    const { store } = context
    assert.equal(store.vectorSupport, true)
    await store.upsert(meta('2026-10-12', { label: 'A' }), '正文 A 存储层\n')
    await store.upsert(meta('2026-10-13', { label: 'B' }), '正文 B 存储层\n')
    await store.upsert(meta('2026-10-14', { label: 'C' }), '正文 C 存储层\n')

    const hits = await store.search('query', { mode: 'semantic' })
    // The orthogonal report is a nearest neighbour only because `vec0` always
    // returns k rows; its similarity is float32 noise around zero, so it is not
    // a hit.
    assert.deepEqual(hits.map((hit) => hit.key), ['2026-10-12', '2026-10-13'])
    // L2 distance d maps to cosine 1 - d²/2 for unit vectors.
    assert.ok(Math.abs(hits[0].score - 1) < 1e-3, `expected ~1, got ${hits[0].score}`)
    assert.ok(Math.abs(hits[1].score - Math.cos(0.1)) < 1e-3, `expected cos(0.1), got ${hits[1].score}`)
    assert.ok(hits[0].score > hits[1].score)
    assert.equal((await store.search('query', { mode: 'semantic', limit: 1 })).length, 1)
    // A report with no stored vector does not appear in semantic results.
    await store.upsert(meta('2026-10-15', { label: 'D' }), '正文 D 存储层\n')
    assert.deepEqual((await store.search('query', { mode: 'semantic' })).map((hit) => hit.key), ['2026-10-12', '2026-10-13'])
  } finally {
    await context.cleanup()
  }
})

test('hybrid fuses keyword and semantic ranks and de-duplicates', async (t) => {
  const probe = await scratch()
  const supported = probe.store.vectorSupport
  await probe.cleanup()
  if (!supported) {
    t.skip('sqlite-vec is not installed in this checkout')
    return
  }

  // `搜索专用词` is long enough for the trigram index and appears only in the
  // first report; the query embedding points at the third, so the two modes
  // disagree and the fusion has to merge them.
  const embedder = tableEmbedder({
    '正文一 搜索专用词': unit(Math.PI / 2),
    '正文二 无关键词': unit(Math.PI / 2),
    '正文三 无关键词': unit(0),
    // The query embedding points at the third report, so keyword and semantic
    // nominate different keys.
    搜索专用词: unit(0),
  })
  const context = await scratch({ embed: embedder })
  try {
    const { store } = context
    await store.upsert(meta('2026-10-12'), '正文一 搜索专用词\n')
    await store.upsert(meta('2026-10-13'), '正文二 无关键词\n')
    await store.upsert(meta('2026-10-14'), '正文三 无关键词\n')

    assert.deepEqual((await store.search('搜索专用词', { mode: 'keyword' })).map((hit) => hit.key), ['2026-10-12'])
    assert.deepEqual((await store.search('搜索专用词', { mode: 'semantic' })).map((hit) => hit.key), ['2026-10-14'])

    const hybrid = await store.search('搜索专用词', { mode: 'hybrid' })
    assert.deepEqual(hybrid.map((hit) => hit.key).sort(), ['2026-10-12', '2026-10-14'])
    assert.equal(new Set(hybrid.map((hit) => hit.key)).size, hybrid.length)
    assert.ok(hybrid.every((hit) => hit.score > 0))
  } finally {
    await context.cleanup()
  }
})

test('hybrid ranks a report found by both modes above one found by either', async (t) => {
  const probe = await scratch()
  const supported = probe.store.vectorSupport
  await probe.cleanup()
  if (!supported) {
    t.skip('sqlite-vec is not installed in this checkout')
    return
  }

  const embedder = tableEmbedder({
    // The first report is nominated by both modes; the second only by the vector.
    '共享词汇 正文': unit(0),
    另一个文档: unit(0.5),
    共享词: unit(0),
  })
  const context = await scratch({ embed: embedder })
  try {
    const { store } = context
    await store.upsert(meta('2026-10-12'), '共享词汇 正文\n')
    await store.upsert(meta('2026-10-13'), '另一个文档\n')
    assert.deepEqual((await store.search('共享词', { mode: 'keyword' })).map((hit) => hit.key), ['2026-10-12'])
    assert.deepEqual((await store.search('共享词', { mode: 'semantic' })).map((hit) => hit.key), ['2026-10-12', '2026-10-13'])
    // Reciprocal-rank fusion adds two contributions for the report both modes
    // nominate, so it must outrank the one the vector alone found.
    const hybrid = await store.search('共享词', { mode: 'hybrid' })
    assert.equal(hybrid[0].key, '2026-10-12')
    assert.ok(hybrid[0].score > hybrid[1].score, `${hybrid[0].score} vs ${hybrid[1].score}`)
  } finally {
    await context.cleanup()
  }
})

test('hybrid degrades to keyword results without an embedder', async () => {
  const context = await scratch()
  try {
    const { store } = context
    await store.upsert(meta('2026-10-12'), '关于存储层的设计说明\n')
    // Semantic search is refused outright rather than returning a silent empty
    // page, because the caller asked for something the store cannot do.
    await assert.rejects(store.search('存储层', { mode: 'semantic' }), /requires an embed function/u)
    const hybrid = await store.search('存储层', { mode: 'hybrid' })
    assert.deepEqual(hybrid.map((hit) => hit.key), ['2026-10-12'])
  } finally {
    await context.cleanup()
  }
})

test('a lost embedding costs the vector, never the report', async (t) => {
  const probe = await scratch()
  const supported = probe.store.vectorSupport
  await probe.cleanup()
  if (!supported) {
    t.skip('sqlite-vec is not installed in this checkout')
    return
  }

  const warnings = []
  const context = await scratch({
    onWarning: (message) => warnings.push(message),
    embed: async () => {
      throw new Error('model unavailable')
    },
  })
  try {
    const { store } = context
    await store.upsert(meta('2026-10-12'), '存储层 正文\n')
    // Keyword search still finds it, so the report is not lost with the vector.
    assert.deepEqual((await store.search('存储层', { mode: 'keyword' })).map((hit) => hit.key), ['2026-10-12'])
    assert.deepEqual(await store.search('存储层', { mode: 'semantic' }), [])
    assert.ok(warnings.some((message) => /embedding failed/u.test(message)), `warnings: ${warnings.join(' | ')}`)
    // A wrong-width vector is refused the same way instead of corrupting vec0.
    const widthWarnings = []
    const wrong = await scratch({
      onWarning: (message) => widthWarnings.push(message),
      embed: async () => [new Float32Array(3)],
    })
    try {
      await wrong.store.upsert(meta('2026-10-12'), '存储层 正文\n')
      assert.equal((await wrong.store.get('2026-10-12')).meta.status, 'ok')
      assert.ok(widthWarnings.some((message) => /dimensions/u.test(message)), `warnings: ${widthWarnings.join(' | ')}`)
    } finally {
      await wrong.cleanup()
    }
  } finally {
    await context.cleanup()
  }
})

test('a failed file write never leaves a half-written or half-committed report', async () => {
  const context = await scratch()
  try {
    const { store } = context
    const first = { ...meta('2026-10-12'), label: 'good' }
    await store.upsert(first, '# 完整旧报告\n')

    // Fail the metadata write, which lands after the Markdown write, so both
    // the file tree and the index are observed mid-operation.
    await store.close()
    const failing = openReportStore(join(context.dir, 'index.sqlite'), {
      write: async (path, content, options) => {
        if (path.endsWith('.json')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        const { writeFileAtomic } = await import('@deepseek-ai/dsh-atomic-write')
        await writeFileAtomic(path, content, options)
      },
    })
    try {
      await assert.rejects(
        failing.upsert({ ...first, label: 'broken', sessionCount: 99 }, '# 半截新报告\n'),
        /disk full/u,
      )
      // Nothing was committed: the row, and therefore every read path, still
      // describes the previous complete report.
      const [listed] = await failing.list()
      assert.equal(listed.label, 'good')
      assert.equal(listed.sessionCount, 1)
      assert.equal((await failing.get('2026-10-12')).body, '# 完整旧报告\n')
      assert.deepEqual((await failing.search('完整旧报告', { mode: 'keyword' })).map((hit) => hit.key), ['2026-10-12'])
      // The replacement is atomic, so no reader can observe a truncated file.
      const onDisk = await readFile(join(context.dir, 'reports/day/2026-10-12.md'), 'utf8')
      assert.ok(
        onDisk === '# 完整旧报告\n' || onDisk === '# 半截新报告\n',
        `expected one complete document, got ${JSON.stringify(onDisk)}`,
      )
      // And the failed write cleaned up its temp file.
      const files = await tree(join(context.dir, 'reports'))
      assert.deepEqual(files.filter((name) => name.includes('.tmp')), [])
    } finally {
      await failing.close()
    }
  } finally {
    await context.cleanup()
  }
})

test('remove drops the row, both indexes, and the files', async () => {
  const context = await scratch()
  try {
    const { store } = context
    await store.upsert(meta('2026-10-12'), '存储层\n')
    await store.upsert(meta('2026-10-13'), '存储层 之二\n')
    await store.remove('2026-10-12')

    assert.equal(await store.get('2026-10-12'), undefined)
    assert.deepEqual((await store.list()).map((entry) => entry.key), ['2026-10-13'])
    // The FTS index must not keep answering with a report that no longer exists.
    assert.deepEqual((await store.search('存储层', { mode: 'keyword' })).map((hit) => hit.key), ['2026-10-13'])
    assert.deepEqual(await tree(join(context.dir, 'reports/day')), ['2026-10-13.json', '2026-10-13.md'])
    assert.ok(!existsSync(join(context.dir, 'reports/day/2026-10-12.md')))

    // Removing again is a no-op, not a crash.
    await store.remove('2026-10-12')
    await assert.rejects(store.remove('../escape'), /invalid report key/u)
  } finally {
    await context.cleanup()
  }
})

test('remove also clears the vector row', async (t) => {
  const probe = await scratch()
  const supported = probe.store.vectorSupport
  await probe.cleanup()
  if (!supported) {
    t.skip('sqlite-vec is not installed in this checkout')
    return
  }

  const context = await scratch({ embed: async (texts) => texts.map(() => unit(0)) })
  try {
    const { store } = context
    await store.upsert(meta('2026-10-12'), '存储层\n')
    assert.deepEqual((await store.search('x', { mode: 'semantic' })).map((hit) => hit.key), ['2026-10-12'])
    await store.remove('2026-10-12')
    assert.deepEqual(await store.search('x', { mode: 'semantic' }), [])
  } finally {
    await context.cleanup()
  }
})

test('refuses a relative path or a mismatched vector width', () => {
  assert.throws(() => openReportStore('relative/index.sqlite'), /absolute path/u)
  assert.throws(() => openReportStore('/tmp/x/index.sqlite', { dims: 384 }), /512 dimensions/u)
  assert.throws(() => openReportStore('/tmp/x/index.sqlite', { reportsDir: 'reports' }), /reportsDir must be an absolute path/u)
})

test('survives reopening an existing store', async () => {
  const context = await scratch()
  try {
    await context.store.upsert(meta('2026-10-12'), '存储层\n')
    await context.store.close()
    const reopened = openReportStore(join(context.dir, 'index.sqlite'))
    try {
      assert.deepEqual((await reopened.list()).map((entry) => entry.key), ['2026-10-12'])
      assert.deepEqual((await reopened.search('存储层', { mode: 'keyword' })).map((hit) => hit.key), ['2026-10-12'])
      // Re-opening must not fail on an already-created FTS or vec table.
      await reopened.upsert(meta('2026-10-13'), '存储层 之二\n')
      assert.equal((await reopened.list()).length, 2)
    } finally {
      await reopened.close()
    }
  } finally {
    await context.cleanup()
  }
})

test('close is idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wj-report-store-'))
  try {
    const store = openReportStore(join(dir, 'index.sqlite'))
    await store.close()
    await store.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
