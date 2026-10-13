/**
 * Durable storage for generated work-journal reports.
 *
 * A report is a triple: a human-readable Markdown body, a metadata document the
 * GUI lists without rendering anything, and a row in a queryable SQLite index.
 * The three must agree, and they cannot agree perfectly — there are two commit
 * domains (a filesystem and a database) and no cross-domain transaction. So each
 * operation is ordered to fail in the direction that stays visible-consistent:
 *
 *  - `upsert` writes the content files first and commits the row last, so an
 *    indexed report always has its files; a crash in between leaves orphan
 *    files, which nothing lists.
 *  - `remove` drops the row first and unlinks the files last, for the same
 *    reason in reverse: a removed report can leave files behind, never a listed
 *    report whose body is gone.
 *
 * Each domain on its own is atomic: files go through `writeFileAtomic` (fresh
 * inode renamed over the target) and the row, its full-text row, and its vector
 * go through one SQLite transaction, so a reader never sees a report indexed in
 * one of the three tables but not the others.
 *
 * The SQLite index is derived data — it can be rebuilt from the files at any
 * time — so there is no migration story here, only the frozen schema.
 */

import { mkdirSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/**
 * `sqlite-vec` ships a native `.so` and is resolved through CommonJS, because
 * the extension must be loaded synchronously while the handle is being built.
 */
const require = createRequire(import.meta.url)

/** Report range kinds; `recent`/`all` are queries, not stored reports. */
export const REPORT_KINDS = Object.freeze(['day', 'week', 'month'])
/** Report lifecycle states. Only `ok` reports are expected to have a body. */
export const REPORT_STATUSES = Object.freeze(['ok', 'failed', 'generating'])
/** Search modes accepted by `search`. */
export const SEARCH_MODES = Object.freeze(['keyword', 'semantic', 'hybrid'])
/**
 * Vector width of `bge-small-zh-v1.5`, fixed by the frozen schema
 * (`reports_vec.embedding float[512]`).
 */
export const EMBEDDING_DIMS = 512

/**
 * Report keys become filenames (`reports/<kind>/<key>.md`), so the accepted
 * shape is a filename segment: an alphanumeric first character followed by
 * alphanumerics, dots, underscores, and dashes. That admits every documented key
 * (`2026-10-12`, `2026-W41`, `2026-09`) and refuses `.`, `..`, and anything with
 * a separator or a NUL byte.
 */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
/**
 * Reciprocal-rank-fusion constant. Keyword scores are bm25 values and semantic
 * scores are cosine similarities; those scales are not comparable, so hybrid
 * mode fuses *ranks* instead of scores and no calibration is needed.
 */
const RRF_K = 60
/** Trigram tokens a snippet shows around a hit; roughly characters. */
const SNIPPET_TOKENS = 12
/** Characters of fallback excerpt shown when no snippet can be built. */
const EXCERPT_CHARS = 180
/** Reports a list call returns when the caller does not bound it. */
const DEFAULT_LIST_LIMIT = 100
/**
 * Smallest cosine similarity that counts as a semantic hit.
 *
 * A `k`-nearest-neighbour query is bounded by count, not relevance: ask for five
 * neighbours of a store holding five unrelated reports and all five come back.
 * Reporting those as hits would misrepresent a search that found nothing, and
 * admitting them to the hybrid fusion would let an unrelated report at rank five
 * score within a hair of the keyword mode's best match.
 *
 * The floor only has to separate "related" from "orthogonal". `bge-small-zh-v1.5`
 * puts related Chinese passages far above 1e-3, while float32 rounding around a
 * true zero similarity lands near 1e-8 — five orders of magnitude below, so the
 * exact value is not a tuning knob.
 */
const MIN_SEMANTIC_SIMILARITY = 1e-3

/** The three SQLite tables, exactly as frozen. `IF NOT EXISTS` keeps re-open idempotent. */
const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS reports (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  model_provider TEXT, model_name TEXT,
  session_count INTEGER DEFAULT 0,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_time ON reports(start_time DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS reports_fts USING fts5(
  key UNINDEXED, body, tokenize='trigram'
);
`

/**
 * Validate a required integer field.
 * @param value - the caller-supplied value.
 * @param name - field name for the error message.
 * @returns the value as a number.
 */
function requireInteger(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError(`work-journal: report metadata.${name} must be an integer`)
  }
  return value
}

/**
 * Normalize and validate caller-supplied metadata into the frozen JSON shape.
 *
 * Validation is up front and total: everything the writer needs (the filename
 * segment, the enum columns, the integer columns) is checked here, so a
 * statement later in `upsert` cannot fail on a caller mistake and roll back a
 * partly written report.
 * @param meta - the metadata document described by the interface.
 * @returns a fresh record with every interface field present.
 */
function normalizeMeta(meta) {
  if (meta === null || typeof meta !== 'object') {
    throw new TypeError('work-journal: report metadata must be an object')
  }
  if (meta.version !== undefined && meta.version !== 1) {
    throw new TypeError(`work-journal: unsupported report metadata version: ${String(meta.version)}`)
  }
  const { key, kind, label } = meta
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new TypeError(`work-journal: invalid report key: ${JSON.stringify(key)}`)
  }
  if (!REPORT_KINDS.includes(kind)) {
    throw new TypeError(`work-journal: unknown report kind: ${JSON.stringify(kind)}`)
  }
  if (typeof label !== 'string' || label.length === 0) {
    throw new TypeError('work-journal: report metadata.label must be a non-empty string')
  }
  if (!REPORT_STATUSES.includes(meta.status)) {
    throw new TypeError(`work-journal: unknown report status: ${JSON.stringify(meta.status)}`)
  }
  const model = meta.model ?? {}
  const sessionCount = meta.sessionCount === undefined ? 0 : requireInteger(meta.sessionCount, 'sessionCount')
  if (sessionCount < 0) throw new TypeError('work-journal: report metadata.sessionCount must not be negative')
  return {
    version: 1,
    key,
    kind,
    label,
    startTime: requireInteger(meta.startTime, 'startTime'),
    endTime: requireInteger(meta.endTime, 'endTime'),
    generatedAt: requireInteger(meta.generatedAt, 'generatedAt'),
    // A provider that is absent is meaningful (`null`), not a malformed string.
    model: {
      provider: typeof model.provider === 'string' ? model.provider : null,
      model: typeof model.model === 'string' ? model.model : null,
    },
    status: meta.status,
    sessionCount,
    // The interface types this as a string on failure and null otherwise; a
    // non-string is coerced away rather than thrown, because this is the error
    // path of a caller that is already handling a failure.
    error: typeof meta.error === 'string' && meta.error.length > 0 ? meta.error : null,
  }
}

/**
 * Rebuild the interface metadata shape from a `reports` row.
 * @param row - a row selected with the camelCase aliases used below.
 * @returns the metadata document, with `error` always null for now.
 */
function metaFromRow(row) {
  return {
    version: 1,
    key: row.key,
    kind: row.kind,
    label: row.label,
    startTime: row.startTime,
    endTime: row.endTime,
    generatedAt: row.generatedAt,
    model: { provider: row.modelProvider ?? null, model: row.modelName ?? null },
    status: row.status,
    sessionCount: row.sessionCount ?? 0,
    error: null,
  }
}

/**
 * Convert a `Float32Array` into the little-endian BLOB `vec0` expects.
 *
 * `Buffer.from(view.buffer, ...)` is a view, not a copy, so this is cheap; the
 * driver binds a `Uint8Array` directly.
 * @param vector - the embedding.
 * @returns the bytes to bind.
 */
function toBlob(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
}

/**
 * Collapse whitespace so an excerpt stays one line in a list.
 * @param text - raw body text.
 * @returns the collapsed text.
 */
function collapse(text) {
  return text.replace(/\s+/gu, ' ').trim()
}

/**
 * Build a one-line excerpt centred on the first matching term.
 * @param body - the report body.
 * @param terms - the search terms, in priority order.
 * @returns the excerpt, or an empty string for an empty body.
 */
function excerpt(body, terms) {
  const text = collapse(body)
  if (text.length === 0) return ''
  const haystack = text.toLowerCase()
  let at = -1
  let width = 0
  for (const term of terms) {
    const found = haystack.indexOf(term.toLowerCase())
    // Prefer the earliest hit; ties go to the longer term, which is the more
    // informative anchor for the window.
    if (found !== -1 && (at === -1 || found < at || (found === at && term.length > width))) {
      at = found
      width = term.length
    }
  }
  if (at === -1) {
    return text.length <= EXCERPT_CHARS ? text : `${text.slice(0, EXCERPT_CHARS)}…`
  }
  const half = Math.max(0, Math.floor((EXCERPT_CHARS - width) / 2))
  const start = Math.max(0, at - half)
  const end = Math.min(text.length, start + EXCERPT_CHARS)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/** Escape the LIKE metacharacters in a term, for use with `ESCAPE '\'`. */
function forLike(term) {
  return term.replace(/[\\%_]/gu, (character) => `\\${character}`)
}

/** Split a query into whitespace-separated terms, dropping empties. */
function termsOf(query) {
  return query.split(/\s+/u).filter((term) => term.length > 0)
}

/**
 * Render one FTS5 phrase. Trigrams match whole phrases, and a term containing
 * `"` must have it doubled to stay inside the phrase.
 * @param term - one query term.
 * @returns the quoted phrase.
 */
function phrase(term) {
  return `"${term.replace(/"/gu, '""')}"`
}

/**
 * Split terms by whether the trigram index can serve them.
 *
 * FTS5's trigram tokenizer indexes three-character sequences, so a term shorter
 * than three characters can never match — `修复` returns nothing from `MATCH`
 * while matching rows plainly exist. Those short terms are answered by a LIKE
 * scan instead, which is correct (if slower) and keeps a two-character search
 * useful in a language where two characters are a word.
 * @param terms - the query terms.
 * @returns the long (indexed) and short (scanned) terms.
 */
function splitTerms(terms) {
  const long = []
  const short = []
  for (const term of terms) {
    if ([...term].length >= 3) long.push(term)
    else short.push(term)
  }
  return { long, short }
}

/**
 * Open the report store.
 *
 * `path` is the SQLite index file — `index.sqlite` at the root of the module's
 * data directory, alongside the `reports/` tree it indexes. Report files land in
 * `<dirname(path)>/reports/` unless `reportsDir` overrides it.
 * @param path - absolute path to `index.sqlite`, or `:memory:` for a scratch store.
 * @param options - optional wiring:
 *   - `embed(texts, signal?)`: the embedder from `lib/embedding.js`. Omit it for
 *     a keyword-only store; then nothing is vectorized and semantic search is
 *     refused rather than silently empty.
 *   - `reportsDir`: absolute override for the Markdown/JSON tree.
 *   - `dims`: vector width; defaults to 512 and must match the embedder.
 *   - `write`/`readFile`: injectable file primitives for tests.
 *   - `onWarning(message)`: sink for degraded-but-working conditions.
 * @returns the store handle.
 */
export function openReportStore(path, options = {}) {
  if (path !== ':memory:' && (typeof path !== 'string' || !isAbsolute(path))) {
    throw new TypeError('work-journal: report store path must be an absolute path')
  }
  const dims = options.dims ?? EMBEDDING_DIMS
  if (dims !== EMBEDDING_DIMS) {
    throw new TypeError(`work-journal: report store vectors must be ${EMBEDDING_DIMS} dimensions, got ${String(dims)}`)
  }
  const reportsDir = options.reportsDir ?? join(dirname(path), 'reports')
  if (!isAbsolute(reportsDir)) {
    throw new TypeError('work-journal: reportsDir must be an absolute path')
  }
  const writeImpl = options.write ?? writeFileAtomic
  const readImpl = options.readFile ?? readFile
  const warn = (message) => options.onWarning?.(message)
  const embed = options.embed

  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  // `allowExtension` is required: without it the driver refuses to enable
  // extension loading at all ("Cannot enable extension loading because it was
  // disabled at database creation").
  const db = new DatabaseSync(path, { allowExtension: true })

  const vectorSupport = (() => {
    try {
      const sqliteVec = require('sqlite-vec')
      db.enableLoadExtension(true)
      sqliteVec.load(db)
      return true
    } catch (error) {
      // A missing native extension costs semantic search, not the journal: the
      // Markdown, metadata, and keyword index all keep working.
      warn(`work-journal: sqlite-vec unavailable, semantic search disabled: ${error.message}`)
      return false
    }
  })()

  db.exec('PRAGMA busy_timeout = 5000')
  // WAL lets the panel read while a scan writes, and the sidecar files sit next
  // to the index in the same private directory.
  db.prepare('PRAGMA journal_mode = WAL').get()
  db.exec(BASE_SCHEMA)
  if (vectorSupport) {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS reports_vec USING vec0(
  key TEXT PRIMARY KEY, embedding float[${dims}]
)`)
  }

  const statements = new Map()
  const stmt = (sql) => {
    let prepared = statements.get(sql)
    if (prepared === undefined) {
      prepared = db.prepare(sql)
      statements.set(sql, prepared)
    }
    return prepared
  }

  /** Run `work` inside one transaction, rolling back on any failure. */
  const transact = (work) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // A failed rollback leaves the handle unusable for the caller's error
        // path too, and the original failure is the one worth reporting.
      }
      throw error
    }
  }

  const UPSERT_REPORT = `INSERT INTO reports
  (key, kind, label, start_time, end_time, generated_at, status, model_provider, model_name, session_count, body)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(key) DO UPDATE SET
  kind = excluded.kind, label = excluded.label,
  start_time = excluded.start_time, end_time = excluded.end_time,
  generated_at = excluded.generated_at, status = excluded.status,
  model_provider = excluded.model_provider, model_name = excluded.model_name,
  session_count = excluded.session_count, body = excluded.body`
  const SELECT_COLUMNS = `SELECT key, kind, label, start_time AS startTime, end_time AS endTime,
  generated_at AS generatedAt, status, model_provider AS modelProvider,
  model_name AS modelName, session_count AS sessionCount, body FROM reports`

  /** Read the failure reason, which the frozen schema has no column for. */
  const attachError = async (meta) => {
    if (meta.status === 'ok') return meta
    if (!REPORT_KINDS.includes(meta.kind) || !KEY_PATTERN.test(meta.key)) return meta
    try {
      const raw = await readImpl(join(reportsDir, meta.kind, `${meta.key}.json`), 'utf8')
      const parsed = JSON.parse(raw)
      if (typeof parsed?.error === 'string' && parsed.error.length > 0) meta.error = parsed.error
    } catch {
      // A failed report whose metadata file is gone is still a failed report;
      // the reason is simply unavailable.
    }
    return meta
  }

  /**
   * Embed one body, treating every failure as "no vector".
   *
   * Losing an embedding costs a vector hit, never the report: the caller gets
   * the same report with keyword search, which is why this returns `null`
   * instead of throwing.
   */
  const embedBody = async (body) => {
    if (typeof embed !== 'function') return null
    const text = body.trim()
    if (text.length === 0) return null
    try {
      const [vector] = await embed([text])
      if (!(vector instanceof Float32Array)) {
        warn('work-journal: embedder returned no vector; storing the report without one')
        return null
      }
      if (vector.length !== dims) {
        warn(`work-journal: embedder returned ${vector.length} dimensions, expected ${dims}; storing the report without a vector`)
        return null
      }
      return vector
    } catch (error) {
      warn(`work-journal: embedding failed, storing the report without a vector: ${error?.message ?? error}`)
      return null
    }
  }

  const upsert = async (meta, body) => {
    if (typeof body !== 'string') throw new TypeError('work-journal: report body must be a string')
    const record = normalizeMeta(meta)
    const vector = vectorSupport ? await embedBody(body) : null
    const directory = join(reportsDir, record.kind)
    // A failed report has no body to show, so no Markdown is written for it: the
    // interface allows `reports/<kind>/<key>.md` to be absent when the status is
    // `failed`, and an empty file would read as an empty report rather than as a
    // failure. Any previously good body is preserved in *both* stores — the file
    // and the indexed `body` column — because a body that `get()` returns from
    // the row but that the file disagrees with is worse than either answer alone.
    // The metadata is always written, because the status change is the whole
    // point of recording the failure.
    const previous = stmt('SELECT body FROM reports WHERE key = ?').get(record.key)
    const failed = record.status === 'failed' && body.length === 0
    const keepBody = failed && previous !== undefined
    const storedBody = keepBody ? previous.body : body
    if (!failed) {
      await writeImpl(join(directory, `${record.key}.md`), body, { mode: 0o600, dirMode: 0o700 })
    }
    await writeImpl(
      join(directory, `${record.key}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      { mode: 0o600, dirMode: 0o700 },
    )
    transact(() => {
      stmt(UPSERT_REPORT).run(
        record.key, record.kind, record.label, record.startTime, record.endTime,
        record.generatedAt, record.status, record.model.provider, record.model.model,
        record.sessionCount, storedBody,
      )
      // When the body was preserved its FTS and vector rows still describe it,
      // so re-indexing would only risk the two drifting apart.
      if (keepBody) return
      // FTS5 and vec0 are contentless with respect to a keyed update: neither
      // supports UPSERT, so the row is replaced rather than merged.
      stmt('DELETE FROM reports_fts WHERE key = ?').run(record.key)
      stmt('INSERT INTO reports_fts(key, body) VALUES (?, ?)').run(record.key, body)
      if (vectorSupport) {
        stmt('DELETE FROM reports_vec WHERE key = ?').run(record.key)
        if (vector !== null) {
          stmt('INSERT INTO reports_vec(key, embedding) VALUES (?, ?)').run(record.key, toBlob(vector))
        }
      }
    })
  }

  const list = async (query = {}) => {
    const { kind } = query
    if (kind !== undefined && !REPORT_KINDS.includes(kind)) {
      throw new TypeError(`work-journal: unknown report kind: ${JSON.stringify(kind)}`)
    }
    const limit = query.limit ?? DEFAULT_LIST_LIMIT
    const offset = query.offset ?? 0
    if (!Number.isInteger(limit) || limit < 0) throw new TypeError('work-journal: list limit must be a non-negative integer')
    if (!Number.isInteger(offset) || offset < 0) throw new TypeError('work-journal: list offset must be a non-negative integer')
    const rows = kind === undefined
      ? stmt(`${SELECT_COLUMNS} ORDER BY start_time DESC, key DESC LIMIT ? OFFSET ?`).all(limit, offset)
      : stmt(`${SELECT_COLUMNS} WHERE kind = ? ORDER BY start_time DESC, key DESC LIMIT ? OFFSET ?`).all(kind, limit, offset)
    return Promise.all(rows.map((row) => attachError(metaFromRow(row))))
  }

  const get = async (key) => {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) return undefined
    const row = stmt(`${SELECT_COLUMNS} WHERE key = ?`).get(key)
    if (row === undefined) return undefined
    return { meta: await attachError(metaFromRow(row)), body: row.body }
  }

  /**
   * Keyword search over the trigram index, with a LIKE scan for short terms.
   * @param query - the raw query text.
   * @param limit - maximum rows.
   * @returns hits ordered best-first, each `{ key, score, snippet }`.
   */
  const keywordSearch = (query, limit) => {
    const terms = termsOf(query)
    const { long, short } = splitTerms(terms)
    if (long.length === 0) {
      // Nothing the trigram index can answer: scan, newest first, and report a
      // neutral score because there is no ranker to derive one from.
      const conditions = short.map(() => "body LIKE ? ESCAPE '\\'").join(' AND ')
      const args = short.map((term) => `%${forLike(term)}%`)
      const rows = stmt(`SELECT key, body FROM reports WHERE ${conditions} ORDER BY start_time DESC, key DESC LIMIT ?`).all(...args, limit)
      return rows.map((row) => ({ key: row.key, score: 0, snippet: excerpt(row.body, terms) }))
    }
    // The MATCH column must be named by table, not alias: `f MATCH ?` is a
    // syntax error in FTS5.
    const conditions = ['reports_fts MATCH ?', ...short.map(() => "reports.body LIKE ? ESCAPE '\\'")]
    const args = [long.map(phrase).join(' '), ...short.map((term) => `%${forLike(term)}%`)]
    const rows = stmt(`SELECT reports.key AS key, bm25(reports_fts) AS rank,
  snippet(reports_fts, 1, '', '', '…', ${SNIPPET_TOKENS}) AS snippet
 FROM reports_fts JOIN reports ON reports.key = reports_fts.key
 WHERE ${conditions.join(' AND ')} ORDER BY rank LIMIT ?`).all(...args, limit)
    // bm25 is smaller-is-better and negative; negating gives the interface's
    // larger-is-better score without changing the order.
    return rows.map((row) => ({ key: row.key, score: -row.rank, snippet: row.snippet }))
  }

  /**
   * Vector search over `reports_vec`.
   *
   * An embedding failure yields no hits rather than an exception: a search that
   * cannot rank semantically still owes the caller an answer, and hybrid mode
   * needs the keyword half to survive a model that is down.
   * @param query - the raw query text.
   * @param limit - maximum rows.
   * @returns hits ordered best-first, each `{ key, score, snippet }`.
   */
  const semanticSearch = async (query, limit) => {
    if (!vectorSupport) return []
    if (typeof embed !== 'function') {
      throw new Error('work-journal: semantic search requires an embed function on the report store')
    }
    let vector
    try {
      ;[vector] = await embed([query])
    } catch (error) {
      warn(`work-journal: query embedding failed, returning no semantic hits: ${error?.message ?? error}`)
      return []
    }
    if (!(vector instanceof Float32Array) || vector.length !== dims) return []
    const hits = stmt('SELECT key, distance FROM reports_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance').all(toBlob(vector), limit)
    if (hits.length === 0) return []
    // Hydrate in one statement; a vector row whose report row vanished is
    // dropped rather than surfaced as a hit with no metadata.
    const placeholders = hits.map(() => '?').join(', ')
    const bodies = new Map(
      stmt(`SELECT key, body FROM reports WHERE key IN (${placeholders})`)
        .all(...hits.map((hit) => hit.key))
        .map((row) => [row.key, row.body]),
    )
    const terms = termsOf(query)
    return hits
      .filter((hit) => bodies.has(hit.key))
      .map((hit) => ({
        key: hit.key,
        // `vec0` reports an L2 distance; the interface requires L2-normalized
        // vectors, for which d² = 2 − 2·cos, so this recovers cosine similarity.
        score: 1 - (hit.distance * hit.distance) / 2,
        snippet: excerpt(bodies.get(hit.key), terms),
      }))
      // `k` bounds the answer by count, not by relevance, so an unrelated report
      // still comes back as the k-th neighbour. A similarity at or below the
      // relevance floor is no evidence of a relationship, and reporting it as a
      // hit would misrepresent a search that found nothing.
      .filter((hit) => hit.score >= MIN_SEMANTIC_SIMILARITY)
  }

  /** Fuse two ranked lists by reciprocal rank, then cut to `limit`. */
  const fuse = (keyword, semantic, limit) => {
    const fused = new Map()
    const absorb = (hits) => {
      hits.forEach((hit, rank) => {
        const entry = fused.get(hit.key) ?? { key: hit.key, score: 0, snippet: hit.snippet }
        entry.score += 1 / (RRF_K + rank + 1)
        // Prefer the keyword snippet: it is centred on the literal query and
        // shows the highlight markers the FTS snippet would carry.
        if (hit.snippet.length > 0 && entry.snippet.length === 0) entry.snippet = hit.snippet
        fused.set(hit.key, entry)
      })
    }
    absorb(keyword)
    // The semantic half arrives already floored at the relevance minimum, so
    // every hit here is evidence of a relationship rather than a k-th neighbour
    // returned only because `vec0` always answers with k rows.
    absorb(semantic)
    return [...fused.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, limit)
  }

  const search = async (query, searchOptions = {}) => {
    const mode = searchOptions.mode ?? 'keyword'
    if (!SEARCH_MODES.includes(mode)) {
      throw new TypeError(`work-journal: unknown search mode: ${JSON.stringify(mode)}`)
    }
    const limit = searchOptions.limit ?? 20
    if (!Number.isInteger(limit) || limit <= 0) throw new TypeError('work-journal: search limit must be a positive integer')
    const text = typeof query === 'string' ? query.trim() : ''
    if (text.length === 0) return []
    if (mode === 'keyword') return keywordSearch(text, limit)
    if (mode === 'semantic') return semanticSearch(text, limit)
    // Hybrid is best-effort: without an embedder it degrades to keyword results
    // rather than refusing to answer at all.
    const semantic = typeof embed === 'function' ? await semanticSearch(text, limit) : []
    return fuse(keywordSearch(text, limit), semantic, limit)
  }

  const remove = async (key) => {
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      throw new TypeError(`work-journal: invalid report key: ${JSON.stringify(key)}`)
    }
    const row = stmt('SELECT kind FROM reports WHERE key = ?').get(key)
    transact(() => {
      stmt('DELETE FROM reports WHERE key = ?').run(key)
      stmt('DELETE FROM reports_fts WHERE key = ?').run(key)
      if (vectorSupport) stmt('DELETE FROM reports_vec WHERE key = ?').run(key)
    })
    // The row is gone but the kind is only recoverable from it, so the files are
    // unlinked using the kind read before the transaction.
    const kind = row?.kind
    const directory = REPORT_KINDS.includes(kind) ? join(reportsDir, kind) : undefined
    if (directory !== undefined) {
      await rm(join(directory, `${key}.md`), { force: true })
      await rm(join(directory, `${key}.json`), { force: true })
    }
  }

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    db.close()
  }

  return { path, reportsDir, vectorSupport, upsert, list, get, search, remove, close }
}