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

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installWorkJournal } from './lib/runtime.js'

export const name = 'work-journal'
export const inject = ['tools', 'commands', 'sessionPersistence']

/** RPC channel the Web panel posts to. */
const RPC_CHANNEL = '/work-journal'
/** Longest Markdown document the tool returns to the model. */
const MAX_TOOL_CHARS = 24000
/** Range kinds the tool and the panel accept. */
const RANGES = ['day', 'week', 'month', 'recent', 'all']

export const Config = z.object({
  /** Absolute directory holding `index.json`; empty selects the profile-scoped default. */
  indexDir: z.string().default(''),
  /** UTC offset in minutes for day bucketing; `NaN` uses the host's current offset. */
  tzOffsetMinutes: z.number().default(Number.NaN),
  /** Reuse window before a query triggers a background refresh pass. */
  refreshTtlMs: z.natural().default(60000),
  /** Sessions one scan pass may read before yielding to the next pass. */
  maxSessionsPerScan: z.natural().default(400),
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

/** Register the Web panel's RPC channel, when a connection service is present. */
function installRoute(ctx, runtime) {
  const connection = ctx.get('connection')
  const rpc = connection?.rpc
  if (rpc === undefined || typeof rpc.handle !== 'function') return () => {}

  const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } })
  const handler = async (endpoint, payload, signal) => {
    if (signal?.aborted === true) return failure('aborted', 'request aborted')
    try {
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
  return rpc.handle(RPC_CHANNEL, handler)
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
  const runtime = await installWorkJournal(ctx, {
    indexDir: config.indexDir ?? '',
    tzOffsetMinutes: Number.isFinite(config.tzOffsetMinutes) ? config.tzOffsetMinutes : Number.NaN,
    refreshTtlMs: config.refreshTtlMs,
    maxSessionsPerScan: config.maxSessionsPerScan,
  })

  ctx.effect(() => ctx.tools.register(makeTool(runtime)), 'work-journal: model tool')
  ctx.effect(() => installCommand(ctx, runtime), 'work-journal: command')
  ctx.effect(() => installRoute(ctx, runtime), 'work-journal: web panel route')
}

apply.inject = inject
