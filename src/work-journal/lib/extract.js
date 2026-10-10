/**
 * Pure projection from one stored Session log to a work-journal activity record.
 *
 * Nothing here touches the filesystem, a Service, or the clock: the collector
 * hands in a header, the raw event array, and the local UTC offset, and gets
 * back a lossless-JSON record. Keeping the projection pure is what makes the
 * index reproducible — re-projecting the same log with the same offset must
 * yield a byte-identical record, because the incremental collector decides
 * whether to re-project by comparing the stored revision, not the content.
 *
 * Everything the record keeps is bounded. A session log is unbounded (the
 * largest one on this deployment is 21 MB compressed), so the projection keeps
 * only what a report renders: per-day counters, a bounded prompt list, bounded
 * command lines, and the set of files written. It never retains a tool result
 * body, an assistant message body, or an image payload.
 */

/** Record layout of one activity entry; bump when the shape changes. */
export const ACTIVITY_VERSION = 2

/** Longest prompt text kept per message, in characters. */
const PROMPT_MAX_CHARS = 400
/** Prompts kept per session, oldest dropped first. */
const PROMPTS_PER_SESSION = 40
/** Command lines kept per session-day. */
const COMMANDS_PER_DAY = 40
/** Longest command line kept, in characters. */
const COMMAND_MAX_CHARS = 200
/** Tool names whose `file_path` argument counts as a write. */
const WRITE_TOOLS = new Set(['edit', 'write', 'multi_edit', 'notebook_edit', 'apply_patch'])
/** Tool names that are pure bookkeeping and never worth reporting as activity. */
const NOISE_TOOLS = new Set(['todo_write', 'get_goal', 'job_list', 'list_agents'])

/**
 * Local calendar date (`YYYY-MM-DD`) for one epoch-millisecond timestamp.
 *
 * The offset is applied arithmetically rather than through the process
 * timezone, so a record's day buckets do not move when the host's `TZ` changes
 * or when the same store is read from another machine.
 * @param time - Unix epoch milliseconds.
 * @param tzOffsetMinutes - minutes east of UTC (CST is 480).
 * @returns the local date, or undefined when `time` is not a finite number.
 */
export function localDate(time, tzOffsetMinutes) {
  if (!Number.isFinite(time)) return undefined
  return new Date(time + tzOffsetMinutes * 60000).toISOString().slice(0, 10)
}

/**
 * Truncate text to a character budget, marking the cut.
 * @param value - candidate text.
 * @param max - maximum characters to keep.
 * @returns the clipped text, or an empty string for a non-string input.
 */
export function clip(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/**
 * Flatten one message's content blocks to plain text.
 *
 * Only `text` blocks contribute. Image, file, and tool-call blocks are dropped
 * deliberately: a work log records what was asked, not the payload.
 * @param content - the message's content block array.
 * @returns newline-joined text, or an empty string.
 */
function blocksToText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Drop the harness's own instruction paragraphs from a human prompt.
 *
 * A delegated child receives its parent-agent handshake as a second text block
 * on the same `user/message` the human wrote; it is plumbing, not something the
 * person asked for, so a work log must not quote it back as their words.
 * @param text - concatenated prompt text.
 * @returns the prompt text with harness paragraphs removed.
 */
function stripHarnessBoilerplate(text) {
  return text
    .replace(/^Your parent agent id is ".*?"\.[\s\S]*$/mu, '')
    .replace(/^You are a delegated worker\.[\s\S]*$/mu, '')
    .trim()
}

/**
 * Read the tool arguments JSON of one `tool/call` event.
 *
 * The log stores the model's raw argument string, which is not guaranteed to
 * parse (a truncated or malformed call is still recorded). A parse failure
 * yields undefined rather than throwing, so one bad call cannot abort a scan.
 * @param raw - the raw `arguments` string.
 * @returns the parsed object, or undefined.
 */
function parseToolArguments(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The path or pattern one tool call acted on, for the "what did I touch" list.
 * @param name - tool name.
 * @param args - parsed tool arguments, when available.
 * @returns a short target string, or undefined for a tool with no target.
 */
function toolTarget(name, args) {
  if (args === undefined) return undefined
  if (typeof args.file_path === 'string') return args.file_path
  if (typeof args.path === 'string') return args.path
  if (typeof args.pattern === 'string') return args.pattern
  if (typeof args.command === 'string') return clip(args.command, COMMAND_MAX_CHARS)
  if (typeof args.query === 'string') return clip(args.query, COMMAND_MAX_CHARS)
  return undefined
}

/** One day's counters inside an activity record. */
function emptyDay(time, date) {
  return {
    date,
    firstTime: time,
    lastTime: time,
    turns: 0,
    steps: 0,
    prompts: 0,
    toolCalls: 0,
    toolErrors: 0,
    outputTokens: 0,
    tools: {},
    files: {},
    commands: [],
    /**
     * Activity intervals observed on this day, merged into wall-clock time by
     * the report. A day with fifteen concurrent delegated agents is one
     * afternoon of work, not fifteen afternoons, so the raw span sum is not a
     * usable figure on its own.
     */
    spans: [],
  }
}

/** Increment one counter in a plain object map. */
function bump(map, key, by = 1) {
  map[key] = (map[key] ?? 0) + by
}

/**
 * Sequence number of the last fork-inherited event, or -1 for a session that
 * inherited nothing.
 *
 * A fork child's log physically contains its parent's whole history, so
 * counting from seq 0 would report the parent's prompts and tool calls once
 * per child — on this deployment, one heavily forked session appeared four
 * times over. The `session/end-seed` marker carrying `inherited: true` is the
 * exact cut, and the header's `isSeeded` says whether to look for one at all.
 * @param events - the session's raw log in ascending seq order.
 * @param inheritedEventCount - the exact cut from the storage handle, when known.
 * @returns the highest inherited seq, or -1.
 */
function seedCut(events, inheritedEventCount) {
  if (Number.isFinite(inheritedEventCount) && inheritedEventCount > 0) return inheritedEventCount - 1
  let cut = -1
  for (const event of events) {
    if (event?.type === 'session/end-seed' && event.data?.inherited === true) cut = event.seq
  }
  return cut
}

/**
 * Project one stored session log into an activity record.
 *
 * A log with no human input and no tool activity of its own — a seeded fork
 * that was never used, or a session whose only events are structural — yields
 * `undefined`, so the index holds work rather than every id the store minted.
 * @param header - the session header from persistence.
 * @param events - the complete contiguous raw event log.
 * @param options - `tzOffsetMinutes` for day bucketing and an optional
 *   `inheritedEventCount` from the storage handle.
 * @returns the activity record, or undefined when the log holds no own work.
 */
export function projectSession(header, events, options = {}) {
  const tzOffsetMinutes = Number.isFinite(options.tzOffsetMinutes) ? options.tzOffsetMinutes : 0
  const ordered = Array.isArray(events) ? [...events].sort((a, b) => a.seq - b.seq) : []
  const cut = seedCut(ordered, options.inheritedEventCount)
  const depth = Number.isFinite(header.delegationDepth) ? header.delegationDepth : 0
  // A delegated child receives its parent's task description on the same
  // `user/message` event type a human prompt uses. Only a root session's
  // `source.kind === 'user'` text is something the person actually asked for.
  const isChild = header.origin === 'subagent' || depth > 0

  const byDay = {}
  const tools = {}
  const files = {}
  const prompts = []
  const stepStart = new Map()
  const callStart = new Map()
  const totals = {
    turns: 0,
    steps: 0,
    prompts: 0,
    delegated: 0,
    toolCalls: 0,
    toolErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    llmMs: 0,
    toolMs: 0,
  }
  let title
  let firstTime
  let lastTime

  const dayFor = (time) => {
    const date = localDate(time, tzOffsetMinutes)
    if (date === undefined) return undefined
    if (byDay[date] === undefined) byDay[date] = emptyDay(time, date)
    const day = byDay[date]
    if (time < day.firstTime) day.firstTime = time
    if (time > day.lastTime) day.lastTime = time
    return day
  }

  for (const event of ordered) {
    if (event === null || typeof event !== 'object') continue
    // Everything at or before the fork cut belongs to an ancestor session and
    // is already counted there. Its title is still the best label for this
    // child, so that one field is read from the whole log below.
    if (event.seq <= cut) continue
    const time = Number.isFinite(event.time) ? event.time : undefined
    if (time !== undefined) {
      if (firstTime === undefined || time < firstTime) firstTime = time
      if (lastTime === undefined || time > lastTime) lastTime = time
    }
    const data = event.data
    if (data === null || typeof data !== 'object') continue
    const day = time === undefined ? undefined : dayFor(time)

    switch (event.type) {
      case 'session/title': {
        if (typeof data.title === 'string' && data.title.length > 0) title = data.title
        break
      }
      case 'turn/start': {
        totals.turns += 1
        if (day !== undefined) day.turns += 1
        break
      }
      case 'step/start': {
        totals.steps += 1
        if (day !== undefined) day.steps += 1
        if (time !== undefined) stepStart.set(`${data.turn}/${data.step}`, time)
        break
      }
      case 'assistant/message': {
        const key = `${data.turn}/${data.step}`
        const started = stepStart.get(key)
        if (started !== undefined && time !== undefined && time >= started) totals.llmMs += time - started
        const usage = data.usage
        if (usage !== null && typeof usage === 'object') {
          const input = Number(usage.inputTokens)
          const output = Number(usage.outputTokens)
          if (Number.isFinite(input)) totals.inputTokens += input
          if (Number.isFinite(output)) {
            totals.outputTokens += output
            if (day !== undefined) day.outputTokens += output
          }
        }
        break
      }
      case 'tool/call': {
        const name = typeof data.name === 'string' ? data.name : 'unknown'
        totals.toolCalls += 1
        if (day !== undefined) day.toolCalls += 1
        bump(tools, name)
        if (day !== undefined) bump(day.tools, name)
        if (time !== undefined) callStart.set(String(data.callId), time)
        const args = parseToolArguments(data.arguments)
        const target = toolTarget(name, args)
        if (target !== undefined) {
          if (WRITE_TOOLS.has(name)) {
            bump(files, target)
            if (day !== undefined) bump(day.files, target)
          }
          if (name === 'bash' && day !== undefined && day.commands.length < COMMANDS_PER_DAY) {
            day.commands.push(clip(target, COMMAND_MAX_CHARS))
          }
        }
        break
      }
      case 'tool/result': {
        const failed = data.message?.isError === true || (data.error !== null && typeof data.error === 'object')
        if (failed) {
          totals.toolErrors += 1
          if (day !== undefined) day.toolErrors += 1
        }
        const started = callStart.get(String(data.message?.source?.callId))
        if (started !== undefined && time !== undefined && time >= started) totals.toolMs += time - started
        break
      }
      case 'user/message': {
        // Only a human prompt counts. `agent-instructions`, `skill-catalog`,
        // `plugin`, `agent-message`, `goal`, `loopx-continuation`,
        // `skill-invocation`, `subagent-report` and `subagent-settled` all ride
        // the same event type but are harness plumbing, not something the
        // person asked. A child session's `user` message is its parent's task
        // description, so it is counted separately and never listed as a
        // request the user made.
        if (data.source?.kind !== 'user') break
        const text = stripHarnessBoilerplate(blocksToText(data.content))
        if (text.length === 0) break
        if (isChild) {
          totals.delegated += 1
          break
        }
        totals.prompts += 1
        if (day !== undefined) day.prompts += 1
        if (prompts.length < PROMPTS_PER_SESSION) {
          prompts.push({ seq: event.seq, time, date: localDate(time, tzOffsetMinutes), text: clip(text, PROMPT_MAX_CHARS) })
        }
        break
      }
      default:
        break
    }
  }

  // A forked child usually inherits its parent's title and never renames
  // itself, so fall back to the inherited title when the child has none.
  if (title === undefined && cut >= 0) {
    for (const event of ordered) {
      if (event.seq > cut) break
      if (event.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.length > 0) {
        title = event.data.title
      }
    }
  }

  if (totals.prompts === 0 && totals.toolCalls === 0) return undefined

  // `NOISE_TOOLS` are counted in the totals (they did happen) but dropped from
  // the per-tool breakdown, which is what a report renders as "what I used".
  for (const name of NOISE_TOOLS) {
    delete tools[name]
    for (const day of Object.values(byDay)) delete day.tools[name]
  }

  // Merge each day's observed span into the day record, so the report can union
  // overlapping sessions instead of adding them up.
  for (const day of Object.values(byDay)) day.spans = [[day.firstTime, day.lastTime]]

  const days = Object.keys(byDay).sort()
  return {
    version: ACTIVITY_VERSION,
    id: String(header.id),
    title: title ?? '',
    cwd: typeof header.cwd === 'string' ? header.cwd : null,
    createdAt: Number.isFinite(header.createdAt) ? header.createdAt : (firstTime ?? 0),
    origin: isChild ? 'subagent' : 'root',
    depth,
    preset: typeof header.agentPreset === 'string' ? header.agentPreset : null,
    parent: typeof header.parentSession === 'string' ? header.parentSession : null,
    firstTime: firstTime ?? 0,
    lastTime: lastTime ?? (firstTime ?? 0),
    days,
    totals,
    tools,
    files,
    prompts,
    byDay,
  }
}
