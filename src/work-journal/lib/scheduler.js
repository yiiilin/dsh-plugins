/**
 * Calendar-aligned scheduling for generated work-journal reports.
 *
 * Reports describe *calendar periods*, not elapsed windows: the daily report
 * covers yesterday, the weekly report covers the seven days that ended on
 * Friday, and the monthly report covers the previous calendar month. A
 * `setInterval(86_400_000)` cannot express that. It drifts across suspend,
 * resume, and restart, so after a few weeks it fires at noon and covers a
 * "day" that is not a calendar day at all — and a process that was down for a
 * month has no way to notice the reports it never produced.
 *
 * So every occurrence is derived from the calendar, and each fire schedules the
 * next one from the instant it was *due* rather than from the instant it
 * happened to run. A report that takes minutes to generate, a machine that
 * slept through midnight, and a process that was restarted all still produce
 * the range their slot names.
 *
 * Three more properties are load-bearing:
 *
 * - **Nothing is lost and nothing grows without bound.** A single `state.json`
 *   records, per kind, the last key that was generated contiguously. Startup
 *   enumerates the periods that should exist but do not, in chronological
 *   order, and backfills them — bounded by `maxCatchUp`, because a machine that
 *   was off for a year must not try to generate 365 daily reports at boot.
 * - **A failure is a hole, not a crash.** A failed run never rejects out of the
 *   scheduler and never advances that kind's watermark, so the failed period
 *   and everything after it stay pending and are retried at the next start.
 *   Regenerating a period is safe because a report is a keyed upsert.
 * - **One kind runs at a time.** The next occurrence of a kind is armed only
 *   after its previous run settles, so a slow generation delays that kind's
 *   next report instead of overlapping it.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { addDays, endOfMonth, localDateOf, startOfMonth } from './period.js'

/** Report kinds this scheduler generates, each on its own calendar boundary. */
export const SCHEDULE_KINDS = Object.freeze(['day', 'week', 'month'])
/** Periods a first run may backfill before only the most recent ones are caught up. */
export const DEFAULT_MAX_CATCH_UP = 31
/** Layout version of the persisted state document; a mismatch restarts from nothing. */
export const STATE_VERSION = 1

const DAY_MS = 86400000
const LAST_MS_OF_DAY = DAY_MS - 1
/** Weekly periods examined when enumerating missing reports; the cap trims most of them. */
const WEEK_LOOKBACK = 8
/** Monthly periods examined when enumerating missing reports. */
const MONTH_LOOKBACK = 12

/** Stable tie-break for entries that share a start instant (a week starts 00:00 like a day). */
const KIND_ORDER = Object.freeze({ day: 0, week: 1, month: 2 })

/** Extract a printable message from an unknown thrown value. */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Weekday of a calendar date, Sunday = 0, matching `Date#getUTCDay`. */
function weekday(date) {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay()
}

/**
 * Epoch milliseconds of local midnight on a calendar date.
 *
 * The offset is a fixed number of minutes, so a local day is always exactly
 * 86 400 000 ms long and no daylight-saving discontinuity has to be handled —
 * the same assumption `period.js` makes when it steps dates.
 * @param date - local calendar date as `YYYY-MM-DD`.
 * @param tzOffsetMinutes - minutes east of UTC.
 * @returns the instant that date began locally.
 */
function localMidnight(date, tzOffsetMinutes) {
  const [year, month, day] = date.split('-').map(Number)
  return Date.UTC(year, month - 1, day) - tzOffsetMinutes * 60000
}

/** Shift a `YYYY-MM-01` string by whole months, rolling the year over. */
function addMonths(firstOfMonth, months) {
  const [year, month] = firstOfMonth.split('-').map(Number)
  const total = year * 12 + (month - 1) + months
  const shiftedYear = Math.floor(total / 12)
  const shiftedMonth = ((total % 12) + 12) % 12 + 1
  return `${String(shiftedYear).padStart(4, '0')}-${String(shiftedMonth).padStart(2, '0')}-01`
}

/**
 * ISO-8601 week label (`YYYY-Www`) of a calendar date.
 *
 * The key must sort chronologically as a plain string, because the watermark is
 * compared lexicographically; zero-padding the week number gives that, and ISO
 * week years agree with calendar years for every week this scheduler can name.
 * @param date - local calendar date as `YYYY-MM-DD`.
 * @returns the ISO week label.
 */
function isoWeek(date) {
  const [year, month, day] = date.split('-').map(Number)
  const target = new Date(Date.UTC(year, month - 1, day))
  const dayNum = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNum + 3)
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3)
  const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * DAY_MS))
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/**
 * The report range a fire at one instant is responsible for.
 *
 * The instant is the slot's due time, never "now": a late timer, a suspended
 * process, and an in-process catch-up all resolve the period their slot names.
 * @param kind - `day`, `week`, or `month`.
 * @param at - the slot's due instant, epoch milliseconds.
 * @param tzOffsetMinutes - minutes east of UTC.
 * @returns `{ kind, key, label, startDate, endDate, startTime, endTime }`.
 */
export function reportRange(kind, at, tzOffsetMinutes) {
  const date = localDateOf(at, tzOffsetMinutes)
  let startDate
  let endDate
  let key
  let label
  if (kind === 'day') {
    startDate = addDays(date, -1)
    endDate = startDate
    key = startDate
    label = startDate
  } else if (kind === 'week') {
    // The seven days of the most recently *completed* Saturday-to-Friday week.
    // Anchoring on the Saturday boundary rather than on "the last Friday before
    // this instant" is what makes enumeration step one week at a time: the
    // boundary at or before the slot names the week that just ended, and the
    // slot seven days earlier names the one before it. A Saturday slot
    // therefore reports yesterday as its final day, so the weekly report lands
    // on the same morning as the daily report covering that same day.
    const weekStart = addDays(date, -((weekday(date) - 6 + 7) % 7))
    endDate = addDays(weekStart, -1)
    startDate = addDays(endDate, -6)
    key = isoWeek(endDate)
    label = `${startDate} ~ ${endDate}`
  } else if (kind === 'month') {
    startDate = addMonths(startOfMonth(date), -1)
    endDate = endOfMonth(startDate)
    key = startDate.slice(0, 7)
    label = key
  } else {
    throw new TypeError(`work-journal: unknown schedule kind: ${JSON.stringify(kind)}`)
  }
  return {
    kind,
    key,
    label,
    startDate,
    endDate,
    startTime: localMidnight(startDate, tzOffsetMinutes),
    endTime: localMidnight(endDate, tzOffsetMinutes) + LAST_MS_OF_DAY,
  }
}

/**
 * The next occurrence of a kind, strictly after an instant.
 *
 * Strictness matters: at exactly Saturday 00:00:00.000 the slot that just
 * became due is *this* Saturday's, so the next one is a week later. Without it
 * a timer that fires on time would immediately re-arm a zero-delay timer for
 * the same slot and generate the same report forever.
 * @param kind - `day`, `week`, or `month`.
 * @param from - epoch milliseconds to be strictly after.
 * @param tzOffsetMinutes - minutes east of UTC.
 * @returns the next due instant, epoch milliseconds.
 */
export function nextFireAfter(kind, from, tzOffsetMinutes) {
  const date = localDateOf(from, tzOffsetMinutes)
  if (kind === 'day') return localMidnight(addDays(date, 1), tzOffsetMinutes)
  if (kind === 'week') {
    let ahead = (6 - weekday(date) + 7) % 7
    if (ahead === 0) ahead = 7
    return localMidnight(addDays(date, ahead), tzOffsetMinutes)
  }
  if (kind === 'month') {
    const [year, month] = date.split('-').map(Number)
    const nextYear = month === 12 ? year + 1 : year
    const nextMonth = month === 12 ? 1 : month + 1
    return localMidnight(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01`, tzOffsetMinutes)
  }
  throw new TypeError(`work-journal: unknown schedule kind: ${JSON.stringify(kind)}`)
}

/**
 * The most recent occurrence of a kind at or before an instant.
 *
 * Enumerating missing reports must start from a *slot*, not from `now`:
 * `reportRange` names a different period depending on which slot it is given,
 * so asking it about an arbitrary instant mid-week (or mid-month) names a
 * period that no slot will ever ask for, and the report it describes would be
 * listed as missing forever. A slot is inclusive: starting exactly on Saturday
 * 00:00 means that Saturday's weekly report is already due.
 * @param kind - `day`, `week`, or `month`.
 * @param at - epoch milliseconds.
 * @param tzOffsetMinutes - minutes east of UTC.
 * @returns the most recent slot instant at or before `at`.
 */
function currentSlot(kind, at, tzOffsetMinutes) {
  const date = localDateOf(at, tzOffsetMinutes)
  if (kind === 'day') return localMidnight(date, tzOffsetMinutes)
  if (kind === 'week') {
    const back = (weekday(date) - 6 + 7) % 7
    return localMidnight(addDays(date, -back), tzOffsetMinutes)
  }
  if (kind === 'month') return localMidnight(startOfMonth(date), tzOffsetMinutes)
  throw new TypeError(`work-journal: unknown schedule kind: ${JSON.stringify(kind)}`)
}

/**
 * The slot one calendar period before a given slot.
 *
 * Slot spacing is a whole period at a fixed UTC offset, so day and week steps
 * are exact milliseconds and only the month step needs the calendar. Walking
 * back slot by slot keeps every enumeration step on a real boundary; for a
 * month the day-of-month is immaterial, because the range only reads the month
 * the slot falls in.
 * @param kind - `day`, `week`, or `month`.
 * @param at - a slot instant, epoch milliseconds.
 * @param tzOffsetMinutes - minutes east of UTC.
 * @returns the preceding slot instant.
 */
function previousFire(kind, at, tzOffsetMinutes) {
  if (kind === 'day') return at - DAY_MS
  if (kind === 'week') return at - 7 * DAY_MS
  if (kind === 'month') return localMidnight(addMonths(localDateOf(at, tzOffsetMinutes), -1), tzOffsetMinutes)
  throw new TypeError(`work-journal: unknown schedule kind: ${JSON.stringify(kind)}`)
}

/** Resolve the injected timer service into a `(callback, delay) -> dispose` function. */
function resolveTimer(timer) {
  if (timer !== null && typeof timer === 'object' && typeof timer.setTimeout === 'function') {
    return (callback, delay) => timer.setTimeout(callback, delay)
  }
  if (timer !== null && typeof timer === 'object' && typeof timer.timeout === 'function') {
    return (callback, delay) => timer.timeout(callback, delay)
  }
  // A bare function is accepted so a test can inject the smallest possible
  // clock, and because `ctx.timer` is itself a service whose methods are
  // sometimes handed over already bound.
  if (typeof timer === 'function') return (callback, delay) => timer(callback, delay)
  throw new TypeError('work-journal: scheduler requires a timer with setTimeout(callback, delay)')
}

/** An empty state document. */
function emptyState() {
  return { version: STATE_VERSION, runs: {} }
}

/**
 * Create the scheduler.
 *
 * @param options - injected dependencies.
 * @param options.timer - the timer service (`ctx.timer`), required unless disabled.
 * @param options.stateDir - directory holding `state.json`.
 * @param options.run - `(kind, key, range, signal) => Promise<void>`; the
 *   actual generation action, owned by the caller so this module never depends
 *   on the report stack.
 * @param options.tzOffsetMinutes - local offset in minutes east of UTC.
 * @param options.now - clock override for tests.
 * @param options.logger - `ctx.logger` or anything with `warn`/`info`.
 * @param options.enabled - `false` installs the scheduler inert.
 * @param options.maxCatchUp - periods backfilled at startup, default 31.
 * @param options.readFile - injected state reader, for tests.
 * @param options.writeFile - injected atomic writer, for tests.
 * @returns `{ start, stop, nextFireAt, pending, settled, statePath }`.
 */
export function createScheduler(options = {}) {
  const enabled = options.enabled !== false
  const run = options.run
  if (typeof run !== 'function') throw new TypeError('work-journal: scheduler requires a run(kind, key, range, signal) function')
  const stateDir = options.stateDir
  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    throw new TypeError('work-journal: scheduler requires a stateDir')
  }
  // A disabled scheduler never arms anything, so it must not require a timer
  // at all: a deployment that turns scheduling off should not fail to install
  // on a runtime where the timer service happens to be absent.
  const timer = enabled ? resolveTimer(options.timer) : () => () => {}
  const now = typeof options.now === 'function' ? options.now : Date.now
  const tzOffsetMinutes = Number.isFinite(options.tzOffsetMinutes)
    ? options.tzOffsetMinutes
    : -new Date().getTimezoneOffset()
  const maxCatchUp = Number.isSafeInteger(options.maxCatchUp) && options.maxCatchUp > 0
    ? options.maxCatchUp
    : DEFAULT_MAX_CATCH_UP
  const logger = options.logger
  const readFileImpl = options.readFile ?? readFile
  const writeFileImpl = options.writeFile ?? writeFileAtomic
  const statePath = join(stateDir, 'state.json')

  // A logger must never be able to break the schedule, so every call is
  // isolated: this module's job is to keep generating reports, not to report.
  const warn = (...args) => { try { logger?.warn?.(...args) } catch { /* ignore */ } }
  const info = (...args) => { try { logger?.info?.(...args) } catch { /* ignore */ } }

  let state = emptyState()
  let started = false
  /** True once a start has happened, even after a later stop. */
  let hasStarted = false
  let stopped = false
  let controller
  let startupPending = []

  /** Dispose handles for the armed timer of each kind. */
  const timers = {}
  /** Target instant each kind's armed timer is waiting for. */
  const armed = {}
  /** Last target instant each kind actually handled. */
  const lastTarget = {}
  /** In-flight `run` call per kind, so a kind never runs twice at once. */
  const inFlight = {}
  /** Whole fire chain per kind, so `settled()` can wait for the re-arm too. */
  const chains = {}
  /**
   * Set when a run for a kind failed in this session. The kind's watermark is
   * then frozen for the rest of the session, because advancing it would step
   * over the failed period and orphan it: the next start would never see it
   * again. Freezing regenerates the periods after the hole instead, which is
   * safe (keyed upsert) and bounded by `maxCatchUp`.
   */
  const blocked = {}

  const readState = async () => {
    try {
      const parsed = JSON.parse(await readFileImpl(statePath, 'utf8'))
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== STATE_VERSION) return emptyState()
      const runs = parsed.runs !== null && typeof parsed.runs === 'object' ? parsed.runs : {}
      const adopted = {}
      for (const kind of SCHEDULE_KINDS) {
        const key = runs[kind]
        if (typeof key === 'string' && key.length > 0) adopted[kind] = key
      }
      return { version: STATE_VERSION, runs: adopted }
    } catch (error) {
      // A missing state file is the normal first-run state. A corrupt one is
      // also recoverable: the worst it can cost is regenerating reports that
      // already exist, which are keyed upserts.
      if (error?.code !== 'ENOENT') {
        warn('work-journal: discarding unreadable scheduler state at %s: %s', statePath, messageOf(error))
      }
      return emptyState()
    }
  }

  const saveState = async () => {
    try {
      await writeFileImpl(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    } catch (error) {
      // Losing the watermark costs a regeneration at the next start, which is
      // not worth failing the report that was just generated.
      warn('work-journal: could not persist scheduler state at %s: %s', statePath, messageOf(error))
    }
  }

  /** Advance one kind's watermark, never backwards. */
  const recordSuccess = async (kind, key) => {
    const previous = state.runs[kind]
    if (previous !== undefined && previous >= key) return
    state.runs[kind] = key
    await saveState()
  }

  /**
   * Enumerate the reports that should exist but do not, oldest first.
   *
   * Walking back one period at a time from the most recent due key is what
   * makes the watermark a *contiguous* record: the first key at or below it
   * proves every older period was generated too, so enumeration can stop there
   * instead of scanning a horizon for every kind on every boot.
   *
   * The result is capped at `maxCatchUp` overall, but never at the cost of a
   * whole kind: the newest period of each kind is always kept, and the
   * remaining slots go to the newest periods across all kinds. A machine that
   * was off for a month therefore still produces a monthly report rather than
   * spending its entire budget on thirty daily ones.
   */
  const computePending = () => {
    if (!enabled) return []
    const at = now()
    const perKind = new Map()
    for (const kind of SCHEDULE_KINDS) {
      const watermark = state.runs[kind]
      // Daily periods accumulate one per day, so their horizon is the catch-up
      // budget itself; weekly and monthly periods are few enough that a fixed
      // lookback is already more than any outage worth reporting on.
      const horizon = kind === 'day' ? maxCatchUp : kind === 'week' ? WEEK_LOOKBACK : MONTH_LOOKBACK
      const list = []
      // Start on the most recent *slot*, or the enumeration would name a period
      // that lies between two slots and could never be cleared.
      let cursor = currentSlot(kind, at, tzOffsetMinutes)
      for (let step = 0; step < horizon; step += 1) {
        const range = reportRange(kind, cursor, tzOffsetMinutes)
        if (watermark !== undefined && range.key <= watermark) break
        list.push({ kind, key: range.key, range })
        cursor = previousFire(kind, cursor, tzOffsetMinutes)
      }
      perKind.set(kind, list)
    }

    const chosen = []
    const seen = new Set()
    const take = (entry) => {
      const id = `${entry.kind}\0${entry.key}`
      if (seen.has(id)) return
      seen.add(id)
      chosen.push(entry)
    }
    // One slot per kind first (newest period of each), then the remaining slots
    // go to the newest periods overall. A cap smaller than the kind count can
    // only honour that partially, which is why the strict check bounds it.
    // Each `list` is newest-first, because enumeration walks backwards in time.
    for (const kind of SCHEDULE_KINDS) {
      if (chosen.length >= maxCatchUp) break
      const list = perKind.get(kind)
      const newest = list[0]
      if (newest !== undefined) take(newest)
    }
    const merged = [...perKind.values()].flat().sort((left, right) => right.range.startTime - left.range.startTime
      || KIND_ORDER[right.kind] - KIND_ORDER[left.kind]
      || right.key.localeCompare(left.key))
    for (const entry of merged) {
      if (chosen.length >= maxCatchUp) break
      take(entry)
    }
    const dropped = merged.length - chosen.length
    if (dropped > 0) {
      warn(
        'work-journal: %d scheduled report(s) are more than maxCatchUp=%d behind; catching up only the most recent %d',
        dropped,
        maxCatchUp,
        chosen.length,
      )
    }
    return chosen.sort((left, right) => left.range.startTime - right.range.startTime
      || KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
      || left.key.localeCompare(right.key))
  }

  /**
   * Run one report, serialized per kind and recording the watermark only for a
   * contiguous success.
   *
   * A second request for a kind that is already running is *queued*, never
   * dropped: a dropped fire is a missing report that nothing will retry, which
   * is the one outcome this module exists to prevent.
   */
  const runOne = (kind, key, range) => {
    const previous = inFlight[kind] ?? Promise.resolve()
    const task = (async () => {
      await previous
      try {
        await run(kind, key, range, controller.signal)
        if (blocked[kind] !== true) await recordSuccess(kind, key)
      } catch (error) {
        blocked[kind] = true
        warn('work-journal: %s report for %s failed: %s', kind, key, messageOf(error))
      }
    })()
    inFlight[kind] = task
    const release = () => { if (inFlight[kind] === task) delete inFlight[kind] }
    // Both callbacks are supplied so the derived promise can never surface as
    // an unhandled rejection; `task` itself never rejects either.
    task.then(release, release)
    return task
  }

  const arm = (kind) => {
    if (stopped || !started) return
    // Scheduled from the previous *target*, not from now: if the process slept
    // or the last report ran long, the missed slots are already in the past and
    // this arms a zero-delay timer that produces them in order.
    const target = nextFireAfter(kind, lastTarget[kind] ?? now(), tzOffsetMinutes)
    armed[kind] = target
    const delay = Math.max(0, target - now())
    const dispose = timer(() => {
      // The whole chain is tracked, not just the run: `settled()` must not
      // return while the kind is un-armed, or a test could stop the scheduler
      // in the window between its run finishing and its next timer existing.
      const chain = onFire(kind, target)
      chains[kind] = chain
      // Released through a callback rather than at the end of `onFire`, so an
      // `onFire` that returns synchronously (stopped in the window between the
      // timer firing and its callback running) still clears its own entry and
      // cannot leave `settled()` awaiting a stale promise forever.
      const release = () => { if (chains[kind] === chain) delete chains[kind] }
      chain.then(release, release)
    }, delay)
    timers[kind] = typeof dispose === 'function' ? dispose : undefined
  }

  const onFire = async (kind, target) => {
    delete timers[kind]
    delete armed[kind]
    if (stopped || !started) return
    lastTarget[kind] = target
    const range = reportRange(kind, target, tzOffsetMinutes)
    await runOne(kind, range.key, range)
    if (!stopped && started) arm(kind)
  }

  const catchUp = async (entries) => {
    for (const entry of entries) {
      if (stopped || controller.signal.aborted) return
      await runOne(entry.kind, entry.key, entry.range)
    }
  }

  /**
   * Start the scheduler: backfill what is missing, then align the next fire.
   *
   * The backfill is awaited rather than detached, so a caller that installs
   * this inside `ctx.effect` knows that everything owed has been produced by
   * the time `apply` resolves, and a test never has to race it.
   */
  const start = async () => {
    if (started) return
    started = true
    hasStarted = true
    stopped = false
    controller = new AbortController()
    for (const kind of SCHEDULE_KINDS) blocked[kind] = false
    if (!enabled) {
      info('work-journal: scheduler disabled; no automatic reports will be generated')
      return
    }
    state = await readState()
    startupPending = computePending()
    if (startupPending.length > 0) {
      info('work-journal: catching up %d scheduled report(s)', startupPending.length)
    }
    await catchUp(startupPending)
    if (stopped) return
    for (const kind of SCHEDULE_KINDS) arm(kind)
  }

  /** Stop the scheduler: abort in-flight generation and clear every timer. */
  const stop = async () => {
    stopped = true
    started = false
    try {
      controller?.abort(new Error('work-journal: scheduler stopped'))
    } catch { /* an abort listener must never break disposal */ }
    controller = undefined
    for (const kind of SCHEDULE_KINDS) {
      const dispose = timers[kind]
      delete timers[kind]
      delete armed[kind]
      if (typeof dispose !== 'function') continue
      try {
        dispose()
      } catch (error) {
        warn('work-journal: could not dispose the %s timer: %s', kind, messageOf(error))
      }
    }
  }

  return {
    start,
    stop,
    /**
     * When a kind will next fire, as epoch milliseconds.
     * @param kind - `day`, `week`, or `month`.
     * @returns the armed target, or the next calendar-aligned slot.
     */
    nextFireAt(kind) {
      if (!SCHEDULE_KINDS.includes(kind)) throw new TypeError(`work-journal: unknown schedule kind: ${JSON.stringify(kind)}`)
      return armed[kind] ?? nextFireAfter(kind, lastTarget[kind] ?? now(), tzOffsetMinutes)
    },
    /**
     * The catch-up list computed at the last start, oldest first.
     *
     * Frozen once started, on purpose: the runs it triggered are what remove
     * the debt, and recomputing live would make the list silently shrink under
     * the caller inspecting it. Before a start it is computed from the state
     * loaded so far, so the debt is visible without generating anything.
     * @returns `Array<{ kind, key, range }>`.
     */
    pending() {
      if (hasStarted) return startupPending.slice()
      return computePending()
    },
    /** Wait for every fire chain and in-flight run to settle. */
    async settled() {
      for (;;) {
        const tasks = []
        for (const kind of SCHEDULE_KINDS) {
          if (chains[kind] !== undefined) tasks.push(chains[kind])
          if (inFlight[kind] !== undefined) tasks.push(inFlight[kind])
        }
        if (tasks.length === 0) return
        await Promise.allSettled(tasks)
      }
    },
    statePath,
  }
}
