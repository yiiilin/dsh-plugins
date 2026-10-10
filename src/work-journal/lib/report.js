/**
 * Aggregation and Markdown rendering over the work-journal index.
 *
 * The index stores one activity record per session; a report is a projection of
 * those records onto a calendar range. Both halves are pure functions of
 * `(index, range)`, so the same range always renders the same report and the
 * model tool, the GUI, and a test all read one implementation.
 */

import { MAX_REPORT_DAYS } from './period.js'

/** Project label used when a session recorded no working directory. */
const NO_PROJECT = '(未知目录)'
/** Files and tools listed before a report starts eliding. */
const TOP_FILES = 25
const TOP_TOOLS = 12
const TOP_COMMANDS = 20
/** Prompts a single report inlines before it points at the session list. */
const MAX_REPORT_PROMPTS = 60

/**
 * Format an integer with thousands separators, without depending on `Intl`.
 * @param value - the number to format.
 * @returns the grouped decimal string.
 */
export function formatInt(value) {
  const n = Number.isFinite(value) ? Math.round(value) : 0
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/gu, ',')
}

/**
 * Format a duration as hours and minutes.
 * @param ms - duration in milliseconds.
 * @returns a compact human duration such as `9 小时 28 分`.
 */
export function formatDuration(ms) {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 60000) : 0
  if (total < 1) return '不足 1 分钟'
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  if (hours === 0) return `${minutes} 分钟`
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分`
}

/**
 * Format one epoch-millisecond instant as local wall-clock `HH:MM`.
 * @param time - Unix epoch milliseconds.
 * @param tzOffsetMinutes - minutes east of UTC.
 * @returns the local time, or an empty string for a non-finite input.
 */
export function formatClock(time, tzOffsetMinutes) {
  if (!Number.isFinite(time)) return ''
  return new Date(time + tzOffsetMinutes * 60000).toISOString().slice(11, 16)
}

/**
 * Short project label for a working directory.
 * @param cwd - absolute session working directory, or null.
 * @returns the final path segment.
 */
export function projectOf(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return NO_PROJECT
  const parts = cwd.split(/[\\/]/u).filter((part) => part.length > 0)
  return parts.length === 0 ? NO_PROJECT : parts[parts.length - 1]
}

/** Sort a `{key: count}` map into a descending `[{key, count}]` list. */
function ranked(map, limit) {
  const list = Object.entries(map ?? {}).map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
  return limit === undefined ? list : list.slice(0, limit)
}

/** Merge one `{key: count}` map into an accumulator. */
function mergeCounts(target, source) {
  for (const [key, count] of Object.entries(source ?? {})) target[key] = (target[key] ?? 0) + count
}

/**
 * Total wall-clock time covered by a set of intervals.
 *
 * Concurrency is the reason this exists: fifteen delegated agents running at
 * once are one afternoon of work, so summing their individual spans would
 * report fifteen afternoons. Unioning the intervals answers "how much of the
 * day had something running", which is what a person means by time worked.
 * @param spans - `[start, end]` pairs in epoch milliseconds.
 * @returns the union's total duration in milliseconds.
 */
export function unionDuration(spans) {
  const sorted = (spans ?? [])
    .filter((span) => Array.isArray(span) && Number.isFinite(span[0]) && Number.isFinite(span[1]) && span[1] >= span[0])
    .sort((a, b) => a[0] - b[0])
  let total = 0
  let currentStart
  let currentEnd
  for (const [start, end] of sorted) {
    if (currentEnd === undefined) {
      currentStart = start
      currentEnd = end
      continue
    }
    if (start <= currentEnd) {
      if (end > currentEnd) currentEnd = end
      continue
    }
    total += currentEnd - currentStart
    currentStart = start
    currentEnd = end
  }
  if (currentEnd !== undefined) total += currentEnd - currentStart
  return total
}

/**
 * Project the index onto one inclusive calendar range.
 *
 * A session contributes only the days that fall inside the range, so a session
 * that ran across midnight — or across a week boundary — is counted on both
 * sides without double-counting either day.
 * @param index - the stored index document.
 * @param range - a resolved range from `resolveRange`.
 * @returns the aggregated report value (lossless JSON).
 */
export function aggregate(index, range) {
  const tz = index?.tzOffsetMinutes ?? 0
  const inRange = new Set(range.dates)
  const days = new Map()
  const projects = new Map()
  const tools = {}
  const files = {}
  const commands = new Map()
  const sessions = []
  const prompts = []
  const totals = {
    days: 0,
    sessions: 0,
    childSessions: 0,
    turns: 0,
    steps: 0,
    prompts: 0,
    delegated: 0,
    toolCalls: 0,
    toolErrors: 0,
    outputTokens: 0,
    llmMs: 0,
    toolMs: 0,
    activeMs: 0,
  }

  const dayOf = (date) => {
    if (!days.has(date)) {
      days.set(date, {
        date,
        sessions: 0,
        turns: 0,
        steps: 0,
        prompts: 0,
        toolCalls: 0,
        toolErrors: 0,
        outputTokens: 0,
        firstTime: undefined,
        lastTime: undefined,
        tools: {},
        files: {},
        commands: [],
        promptTexts: [],
        spans: [],
      })
    }
    return days.get(date)
  }

  for (const activity of Object.values(index?.activities ?? {})) {
    const activeDates = (activity.days ?? []).filter((date) => inRange.has(date))
    if (activeDates.length === 0) continue

    const project = projectOf(activity.cwd)
    if (!projects.has(project)) {
      projects.set(project, {
        project,
        cwd: activity.cwd ?? null,
        sessions: 0,
        turns: 0,
        steps: 0,
        prompts: 0,
        toolCalls: 0,
        outputTokens: 0,
        llmMs: 0,
        toolMs: 0,
        files: {},
        tools: {},
        /**
         * Commands are tracked per project, not only per day. A day mixes every
         * project's shell history, so a project-filtered report built from the
         * day's list would show another project's commands.
         */
        commands: {},
      })
    }
    const projectEntry = projects.get(project)
    projectEntry.sessions += 1

    if (activity.origin === 'subagent') totals.childSessions += 1
    else totals.sessions += 1
    let sessionToolCalls = 0
    let sessionPrompts = 0
    let sessionFirst
    let sessionLast

    for (const date of activeDates) {
      const source = activity.byDay[date]
      const day = dayOf(date)
      day.sessions += 1
      day.turns += source.turns ?? 0
      day.steps += source.steps ?? 0
      day.prompts += source.prompts ?? 0
      day.toolCalls += source.toolCalls ?? 0
      day.toolErrors += source.toolErrors ?? 0
      day.outputTokens += source.outputTokens ?? 0
      if (day.firstTime === undefined || source.firstTime < day.firstTime) day.firstTime = source.firstTime
      if (day.lastTime === undefined || source.lastTime > day.lastTime) day.lastTime = source.lastTime
      for (const span of source.spans ?? [[source.firstTime, source.lastTime]]) day.spans.push(span)
      mergeCounts(day.tools, source.tools)
      mergeCounts(day.files, source.files)
      for (const command of source.commands ?? []) {
        if (!day.commands.includes(command)) day.commands.push(command)
        commands.set(command, (commands.get(command) ?? 0) + 1)
        projectEntry.commands[command] = (projectEntry.commands[command] ?? 0) + 1
      }
      totals.turns += source.turns ?? 0
      totals.steps += source.steps ?? 0
      totals.prompts += source.prompts ?? 0
      totals.toolCalls += source.toolCalls ?? 0
      totals.toolErrors += source.toolErrors ?? 0
      totals.outputTokens += source.outputTokens ?? 0
      projectEntry.turns += source.turns ?? 0
      projectEntry.steps += source.steps ?? 0
      projectEntry.prompts += source.prompts ?? 0
      projectEntry.toolCalls += source.toolCalls ?? 0
      projectEntry.outputTokens += source.outputTokens ?? 0
      mergeCounts(projectEntry.files, source.files)
      mergeCounts(projectEntry.tools, source.tools)
      sessionToolCalls += source.toolCalls ?? 0
      sessionPrompts += source.prompts ?? 0
      if (sessionFirst === undefined || source.firstTime < sessionFirst) sessionFirst = source.firstTime
      if (sessionLast === undefined || source.lastTime > sessionLast) sessionLast = source.lastTime
    }

    mergeCounts(tools, activity.tools)
    mergeCounts(files, activity.files)
    totals.delegated += activity.totals?.delegated ?? 0
    projectEntry.llmMs += activity.totals?.llmMs ?? 0
    projectEntry.toolMs += activity.totals?.toolMs ?? 0
    totals.llmMs += activity.totals?.llmMs ?? 0
    totals.toolMs += activity.totals?.toolMs ?? 0

    sessions.push({
      id: activity.id,
      title: activity.title,
      project,
      cwd: activity.cwd ?? null,
      origin: activity.origin,
      preset: activity.preset,
      days: activeDates,
      firstTime: sessionFirst ?? activity.firstTime,
      lastTime: sessionLast ?? activity.lastTime,
      prompts: sessionPrompts,
      toolCalls: sessionToolCalls,
    })

    for (const prompt of activity.prompts ?? []) {
      if (prompt.date === undefined || !inRange.has(prompt.date)) continue
      prompts.push({
        time: prompt.time,
        date: prompt.date,
        sessionId: activity.id,
        sessionTitle: activity.title,
        project,
        text: prompt.text,
      })
      const day = dayOf(prompt.date)
      if (day.promptTexts.length < 20) day.promptTexts.push({ time: prompt.time, project, text: prompt.text })
    }
  }

  const dayList = [...days.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((day) => ({
      ...day,
      activeMs: unionDuration(day.spans),
      spanMs: day.firstTime === undefined || day.lastTime === undefined ? 0 : Math.max(0, day.lastTime - day.firstTime),
    }))
  totals.days = dayList.length
  totals.activeMs = dayList.reduce((sum, day) => sum + day.activeMs, 0)

  prompts.sort((a, b) => a.time - b.time)
  sessions.sort((a, b) => b.lastTime - a.lastTime)

  return {
    range: {
      kind: range.kind,
      startDate: range.startDate,
      endDate: range.endDate,
      label: range.label,
      truncated: range.truncated === true,
    },
    tzOffsetMinutes: tz,
    generatedAt: Date.now(),
    totals,
    days: dayList,
    projects: [...projects.values()].sort((a, b) => b.toolCalls - a.toolCalls || b.sessions - a.sessions),
    tools: ranked(tools, TOP_TOOLS).map(({ key, count }) => ({ name: key, count })),
    files: ranked(files, TOP_FILES).map(({ key, count }) => ({ path: key, count })),
    commands: [...commands.entries()].map(([command, count]) => ({ command, count })).sort((a, b) => b.count - a.count).slice(0, TOP_COMMANDS),
    sessions,
    prompts: prompts.slice(0, MAX_REPORT_PROMPTS),
    promptCount: prompts.length,
  }
}

/**
 * Render one aggregated report as Markdown.
 * @param report - the value returned by {@link aggregate}.
 * @param options - `heading` for the report title and `source` for a provenance line.
 * @returns the Markdown document.
 */
export function renderMarkdown(report, options = {}) {
  const tz = report.tzOffsetMinutes
  const lines = []
  const title = options.heading ?? `工作日志 · ${report.range.label}`
  lines.push(`# ${title}`, '')

  const source = options.source
  if (typeof source === 'string' && source.length > 0) lines.push(`> ${source}`, '')

  const { totals } = report
  if (totals.sessions === 0 && totals.childSessions === 0) {
    lines.push('这个时间段没有记录到任何 DSH 活动。', '')
    return lines.join('\n')
  }

  lines.push('## 概览', '')
  lines.push(`- 活跃天数：${totals.days} 天`)
  lines.push(`- 活跃时长：${formatDuration(totals.activeMs)}（按会话区间合并，已扣除并行重叠）`)
  lines.push(`- 主会话：${formatInt(totals.sessions)} 个；子 agent 会话：${formatInt(totals.childSessions)} 个`)
  lines.push(`- 轮次 ${formatInt(totals.turns)} / 步骤 ${formatInt(totals.steps)}`)
  lines.push(`- 我提的需求：${formatInt(totals.prompts)} 条（另派发子 agent 任务 ${formatInt(totals.delegated)} 次）`)
  lines.push(`- 工具调用：${formatInt(totals.toolCalls)} 次（失败 ${formatInt(totals.toolErrors)}）`)
  lines.push(`- 模型输出：${formatInt(totals.outputTokens)} tokens`)
  lines.push(`- 涉及项目：${report.projects.map((entry) => entry.project).join('、')}`)
  lines.push('')

  lines.push('## 我提的需求', '')
  if (report.prompts.length === 0) {
    lines.push('（无）', '')
  } else {
    for (const prompt of report.prompts) {
      const clock = formatClock(prompt.time, tz)
      lines.push(`- \`${prompt.date} ${clock}\` **${prompt.project}** — ${prompt.text.replace(/\n+/gu, ' ')}`)
    }
    if (report.promptCount > report.prompts.length) lines.push(`- …其余 ${formatInt(report.promptCount - report.prompts.length)} 条已省略`)
    lines.push('')
  }

  if (report.days.length > 1) {
    lines.push('## 每日分布', '')
    lines.push('| 日期 | 活跃时段 | 活跃时长 | 会话 | 需求 | 工具调用 | 输出 tokens |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const day of report.days) {
      const span = day.firstTime === undefined ? '—' : `${formatClock(day.firstTime, tz)}–${formatClock(day.lastTime, tz)}`
      lines.push(`| ${day.date} | ${span} | ${formatDuration(day.activeMs)} | ${day.sessions} | ${day.prompts} | ${day.toolCalls} | ${formatInt(day.outputTokens)} |`)
    }
    lines.push('')
  }

  lines.push('## 项目分布', '')
  lines.push('| 项目 | 会话 | 需求 | 轮次 | 工具调用 | 输出 tokens |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const project of report.projects) {
    lines.push(`| ${project.project} | ${project.sessions} | ${project.prompts} | ${project.turns} | ${project.toolCalls} | ${formatInt(project.outputTokens)} |`)
  }
  lines.push('')

  if (report.files.length > 0) {
    lines.push('## 改动的文件', '')
    for (const file of report.files) lines.push(`- \`${file.path}\` × ${file.count}`)
    lines.push('')
  }

  if (report.tools.length > 0) {
    lines.push('## 工具使用', '')
    lines.push(report.tools.map((tool) => `${tool.name} × ${tool.count}`).join('、'), '')
  }

  if (report.commands.length > 0) {
    lines.push('## 执行过的命令', '')
    for (const entry of report.commands) lines.push(`- \`${entry.command}\`${entry.count > 1 ? ` × ${entry.count}` : ''}`)
    lines.push('')
  }

  lines.push('## 会话清单', '')
  for (const session of report.sessions) {
    const clock = session.firstTime === undefined ? '' : `${formatClock(session.firstTime, tz)}–${formatClock(session.lastTime, tz)}`
    const label = session.title.length > 0 ? session.title : session.id
    const mark = session.origin === 'subagent' ? '（子 agent）' : ''
    lines.push(`- **${label}**${mark} · ${session.project} · ${clock} · 需求 ${session.prompts} · 工具 ${session.toolCalls}`)
  }
  lines.push('')
  if (report.range.truncated) lines.push(`> 范围超过 ${MAX_REPORT_DAYS} 天，仅统计前 ${MAX_REPORT_DAYS} 天。`, '')

  return lines.join('\n')
}
