/**
 * work-journal — a durable record of what this harness was actually used for.
 *
 * The source of truth is the harness's own session store. Every prompt, tool
 * call, and turn is already written to `~/.dsh/sessions` by the persistence
 * backend, so the journal instruments nothing and cannot drift from reality:
 * it reads those logs, projects each session onto local calendar days, and
 * keeps the result in an incremental index that answers daily, weekly, and
 * monthly reports.
 *
 * Three consumers share one runtime: the `work_journal` model tool (ask the
 * harness what you did), the `/journal` command (ask without the model), and a
 * Web panel in the right sidebar (browse and copy the report).
 */

import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installWorkJournal } from './lib/runtime.js'
import { openReportStore, REPORT_KINDS, SEARCH_MODES } from './lib/report-store.js'
import { createScheduler } from './lib/scheduler.js'
import { createReporter } from './lib/reporter.js'
import { createEmbedder } from './lib/embedding.js'

export const name = 'work-journal'
// `connection` is load-bearing: without it `ctx.get('connection')` is
// `undefined`, the web route is never registered, and the panel's POST lands on
// a 405. The row in cordis.patch.yml must list every entry too.
export const inject = ['tools', 'commands', 'sessionPersistence', 'connection']

/** RPC channel the Web panel posts to. */
const RPC_CHANNEL = '/work-journal'
/** Fetch route the panel posts to on a runtime that serves plugin routes. */
const FETCH_PATH = '/api/work-journal'
/** Envelope method name for that route. */
const FETCH_METHOD = 'work-journal'
/** Longest Markdown document the tool returns to the model. */
const MAX_TOOL_CHARS = 24000
/** Range kinds the tool and the panel accept. */
const RANGES = ['day', 'week', 'month', 'recent', 'all']
/** Report rows one `list` call may return; the panel pages beyond this. */
const LIST_MAX = 500
/** Hits one `search` call may return. */
const SEARCH_MAX = 100

/**
 * Profile-scoped directory holding generated reports.
 *
 * Keyed like the live index so two profiles (or two timezones) sharing one
 * `DSH_HOME` cannot overwrite each other's reports.
 * @param profileContext - the `profileContext` service, when mounted.
 * @param tzOffsetMinutes - resolved local offset in minutes.
 * @returns an absolute directory path.
 */
function defaultReportsDir(profileContext, tzOffsetMinutes) {
  const home = resolve(profileContext?.home || process.env.DSH_HOME || join(homedir(), '.dsh'))
  const profile = profileContext?.dir || process.env.DSH_PROFILE_DIR || process.env.DSH_PROFILE || 'default'
  const key = createHash('sha256').update(`${profile}\0${tzOffsetMinutes}`).digest('hex').slice(0, 24)
  return join(home, 'work-journal', key, 'reports')
}

/**
 * Narrow a panel-supplied kind to a known one.
 * @param value - the request's `kind`, if any.
 * @returns the kind, or undefined to mean "every kind".
 */
function reportKind(value) {
  return REPORT_KINDS.includes(value) ? value : undefined
}

/**
 * Clamp a panel-supplied count into `[1, max]`, treating absence as "no opinion".
 *
 * These values arrive from the browser, so an unbounded `limit` would let one
 * request pull the whole table into memory.
 * @param value - the request's count, if any.
 * @param max - the largest count this endpoint serves.
 * @returns the clamped count, or undefined to use the store's own default.
 */
function optionalCount(value, max) {
  if (!Number.isSafeInteger(value) || value < 1) return undefined
  return Math.min(value, max)
}

export const Config = z.object({
  /** Absolute directory holding `index.json`; empty selects the profile-scoped default. */
  indexDir: z.string().default(''),
  /** UTC offset in minutes for day bucketing; `NaN` uses the host's current offset. */
  tzOffsetMinutes: z.number().default(Number.NaN),
  /** Reuse window before a query triggers a background refresh pass. */
  refreshTtlMs: z.natural().default(60000),
  /** Sessions one scan pass may read before yielding to the next pass. */
  maxSessionsPerScan: z.natural().default(400),
  /** Absolute directory holding generated reports; empty selects the profile-scoped default. */
  reportsDir: z.string().default(''),
  /**
   * Generate day/week/month reports on a calendar schedule.
   *
   * Off by default: scheduled generation spends model tokens unattended, so a
   * deployment opts in explicitly rather than inheriting the cost by upgrading.
   */
  schedule: z.boolean().default(false),
  /** Periods one kind may backfill at startup, bounding a long downtime. */
  maxCatchUp: z.natural().default(31),
  /**
   * Build the local embedding index so the panel can search semantically.
   *
   * On by default because it degrades on its own: a missing dependency or model
   * costs semantic ranking, never the journal. Note the first write on a machine
   * with no cached model downloads ~24 MB from HuggingFace, which is a network
   * dependency inside an otherwise offline 0:00 job — measured at 9.7 s for the
   * first `upsert`. Set false to keep the deployment from ever fetching it, and
   * to keep keyword search the only mode.
   */
  semanticSearch: z.boolean().default(true),
})

const TOOL_DESCRIPTION = [
  'Report what this DSH harness was used for over a calendar period, read from the durable session logs.',
  'Use it whenever the user asks what they did today, yesterday, this week, this month, or "recently" — including "我最近都做了什么" and "总结一下我上周干了什么".',
  'It returns the prompts the user wrote, tool-call counts, files written, commands run, per-day activity windows, and the session list, aggregated by local calendar day and grouped by project.',
  'Every answer carries `complete`; when it is false the store is not fully indexed yet, so say the report may be incomplete rather than implying nothing else happened, and call again (or pass refresh: true) to finish.',
].join(' ')

/** Compose the model-facing tool over one runtime. */
function makeTool(runtime) {
  return defineTool({
    name: 'work_journal',
    description: TOOL_DESCRIPTION,
    parameters: {
      range: {
        type: 'string',
        enum: RANGES,
        description: 'Calendar range: one day, the ISO week, the calendar month, the last N days, or everything indexed. Defaults to day.',
      },
      date: {
        type: 'string',
        description: 'Anchor date as YYYY-MM-DD in local time. Defaults to today; use it for "yesterday" or a specific day.',
      },
      days: {
        type: 'integer',
        description: 'Window size for range "recent". Defaults to 7.',
      },
      project: {
        type: 'string',
        description: 'Optional project filter: a working-directory basename (e.g. "dsh-plugin") or an absolute cwd.',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'json'],
        description: 'markdown (default) for a readable report; json for the structured aggregate.',
      },
      refresh: {
        type: 'boolean',
        description: 'Wait for a fresh scan pass before answering instead of reporting the current index.',
      },
    },
    output: {
      // The canonical value carries the whole aggregate under `report` when the
      // caller asked for JSON, so the declared schema stays a small envelope
      // with `additionalProperties` open rather than mirroring every field.
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          range: { type: 'string' },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          sessions: { type: 'integer' },
          prompts: { type: 'integer' },
          toolCalls: { type: 'integer' },
          markdown: { type: 'string' },
          complete: { type: 'boolean' },
          indexedSessions: { type: 'integer' },
          pendingSessions: { type: 'integer' },
        },
      },
      render: (args, value) => [{
        type: 'text',
        // `report` is `null` unless the caller asked for JSON, so the branch is
        // chosen by the value rather than by re-reading the arguments.
        text: value.report === null ? value.markdown : JSON.stringify(value.report, null, 2),
      }],
      presentationMeta: (_args, value) => ({
        range: value.range,
        startDate: value.startDate,
        endDate: value.endDate,
        sessions: value.sessions,
        prompts: value.prompts,
        toolCalls: value.toolCalls,
      }),
    },
    presentCall: () => ({ card: 'generic', title: '查询工作日志' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? '工作日志查询失败' : '工作日志' }),
    async execute(args) {
      const outcome = await runtime.query({
        range: args.range,
        date: args.date,
        days: args.days,
        project: args.project,
        wait: args.refresh === true,
      })
      const { report } = outcome
      const { index } = outcome
      return {
        range: report.range.kind,
        startDate: report.range.startDate,
        endDate: report.range.endDate,
        sessions: report.totals.sessions,
        prompts: report.totals.prompts,
        toolCalls: report.totals.toolCalls,
        markdown: clipDocument(outcome.markdown),
        // `null`, never `undefined`: a canonical tool value must be lossless
        // JSON, and `undefined` is not a JSON value. The schema types this as
        // `json` so the whole aggregate may travel under it.
        report: args.format === 'json' ? report : null,
        // Completeness travels with every answer: a report built from a
        // partially indexed store must not be read as "nothing else happened".
        complete: index.complete,
        indexedSessions: index.indexed,
        pendingSessions: index.remaining,
      }
    },
  })
}

/** Bound the model-visible document, keeping the head of the report. */
function clipDocument(markdown) {
  if (markdown.length <= MAX_TOOL_CHARS) return markdown
  return `${markdown.slice(0, MAX_TOOL_CHARS)}\n\n…（报告过长已截断；可用 project 过滤或缩小范围）`
}

/** Register the `/journal` command. */
function installCommand(ctx, runtime) {
  return ctx.commands.register({
    name: 'journal',
    description: 'Report what this harness was used for: /journal [day|week|month|recent|all|status|rebuild] [YYYY-MM-DD]',
    recordInput: true,
    async handler({ rawInput }) {
      const tokens = String(rawInput ?? '').trim().split(/\s+/u).filter((token) => token.length > 0)
      const first = (tokens[0] ?? 'day').toLowerCase()
      try {
        if (first === 'status') {
          const status = await runtime.status()
          return { kind: 'success', text: renderStatus(status) }
        }
        if (first === 'rebuild') {
          await runtime.invalidate()
          const result = await runtime.scan()
          return { kind: 'success', text: `已重建索引：读取 ${result.scanned} 个会话，新增/更新 ${result.indexed} 个。` }
        }
        const range = RANGES.includes(first) ? first : 'day'
        const date = /^\d{4}-\d{2}-\d{2}$/u.test(first) ? first : tokens[1]
        const outcome = await runtime.query({ range, date, wait: true })
        return { kind: 'success', text: clipDocument(outcome.markdown) }
      } catch (error) {
        return { kind: 'error', text: `工作日志查询失败：${error?.message ?? error}` }
      }
    },
  })
}

/** Human-readable index health, shared by the command and the panel. */
function renderStatus(status) {
  return [
    `工作日志索引：${status.path}`,
    `已索引 ${status.indexed} / ${status.sessions} 个会话，失败 ${status.failed}，扫描 ${status.scans} 次，上次耗时 ${status.lastScanMs} ms`,
    `上次更新：${status.updatedAt === 0 ? '（尚未扫描）' : new Date(status.updatedAt).toISOString()}`,
    `时区偏移：UTC${status.tzOffsetMinutes >= 0 ? '+' : '-'}${Math.abs(status.tzOffsetMinutes) / 60}`,
  ].join('\n')
}

/**
 * Register the Web panel's route, when a connection service is present.
 *
 * Two transports exist and only one of them works from a plugin row:
 *
 * - `connection.rpc.handle(channel, handler)` resolves the route through
 *   `ctx.webServer`, which a plugin row does not inject, so registering it
 *   throws `cannot get property "webServer" without inject` and the panel's
 *   POST lands on a 405.
 * - `connection.fetch.register({ path, ... })` binds to the connection service's
 *   own context and needs no extra inject.
 *
 * The first is kept only as the fallback for a runtime without `fetch`.
 *
 * @param ctx - Host plugin context.
 * @param runtime - the live query runtime (the model tool's own index).
 * @param reports - the generated-report store, or undefined when it never opened.
 * @param semantic - whether both halves of vector search are available.
 * @param tzOffsetMinutes - the offset the stored periods were bucketed by; sent
 *   with every response so the panel can render a span in the same timezone as
 *   the report body instead of in UTC.
 */
function installRoute(ctx, runtime, reports, semantic, tzOffsetMinutes) {
  const connection = ctx.get('connection')
  if (connection === undefined) return () => {}

  const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } })
  const handler = async (endpoint, payload, signal) => {
    if (signal?.aborted === true) return failure('aborted', 'request aborted')
    try {
      // The generated-report endpoints are the panel's primary data source: a
      // report is written once by the scheduled agent, then listed and read.
      if (endpoint === 'list' || endpoint === 'get' || endpoint === 'search') {
        if (reports === undefined) return failure('unavailable', 'report store is not open')
        const request = payload !== null && typeof payload === 'object' ? payload : {}
        if (endpoint === 'list') {
          const rows = await reports.list({
            kind: reportKind(request.kind),
            limit: optionalCount(request.limit, LIST_MAX),
            offset: optionalCount(request.offset, Number.MAX_SAFE_INTEGER),
          })
          // The offset travels with the rows: a period boundary is only
          // meaningful in the timezone the report was bucketed by, and the
          // browser's own zone is not necessarily that one. Without it the panel
          // renders a span that contradicts the report's own body.
          return { ok: true, value: { reports: rows, tzOffsetMinutes } }
        }
        if (endpoint === 'get') {
          if (typeof request.key !== 'string') return failure('bad-request', 'key is required')
          const found = await reports.get(request.key)
          if (found === undefined) return failure('not-found', `no report for key: ${request.key}`)
          return { ok: true, value: { ...found, tzOffsetMinutes } }
        }
        const query = typeof request.query === 'string' ? request.query : ''
        // A client may ask for a mode this deployment cannot serve: without the
        // native extension or an embedder there is no vector half, and the store
        // refuses `semantic` outright rather than answering emptily. Fall back to
        // keyword so a search box never fails on a capability gap.
        const asked = SEARCH_MODES.includes(request.mode) ? request.mode : 'hybrid'
        const mode = semantic ? asked : 'keyword'
        const hits = await reports.search(query, { mode, limit: optionalCount(request.limit, SEARCH_MAX) })
        return { ok: true, value: { hits, mode, tzOffsetMinutes } }
      }

      if (endpoint === 'status') return { ok: true, value: await runtime.snapshot() }
      if (endpoint !== 'query') return failure('bad-request', `unknown endpoint: ${String(endpoint)}`)
      const request = payload !== null && typeof payload === 'object' ? payload : {}
      const range = typeof request.range === 'string' && RANGES.includes(request.range) ? request.range : 'week'
      const outcome = await runtime.query({
        range,
        date: typeof request.date === 'string' ? request.date : undefined,
        days: Number.isSafeInteger(request.days) ? request.days : undefined,
        project: typeof request.project === 'string' && request.project.length > 0 ? request.project : undefined,
        wait: request.refresh === true,
      })
      return { ok: true, value: { markdown: outcome.markdown, report: outcome.report, index: outcome.index } }
    } catch (error) {
      return failure('failed', error?.message ?? String(error))
    }
  }
  if (!Reflect.has(connection, 'fetch')) {
    const rpc = connection.rpc
    if (rpc === undefined || typeof rpc.handle !== 'function') return () => {}
    return rpc.handle(RPC_CHANNEL, handler)
  }

  return connection.fetch.register({
    path: FETCH_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        return new Response('Expected application/json', { status: 415 })
      }
      const raw = await request.text()
      if (Buffer.byteLength(raw) > 65536) return new Response('Request too large', { status: 413 })
      let body
      try { body = JSON.parse(raw) } catch { return new Response('Invalid JSON', { status: 400 }) }
      const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request'
      const valid = body?.type === 'client-request' && typeof body.rpcId === 'string' && body.method === FETCH_METHOD && Object.hasOwn(body, 'payload')
      // The shared channel carries no per-endpoint method name, so the client
      // names the endpoint inside the payload; positional RPC keeps its own shape.
      const result = valid
        ? await handler(body.payload?.endpoint, body.payload?.payload, request.signal)
        : failure('bad-request', 'invalid request envelope')
      return Response.json({ type: 'server-response', rpcId, result })
    },
  })
}

/**
 * Install the journal.
 *
 * `apply` is async because the runtime loads its index from disk before any
 * consumer can be handed one. Registration is deliberately not deferred behind
 * a floating promise: an effect that registers a tool later than its own
 * activation can outlive the fiber that owns it, and the loader treats a
 * resolved `apply` as "this row contributed what it declares".
 */
export async function apply(ctx, config = {}) {
  // Resolve the offset here, not just inside the runtime: the runtime resolves it
  // before deriving its own directory key, so passing the raw NaN onward would
  // key the reports directory differently from the live index and split one
  // profile's data across two directories.
  const tzOffsetMinutes = Number.isFinite(config.tzOffsetMinutes)
    ? config.tzOffsetMinutes
    : -new Date().getTimezoneOffset()
  const runtime = await installWorkJournal(ctx, {
    indexDir: config.indexDir ?? '',
    tzOffsetMinutes,
    refreshTtlMs: config.refreshTtlMs,
    maxSessionsPerScan: config.maxSessionsPerScan,
  })

  ctx.effect(() => ctx.tools.register(makeTool(runtime)), 'work-journal: model tool')
  ctx.effect(() => installCommand(ctx, runtime), 'work-journal: command')

  // The report store is opened even when nothing schedules reports yet, so the
  // panel can list and search whatever already exists on disk. Failing to open
  // it degrades the panel to the live-query endpoint rather than failing this
  // row: the model tool is the older, still-valid surface.
  const reports = openReports(ctx, config, tzOffsetMinutes)
  ctx.effect(() => installRoute(ctx, runtime, reports.store, reports.semantic, tzOffsetMinutes), 'work-journal: web panel route')
  if (reports.dispose !== undefined) ctx.effect(() => reports.dispose, 'work-journal: report store')

  // Scheduled generation is opt-in. It spends model tokens unattended, so a
  // bare install must not start doing that because this row mounted; the
  // deployment that wants reports says so in its own configuration.
  if (config.schedule === true && reports.store !== undefined) {
    ctx.effect(
      () => installSchedule(ctx, config, reports.store, tzOffsetMinutes),
      'work-journal: report schedule',
    )
  }
}

/**
 * Start the calendar-aligned report schedule.
 *
 * Every collaborator is looked up defensively: a runtime that has the store but
 * not, say, `timer` should log why it is idle rather than fail the whole row.
 * @param ctx - Host plugin context.
 * @param config - the row's validated configuration.
 * @param store - the open report store.
 * @param tzOffsetMinutes - resolved local offset in minutes.
 * @returns a disposer that stops the schedule.
 */
function installSchedule(ctx, config, store, tzOffsetMinutes) {
  const timer = ctx.get('timer')
  const persistence = ctx.get('sessionPersistence')
  const agents = ctx.get('agents')
  if (timer === undefined || persistence === undefined || agents === undefined) {
    ctx.logger?.warn?.('work-journal: report schedule needs timer, sessionPersistence and agents; staying idle')
    return () => {}
  }
  const offset = tzOffsetMinutes
  const directory = typeof config.reportsDir === 'string' && config.reportsDir.length > 0
    ? config.reportsDir
    : defaultReportsDir(ctx.get('profileContext'), tzOffsetMinutes)
  const selected = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (selected === undefined) {
    ctx.logger?.warn?.('work-journal: no default model selection; report schedule staying idle')
    return () => {}
  }

  const reporter = createReporter({
    agents,
    persistence,
    store,
    model: { provider: selected.provider, model: selected.model },
    reportsDir: join(directory, 'reports'),
    logger: ctx.logger,
    tzOffsetMinutes: offset,
    ownerCtx: ctx,
  })
  const scheduler = createScheduler({
    timer,
    tzOffsetMinutes: offset,
    stateDir: join(directory, 'schedule'),
    logger: ctx.logger,
    enabled: true,
    maxCatchUp: config.maxCatchUp,
    run: (kind, key, range, signal) => reporter.generate(kind, key, range, signal),
  })
  // `start()` backfills and then arms the next slot. A rejection here must not
  // take the row down with it: the panel still serves whatever is on disk.
  void scheduler.start().catch((error) => {
    ctx.logger?.warn?.('work-journal: report schedule failed to start: %s', error?.message ?? error)
  })
  return () => { void scheduler.stop().catch(() => {}) }
}

/**
 * Open the generated-report store.
 *
 * Every collaborator here is optional. The journal's original contract is a
 * read-only projection of the session store, and that must keep working on a
 * runtime with no `agents`, no `timer`, and no local embedding model; scheduled
 * report generation is a strictly additive capability.
 * @param ctx - Host plugin context.
 * @param config - the row's validated configuration.
 * @param tzOffsetMinutes - resolved local offset in minutes.
 * @returns `{ store, semantic, dispose }`; `store` is undefined when it could not open.
 */
function openReports(ctx, config, tzOffsetMinutes) {
  const directory = typeof config.reportsDir === 'string' && config.reportsDir.length > 0
    ? config.reportsDir
    : defaultReportsDir(ctx.get('profileContext'), tzOffsetMinutes)
  // Constructing the embedder loads nothing: the model is imported and built on
  // the first `embed`, so a runtime without the dependency (or without a
  // downloaded model) pays nothing until semantic search is actually used.
  const embedder = config.semanticSearch === false
    ? undefined
    : createEmbedder({ cacheDir: join(directory, 'embed') })
  let store
  try {
    store = openReportStore(join(directory, 'index.sqlite'), {
      reportsDir: join(directory, 'reports'),
      // The store owns embedding on write; handing it the function is what makes
      // the vector index populate at all.
      embed: embedder === undefined ? undefined : (texts) => embedder.embed(texts),
      onWarning: (message) => ctx.logger?.warn?.(`work-journal: ${message}`),
    })
  } catch (error) {
    ctx.logger?.warn?.('work-journal: report store unavailable: %s', error?.message ?? error)
    return { store: undefined, semantic: false, dispose: undefined }
  }
  // Semantic search needs both halves: the native extension the store loaded,
  // and an embedder to turn the query into a vector. With either missing the
  // panel must ask for keyword hits rather than a mode that throws.
  const semantic = store.vectorSupport && embedder !== undefined
  const dispose = () => {
    store.close()
    if (embedder !== undefined) void embedder.close().catch(() => {})
  }
  return { store, semantic, dispose }
}

apply.inject = inject
