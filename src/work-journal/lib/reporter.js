/**
 * journal-agent report generation for the work journal (T3).
 *
 * The journal already projects the session store into structural facts
 * (`lib/extract.js`). This module turns those facts into the prose a person
 * actually reads: it reads the sessions that overlap one calendar range,
 * hands the bounded material to a single one-shot DSH agent, and stores the
 * Markdown that comes back.
 *
 * Three properties drive the design:
 *
 * - **One model, one pass.** The user asked for "一个模型，一个 agent 扫描 dsh
 *   记录，然后生成总结". There is deliberately no retrieve-then-summarize
 *   pipeline and no per-session model call: every overlapping session becomes
 *   material for one prompt, and the report is whatever that one agent writes.
 *   A per-session pass would multiply cost by the session count and still need
 *   a second synthesis pass to produce a readable document.
 *
 * - **The reporter must not read its own output.** The agent this module
 *   creates is itself a DSH session, written to the same store it scans. Left
 *   alone it would appear in the next range, and the day after that the report
 *   would be a summary of the previous summary. This is a measured defect on
 *   this deployment, not a theoretical one, so it is defended twice: every
 *   agent this module creates is stamped with `meta.agentPreset = presetName`
 *   and every scan skips sessions carrying that stamp; and the handle is
 *   disposed, which removes the session from the store. The stamp is the one
 *   that survives a crash mid-run, so the exclusion is the load-bearing half.
 *
 * - **A failure is a recorded report, not a missing one.** Every runtime
 *   failure writes a `status: 'failed'` metadata document carrying the reason,
 *   so the panel can show "why is yesterday missing" and the scheduler's
 *   catch-up pass retries it. Nothing here throws at the caller except a
 *   malformed argument, which is a programming error with no report to record.
 *
 * Frozen contract: /tmp/wj-team/INTERFACE.md.
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { projectSession } from './extract.js'

/** Report kinds the store accepts; mirrored here so a caller bug fails loud. */
const REPORT_KINDS = Object.freeze(['day', 'week', 'month'])
/**
 * Report keys become filenames (`reports/<kind>/<key>.md`). Kept identical to
 * the store's own rule so an invalid key is rejected before any work starts
 * rather than after a model call.
 */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
/** Date shape accepted as a range fallback. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u

/** Preset stamp on the report agent; also the exclusion key for scans. */
const DEFAULT_PRESET_NAME = 'yiln-work-journal'
/** Sessions one report may read. Bounds the prompt and the scan cost. */
const DEFAULT_MAX_SESSIONS = 300
/** Wall-clock budget for one report before the agent is cancelled. */
const DEFAULT_TIMEOUT_MS = 600000
/** Sessions read concurrently; matches the collector's own read default. */
const READ_CONCURRENCY = 4
/** Characters one session may contribute to the prompt. */
const SESSION_MATERIAL_CHARS = 4000
/** Characters the whole material may contribute, oldest sessions dropped first. */
const TOTAL_MATERIAL_CHARS = 120000
/** Prompts quoted per session in the material. */
const PROMPTS_PER_SESSION = 12
/** Files and commands listed per session in the material. */
const FILES_PER_SESSION = 30
const COMMANDS_PER_SESSION = 20

/**
 * What the report agent is asked to produce.
 *
 * The instruction not to write a provenance header is deliberate: the header
 * is prepended by {@link renderProvenance} so that "data source and generation
 * time" is guaranteed present even when the model ignores instructions, and
 * asking the model for it too would duplicate the block.
 */
const REPORT_INSTRUCTIONS = [
  '你是一个工作日志分析助手。你的唯一输入是下面给出的 DSH 会话日志素材。',
  '请只依据素材撰写中文 Markdown 报告，不要编造素材里没有的文件、命令或结论；素材不足以判断时明确写"素材未体现"。',
  '报告必须包含以下四个二级标题，顺序固定：',
  '## 概览 —— 用 3~6 句话概括这段时间实际做了什么、涉及哪些项目。',
  '## 做了什么事 —— 按项目分组，逐条列出具体改动、运行的命令、解决的问题。',
  '## 关键决策 —— 从素材中能看出的技术选择与取舍；没有就写"素材未体现明显决策"。',
  '## 遗留问题 —— 未完成、报错、或明显待办的事项；没有就写"无"。',
  '不要在报告里添加数据来源、生成时间或模型信息（系统会统一添加）。',
  '只输出 Markdown 报告本身，不要写任何解释或开场白。',
].join('\n')

/**
 * Build a reporter over one store and one session source.
 *
 * `persistence` and `store` are hard dependencies and are validated here,
 * because a reporter without them can never produce a report. `agents` is
 * validated lazily instead: a deployment that temporarily lacks the agent
 * service should still load the plugin and record *why* reports fail, rather
 * than fail the Loader row and take the panel down with it.
 *
 * @param options - wiring; see the frozen contract.
 * @returns the reporter handle.
 */
export function createReporter(options = {}) {
  const {
    agents,
    persistence,
    store,
    embedder,
    model,
    reportsDir,
    logger,
    presetName = DEFAULT_PRESET_NAME,
    maxSessions = DEFAULT_MAX_SESSIONS,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    // The projection buckets days by an explicit offset; it does not affect
    // which sessions are included, only the day labels inside the material.
    tzOffsetMinutes = 0,
    cwd = process.cwd(),
    now = Date.now,
    createSessionId = defaultSessionId,
    ownerCtx,
    write = writeFileAtomic,
  } = options

  if (persistence === null || typeof persistence !== 'object' || typeof persistence.list !== 'function') {
    throw new TypeError('work-journal: reporter requires the sessionPersistence service')
  }
  if (store === null || typeof store !== 'object' || typeof store.upsert !== 'function') {
    throw new TypeError('work-journal: reporter requires an open report store')
  }
  if (typeof presetName !== 'string' || presetName.length === 0) {
    throw new TypeError('work-journal: reporter presetName must be a non-empty string')
  }
  if (!Number.isSafeInteger(maxSessions) || maxSessions <= 0) {
    throw new TypeError('work-journal: reporter maxSessions must be a positive integer')
  }
  if (!Number.isFinite(tzOffsetMinutes)) {
    throw new TypeError('work-journal: reporter tzOffsetMinutes must be a finite number')
  }

  // The store owns the Markdown/metadata file pair (it writes them atomically
  // beside the index). Writing them here as well would race that commit and
  // could leave a `.md` from one run beside a `.json` from another, so the
  // fallback only runs for a store that does not own files at all.
  const storeOwnsFiles = typeof store.reportsDir === 'string' && store.reportsDir.length > 0
  if (storeOwnsFiles && typeof reportsDir === 'string' && reportsDir.length > 0 && reportsDir !== store.reportsDir) {
    logger?.warn?.(`work-journal: reporter reportsDir "${reportsDir}" differs from the store's "${store.reportsDir}"; the store's path wins`)
  }

  // Degradation is stated once, at wiring time: "semantic search is off" and
  // "semantic search silently returns nothing" are different operational facts.
  //
  // The store owns embedding: it was opened with an `embed` function and calls
  // it inside `upsert`, so this module never embeds a body itself. The embedder
  // handle passed here is therefore only a diagnostic input — it says whether
  // the caller wired one at all, which is the case where the store would have
  // had nothing to embed with.
  if (embedder === undefined || embedder === null) {
    logger?.info?.('work-journal: no embedder configured; reports are indexed for keyword search only')
  } else if (store.vectorSupport === false) {
    logger?.warn?.('work-journal: sqlite-vec is unavailable in this store; report embeddings will be skipped')
  }

  /** Snapshot the provenance every stored report must carry. */
  const modelInfo = {
    provider: typeof model?.provider === 'string' && model.provider.length > 0 ? model.provider : null,
    model: typeof model?.model === 'string' && model.model.length > 0 ? model.model : null,
  }
  // An empty route is meaningful: it means "use the harness default", so the
  // field is omitted rather than sent as an empty provider the adapter rejects.
  const agentOptions = modelInfo.provider === null && modelInfo.model === null
    ? undefined
    : { ...(modelInfo.provider === null ? {} : { provider: modelInfo.provider }), ...(modelInfo.model === null ? {} : { model: modelInfo.model }) }

  /**
   * Create the report agent through whichever creation seam this runtime has.
   *
   * The registry's public verb is `create(options)` (it binds ownership to the
   * registry's own context). `createAgent(ownerCtx, options)` is the factory
   * interface underneath it, so it is the fallback for a runtime that exposes
   * only that.
   */
  const createOwnedAgent = async (creation) => {
    if (agents === null || typeof agents !== 'object') {
      throw new Error('work-journal: the agent service is unavailable; cannot generate a report')
    }
    if (typeof agents.create === 'function') return agents.create(creation)
    if (typeof agents.createAgent === 'function') return agents.createAgent(ownerCtx ?? agents.ctx, creation)
    throw new Error('work-journal: the agent service exposes neither create() nor createAgent()')
  }

  /**
   * Record a failed run.
   *
   * The body is empty on purpose: the store refuses to overwrite an existing
   * good Markdown with a failed run's empty body, so a retry that fails after a
   * success leaves the readable report in place and only flips the status.
   */
  const recordFailure = async (base, error, sessionCount) => {
    const message = messageOf(error)
    const failed = { ...base, status: 'failed', sessionCount, error: message }
    try {
      await store.upsert(failed, '')
    } catch (writeError) {
      // Nothing left to record the failure with; the caller still gets it.
      logger?.error?.(`work-journal: could not record the failed report ${base.key}: ${messageOf(writeError)}`)
    }
    return { ok: false, key: base.key, sessionCount, error: message }
  }

  /**
   * Generate one report.
   *
   * Argument errors (unknown kind, malformed key, unusable range) throw: they
   * are caller bugs and there is no metadata shape to record them in. Every
   * runtime failure is returned as `{ ok: false }` with a `failed` document
   * already written.
   *
   * @param kind - `day`, `week`, or `month`.
   * @param key - the report key (`2026-10-12`, `2026-W41`, `2026-09`).
   * @param range - the span; `{ startTime, endTime }` epoch ms, or `start`/
   *   `end`, or `startDate`/`endDate` as `YYYY-MM-DD` in `tzOffsetMinutes`.
   * @param callSignal - optional cancellation for this run.
   * @returns the outcome summary.
   */
  const generate = async (kind, key, range, callSignal) => {
    assertKind(kind)
    assertKey(key)
    const window = normalizeRange(range, tzOffsetMinutes)
    const generatedAt = Math.trunc(now())
    // Every stored document carries a terminal status. `generating` is accepted
    // by the store but is deliberately never written from here: the store only
    // protects an existing Markdown from a `failed` run's empty body, so a
    // `generating` marker would blank a readable report for the duration of a
    // regeneration and lose it entirely if the process died. A crashed run
    // leaves the previous document intact and the next catch-up pass retries.
    const base = {
      version: 1,
      key,
      kind,
      label: window.label ?? key,
      startTime: window.startTime,
      endTime: window.endTime,
      generatedAt,
      model: modelInfo,
      sessionCount: 0,
      error: null,
    }

    // One timeout per run, unref'd so a pending report never holds the process
    // open at shutdown; a caller signal is fused rather than replaced so either
    // side can stop the run.
    const timeout = new AbortController()
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => timeout.abort(new Error(`报告生成超时（${timeoutMs} ms）`)), timeoutMs)
      : undefined
    timer?.unref?.()
    const runSignal = callSignal === undefined
      ? timeout.signal
      : (signal === undefined ? AbortSignal.any([callSignal, timeout.signal]) : AbortSignal.any([callSignal, signal, timeout.signal]))

    let handle
    let sessionCount = 0
    try {
      const collected = await collectSessions(persistence, {
        window,
        presetName,
        maxSessions,
        tzOffsetMinutes,
        signal: runSignal,
        logger,
      })
      sessionCount = collected.activities.length

      if (collected.activities.length === 0) {
        // No sessions means no evidence, and a model asked to summarize nothing
        // invents something. The deterministic empty report is both cheaper and
        // more truthful.
        const body = `${renderProvenance({ window, stats: collected, generatedAt, modelInfo, tzOffsetMinutes, maxSessions })}\n\n## 概览\n\n本区间内没有记录到会话活动。\n\n## 做了什么事\n\n无。\n\n## 关键决策\n\n无。\n\n## 遗留问题\n\n无。\n`
        const meta = { ...base, status: 'ok', sessionCount: 0, error: null }
        await persist(meta, body)
        return { ok: true, key, sessionCount: 0, error: null }
      }

      const material = renderMaterial(collected.activities, tzOffsetMinutes)
      const prompt = [
        REPORT_INSTRUCTIONS,
        '',
        `报告区间：${window.label ?? key}（${formatLocal(window.startTime, tzOffsetMinutes)} ~ ${formatLocal(window.endTime, tzOffsetMinutes)}）`,
        `纳入会话：${collected.activities.length} 个（扫描 ${collected.scanned} 个，排除本插件自身会话 ${collected.skippedPreset} 个）`,
        '',
        '--- 以下是会话日志素材 ---',
        '',
        material,
      ].join('\n')

      const sessionId = createSessionId(kind, key)
      handle = await createOwnedAgent({
        sessionId,
        // `agentPreset` is the anti-self-contamination stamp: the next scan
        // skips every session carrying it, so this report can never become
        // tomorrow's input. `origin` is deliberately absent — this is a
        // top-level one-shot session, not a delegated child, and `subagent`
        // would make the journal count its prompt as delegated work.
        meta: { cwd, agentPreset: presetName, delegationDepth: 0 },
        ...(agentOptions === undefined ? {} : { agentOptions }),
      })
      const agent = handle.agent

      // A model failure surfaces as an `agent/error` dispatch, and the loop's
      // driver swallows it (it resolves `whenIdle` either way). Listening here
      // is what turns "the report is empty" into a report that says why.
      let agentFailure
      agent?.ctx?.on?.('agent/error', (payload) => {
        if (payload?.agent !== undefined && payload.agent !== agent) return
        agentFailure = payload?.error
      })

      // Aborting the signal alone cannot stop a hung turn: `whenIdle` resolves
      // from the loop's own driver, which a provider that never answers leaves
      // running. Cancelling the agent is what actually retires the turn and lets
      // `whenIdle` settle, so the two are wired together. This mirrors the
      // Mentor's request-timeout handling for the same reason.
      const cancelOnAbort = () => {
        try {
          agent?.cancel?.({ kind: 'hook', reason: 'work-journal report run aborted' })
        } catch (error) {
          logger?.warn?.(`work-journal: could not cancel the report agent: ${messageOf(error)}`)
        }
      }
      if (runSignal.aborted === true) cancelOnAbort()
      else runSignal.addEventListener('abort', cancelOnAbort, { once: true })

      const message = createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'work-journal-reporter' } })
      try {
        agent.followup(message)
        // Raced against the signal so that even a `whenIdle` that never settles
        // releases the run; losing the race is a timeout, not a hang.
        await raceSignal(agent.whenIdle(), runSignal, timeout.signal)
      } finally {
        runSignal.removeEventListener('abort', cancelOnAbort)
      }
      if (runSignal.aborted === true) throw runSignal.reason ?? new Error('报告生成已取消')

      const events = typeof agent.session?.ownEvents === 'function' ? agent.session.ownEvents() : []
      const text = finalAssistantText(events)
      if (text.length === 0) {
        const reason = turnFailure(events) ?? agentFailure
        throw new Error(reason === undefined ? '报告 agent 未产出内容' : `报告 agent 未产出内容：${messageOf(reason)}`)
      }

      const body = `${renderProvenance({ window, stats: collected, generatedAt, modelInfo, tzOffsetMinutes, maxSessions })}\n\n${text.trim()}\n`
      const meta = { ...base, status: 'ok', sessionCount: collected.activities.length, error: null }
      await persist(meta, body)
      return { ok: true, key, sessionCount: meta.sessionCount, error: null }
    } catch (error) {
      logger?.warn?.(`work-journal: report ${kind}/${key} failed: ${messageOf(error)}`)
      return await recordFailure(base, error, sessionCount)
    } finally {
      clearTimeout(timer)
      // Disposal removes the agent's own session from the store, which is the
      // second half of the anti-self-contamination defence. It must not be able
      // to fail the report, which is already decided above.
      if (handle !== undefined) {
        try {
          await handle.dispose()
        } catch (error) {
          logger?.warn?.(`work-journal: could not dispose the report agent: ${messageOf(error)}`)
        }
      }
    }
  }

  /**
   * Store one report, writing the file pair when the store does not.
   *
   * The store's `upsert` already embeds the body when it was opened with an
   * `embed` function, so the embedder passed here is not re-run: doing it twice
   * would double the ONNX work for one report and produce a vector the store
   * never receives (the frozen `upsert` takes no vector argument).
   */
  const persist = async (meta, body) => {
    if (storeOwnsFiles || typeof reportsDir !== 'string' || reportsDir.length === 0) {
      await store.upsert(meta, body)
      return
    }
    await write(join(reportsDir, meta.kind, `${meta.key}.md`), body, { mode: 0o600, dirMode: 0o700 })
    await write(join(reportsDir, meta.kind, `${meta.key}.json`), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    await store.upsert(meta, body)
  }

  return { generate, presetName, reportsDir: storeOwnsFiles ? store.reportsDir : reportsDir }
}

/**
 * Read every session that overlaps one range.
 *
 * Two filters run in sequence, and the order matters. The cheap one drops
 * sessions created *after* the range — a session cannot contain activity that
 * predates its own creation, so that direction is exact and needs no log read.
 * The expensive one projects the log and tests the observed activity window,
 * which correctly keeps a long-lived session that was created before the range
 * but worked inside it.
 *
 * The approximation that remains is the cap: candidates are ordered newest
 * first and only `maxSessions` are read, so a session created long before the
 * range but active inside it can be pushed past the cap on a very large store.
 * The alternative — reading every log before the range — is exactly the
 * full-store walk this module is built to avoid. Truncation is reported in the
 * provenance rather than hidden.
 *
 * @param persistence - the session persistence service.
 * @param options - the range, filters, and read budget.
 * @returns the activities, their provenance counters, and the truncation flag.
 */
async function collectSessions(persistence, options) {
  const { window, presetName, maxSessions, tzOffsetMinutes, signal, logger } = options
  const snapshots = await persistence.list(signal === undefined ? undefined : { signal })

  const candidates = []
  let skippedPreset = 0
  for (const snapshot of snapshots) {
    const header = snapshot?.header
    if (header === null || typeof header !== 'object') continue
    // The anti-self-contamination rule. This is the whole defence against the
    // report-of-a-report failure mode: the agent that writes reports is itself
    // a session in this store, so its own sessions are never material.
    if (header.agentPreset === presetName) {
      skippedPreset += 1
      continue
    }
    const createdAt = Number(header.createdAt)
    const created = Number.isFinite(createdAt) ? createdAt : 0
    if (created > window.endTime) continue
    candidates.push({ id: String(header.id), header, createdAt: created })
  }
  candidates.sort((left, right) => right.createdAt - left.createdAt)
  const truncated = candidates.length > maxSessions
  const budget = candidates.slice(0, maxSessions)

  const activities = []
  let unreadable = 0
  let cursor = 0
  const worker = async () => {
    while (cursor < budget.length) {
      if (signal?.aborted === true) throw signal.reason ?? new Error('报告生成已取消')
      const candidate = budget[cursor]
      cursor += 1
      try {
        const loaded = await readSession(persistence, candidate.id, signal)
        const activity = projectSession(loaded.header ?? candidate.header, loaded.events, {
          tzOffsetMinutes,
          inheritedEventCount: loaded.inheritedEventCount,
        })
        if (activity === undefined) continue
        if (!overlaps(activity, candidate.createdAt, window)) continue
        activities.push(activity)
      } catch (error) {
        // One unreadable log must not lose the report: it is counted and named,
        // and the sessions that could be read still become material.
        unreadable += 1
        logger?.warn?.(`work-journal: could not read session ${candidate.id}: ${messageOf(error)}`)
      }
    }
  }
  const workers = []
  for (let index = 0; index < Math.min(READ_CONCURRENCY, budget.length); index += 1) workers.push(worker())
  await Promise.all(workers)
  if (signal?.aborted === true) throw signal.reason ?? new Error('报告生成已取消')

  activities.sort((left, right) => left.firstTime - right.firstTime || left.id.localeCompare(right.id))
  return { activities, scanned: snapshots.length, skippedPreset, unreadable, truncated, considered: candidates.length }
}

/**
 * Read one stored session through a read handle.
 *
 * `inheritedEventCount` travels beside the header because a fork child's log
 * physically contains its parent's history; without the exact cut the material
 * would quote the parent's prompts once per child.
 */
async function readSession(persistence, id, signal) {
  const handle = await persistence.open(id, 'read', signal === undefined ? undefined : { signal })
  try {
    const result = await handle.read(0, undefined, signal === undefined ? undefined : { signal })
    return {
      header: handle.header,
      events: Array.isArray(result?.events) ? result.events : [],
      inheritedEventCount: handle.inheritedEventCount,
    }
  } finally {
    await handle.close()
  }
}

/** Whether one projected activity has any observed work inside the range. */
function overlaps(activity, createdAt, window) {
  const first = activity.firstTime
  const last = activity.lastTime
  // A log whose events carry no timestamps projects a zero span; the creation
  // time is then the only evidence of when it happened.
  if (!(last > 0)) return createdAt >= window.startTime && createdAt <= window.endTime
  return first <= window.endTime && last >= window.startTime
}

/** Render one activity as prompt material. */
function renderActivity(activity, tzOffsetMinutes) {
  const lines = [
    `### 会话 ${activity.id}（项目：${projectLabel(activity.cwd)}）`,
    `- 标题：${activity.title === '' ? '(无标题)' : activity.title}`,
    `- 类型：${activity.origin === 'subagent' ? `子会话（委派深度 ${activity.depth}）` : '主会话'}`,
    `- 时间：${formatLocal(activity.firstTime, tzOffsetMinutes)} ~ ${formatLocal(activity.lastTime, tzOffsetMinutes)}`,
    `- 统计：请求 ${activity.totals.prompts}，委派任务 ${activity.totals.delegated}，轮次 ${activity.totals.turns}，工具调用 ${activity.totals.toolCalls}（失败 ${activity.totals.toolErrors}），输出 token ${activity.totals.outputTokens}`,
  ]
  if (activity.prompts.length > 0) {
    lines.push('- 用户请求：')
    for (const prompt of activity.prompts.slice(0, PROMPTS_PER_SESSION)) lines.push(`  - ${clip(prompt.text, 400)}`)
  }
  const files = Object.keys(activity.files)
  if (files.length > 0) lines.push(`- 改动文件：${files.slice(0, FILES_PER_SESSION).join(', ')}`)
  const commands = collectCommands(activity)
  if (commands.length > 0) {
    lines.push('- 运行过的命令：')
    for (const command of commands.slice(0, COMMANDS_PER_SESSION)) lines.push(`  - \`${command}\``)
  }
  const tools = Object.entries(activity.tools)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 10)
    .map(([name, count]) => `${name}×${count}`)
  if (tools.length > 0) lines.push(`- 工具：${tools.join(', ')}`)
  const text = lines.join('\n')
  return text.length <= SESSION_MATERIAL_CHARS ? text : `${text.slice(0, SESSION_MATERIAL_CHARS - 1)}…`
}

/** Join every activity's material, bounded so one huge store cannot flood the prompt. */
function renderMaterial(activities, tzOffsetMinutes) {
  const blocks = []
  let total = 0
  for (const activity of activities) {
    const block = renderActivity(activity, tzOffsetMinutes)
    if (total + block.length > TOTAL_MATERIAL_CHARS) {
      blocks.push(`（素材已达 ${TOTAL_MATERIAL_CHARS} 字符上限，其余 ${activities.length - blocks.length} 个会话未纳入本次提示。）`)
      break
    }
    blocks.push(block)
    total += block.length + 2
  }
  return blocks.join('\n\n')
}

/** Every command line the activity recorded, in day order. */
function collectCommands(activity) {
  const commands = []
  for (const date of Object.keys(activity.byDay ?? {}).sort()) {
    for (const command of activity.byDay[date].commands ?? []) commands.push(command)
  }
  return commands
}

/**
 * The provenance block every report opens with.
 *
 * It is written by this module rather than requested from the model so that
 * "where did this come from and when was it made" is present on a report the
 * model wrote badly, or on a report the model never saw (the empty range).
 */
function renderProvenance({ window, stats, generatedAt, modelInfo, tzOffsetMinutes, maxSessions }) {
  const lines = [
    `> 数据来源：DSH 会话日志（sessionPersistence 只读扫描；扫描 ${stats.scanned} 个会话，纳入 ${stats.activities.length} 个，排除本插件自身会话 ${stats.skippedPreset} 个）`,
    `> 报告区间：${formatLocal(window.startTime, tzOffsetMinutes)} ~ ${formatLocal(window.endTime, tzOffsetMinutes)}`,
    `> 生成时间：${new Date(generatedAt).toISOString()}（${formatLocal(generatedAt, tzOffsetMinutes)}）`,
    `> 模型：${modelInfo.provider === null && modelInfo.model === null ? '(默认路由)' : `${modelInfo.provider ?? '(默认)'} / ${modelInfo.model ?? '(默认)'}`}`,
  ]
  if (stats.truncated) lines.push(`> ⚠️ 区间内候选会话超过上限 ${maxSessions}，仅统计最近的 ${maxSessions} 个，报告可能不完整。`)
  if (stats.unreadable > 0) lines.push(`> ⚠️ 有 ${stats.unreadable} 个会话日志无法读取，未纳入本次报告。`)
  return lines.join('\n')
}

/**
 * The last non-empty assistant message, else the accumulated streamed text.
 *
 * This mirrors the harness's own selection rule for a child's final output
 * rather than reusing it, because importing `dsh-subagent` would make the
 * reporter depend on a delegation service it never delegates through.
 */
function finalAssistantText(events) {
  if (!Array.isArray(events)) return ''
  let message
  const partial = []
  for (const event of events) {
    if (event?.type === 'assistant/message') {
      const text = textOfContent(event.data?.message?.content)
      if (text.length > 0) message = text
      const streamed = joinStreamText(event.data?.stream)
      if (streamed.length > 0) partial.push(streamed)
    } else if (event?.type === 'assistant/attempt') {
      const streamed = joinStreamText(event.data?.stream)
      if (streamed.length > 0) partial.push(streamed)
    }
  }
  return message ?? partial.join('')
}

/** Concatenate the text blocks of one message's content. */
function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
  }
  return parts.join('\n')
}

/** Concatenate the visible text carried by one durable assistant stream. */
function joinStreamText(stream) {
  if (!Array.isArray(stream)) return ''
  const parts = []
  for (const record of stream) {
    if (record?.type === 'text-chunks' && Array.isArray(record.texts)) parts.push(record.texts.join(''))
    else if (record?.type === 'chunk' && record.chunk?.type === 'text-delta' && typeof record.chunk.text === 'string') parts.push(record.chunk.text)
  }
  return parts.join('')
}

/** The reason the last turn ended, when it did not complete. */
function turnFailure(events) {
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'turn/end') continue
    const reason = event.data?.reason
    if (reason === undefined || reason.kind === 'completed') return undefined
    return reason.kind === undefined ? reason : `${reason.kind}${typeof reason.message === 'string' ? `: ${reason.message}` : ''}`
  }
  return undefined
}

/**
 * Resolve a report range into an epoch-millisecond window.
 *
 * Epoch milliseconds are the primary form because that is what the scheduler
 * computes from the calendar. Date strings are accepted as a convenience and
 * converted through the same explicit UTC offset the projection buckets days
 * with, so a range means the same window regardless of the host's `TZ`.
 */
function normalizeRange(range, tzOffsetMinutes) {
  if (range === null || typeof range !== 'object') {
    throw new TypeError('work-journal: generate() requires a range object')
  }
  const startTime = resolveEdge(range.startTime ?? range.start, range.startDate, 'startTime', tzOffsetMinutes)
  const endTime = resolveEdge(range.endTime ?? range.end, range.endDate, 'endTime', tzOffsetMinutes)
  if (startTime > endTime) throw new TypeError('work-journal: report range startTime must not be after endTime')
  return {
    startTime,
    endTime,
    label: typeof range.label === 'string' && range.label.length > 0 ? range.label : undefined,
  }
}

/** Resolve one end of a range from an epoch value or a local date string. */
function resolveEdge(epoch, date, name, tzOffsetMinutes) {
  if (Number.isFinite(epoch)) return Math.trunc(epoch)
  if (typeof date === 'string' && DATE_PATTERN.test(date)) {
    const [year, month, day] = date.split('-').map(Number)
    const midnight = Date.UTC(year, month - 1, day) - tzOffsetMinutes * 60000
    return name === 'endTime' ? midnight + 86399999 : midnight
  }
  throw new TypeError(`work-journal: report range is missing a numeric ${name}`)
}

/** Reject a kind the store cannot key, before any work starts. */
function assertKind(kind) {
  if (!REPORT_KINDS.includes(kind)) throw new TypeError(`work-journal: unknown report kind: ${JSON.stringify(kind)}`)
}

/** Reject a key that could not become a filename segment. */
function assertKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new TypeError(`work-journal: invalid report key: ${JSON.stringify(key)}`)
  }
}

/** A collision-free session id for one report run. */
function defaultSessionId(kind, key) {
  return `work-journal-${kind}-${key}-${randomUUID()}`
}

/** Short project label for a working directory, matching the runtime's. */
function projectLabel(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return '(未知目录)'
  const parts = cwd.split(/[\\/]/u).filter((part) => part.length > 0)
  return parts.length === 0 ? '(未知目录)' : parts[parts.length - 1]
}

/** Local wall-clock stamp (`YYYY-MM-DD HH:mm:ss`) for one instant. */
function formatLocal(time, tzOffsetMinutes) {
  if (!Number.isFinite(time)) return '(未知时间)'
  return new Date(time + tzOffsetMinutes * 60000).toISOString().replace('T', ' ').slice(0, 19)
}

/** Truncate text to a character budget, marking the cut. */
function clip(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Await `work`, or reject as soon as one of the signals aborts.
 *
 * `agent.whenIdle()` resolves from the loop's own driver, so a provider that
 * accepts a request and never answers leaves it pending indefinitely. Racing it
 * against the abort signal is what turns "hung" into "timed out and recorded".
 * The loser is not cancelled here — the caller has already cancelled the agent
 * — and a later rejection of the abandoned promise is swallowed so it cannot
 * surface as an unhandled rejection.
 * @param work - the pending operation.
 * @param signals - signals that end the wait early.
 * @returns the operation's result when it wins the race.
 */
function raceSignal(work, ...signals) {
  const pending = Promise.resolve(work)
  // Always keep a rejection handler attached: the operation may still reject
  // after the race was lost.
  pending.catch(() => undefined)
  const aborted = signals.find((candidate) => candidate?.aborted === true)
  if (aborted !== undefined) return Promise.reject(aborted.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    const listeners = []
    const settle = (callback, value) => {
      for (const [candidate, listener] of listeners) candidate.removeEventListener('abort', listener)
      callback(value)
    }
    for (const candidate of signals) {
      if (candidate === undefined) continue
      const listener = () => settle(reject, candidate.reason ?? new Error('aborted'))
      candidate.addEventListener('abort', listener, { once: true })
      listeners.push([candidate, listener])
    }
    pending.then((value) => settle(resolve, value), (error) => settle(reject, error))
  })
}

/** Extract a printable message from an unknown thrown value. */
function messageOf(error) {
  if (error instanceof Error) return error.message
  if (error === null || error === undefined) return 'unknown error'
  try {
    return typeof error === 'string' ? error : JSON.stringify(error)
  } catch {
    return String(error)
  }
}
