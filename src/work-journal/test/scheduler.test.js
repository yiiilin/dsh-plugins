/**
 * Scheduler tests.
 *
 * The scheduler's whole reason to exist is its relationship with the calendar,
 * so nothing here touches real time: a fake clock owns "now" and the timers,
 * which lets a test jump a month, suspend the process for three hours, or run
 * the same Saturday boundary twice, and get the same answer every run.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { format } from 'node:util'
import { DEFAULT_MAX_CATCH_UP, createScheduler, nextFireAfter, reportRange } from '../lib/scheduler.js'

/** Offset used throughout, matching the deployment's UTC+8. */
const TZ = 480
/** Parse an instant written in the deployment's local offset. */
const at = (iso) => Date.parse(`${iso}+08:00`)
/** Epoch milliseconds of local midnight, written the way the tests read it. */
const midnight = (date) => Date.parse(`${date}T00:00:00+08:00`)
/** Last millisecond of a local day. */
const lastMs = (date) => midnight(date) + 86399999

/**
 * A clock that owns both `now()` and the timer service.
 *
 * `fireNext` can run a timer *late*, which is the whole point: a real timer
 * fires after a suspend with an arbitrary delay, and the scheduler must still
 * cover the slot it was armed for.
 */
function createFakeClock(startMs) {
  let current = startMs
  let sequence = 0
  let disposed = 0
  const scheduled = new Map()
  const timer = {
    setTimeout(callback, delay) {
      const id = ++sequence
      scheduled.set(id, { id, at: current + Math.max(0, delay), callback, delay })
      return () => {
        disposed += 1
        scheduled.delete(id)
      }
    },
  }
  const pending = () => [...scheduled.values()].sort((left, right) => left.at - right.at || left.id - right.id)
  const clock = {
    timer,
    now: () => current,
    /** Move the clock without firing anything, as a suspended process does. */
    set: (ms) => { current = ms },
    get disposed() { return disposed },
    get size() { return scheduled.size },
    pending,
    /** Run the earliest armed timer, optionally late by `lateBy` ms. */
    fireNext(lateBy = 0) {
      const next = pending()[0]
      if (next === undefined) return false
      scheduled.delete(next.id)
      current = next.at + lateBy
      next.callback()
      return true
    },
    /** Run every timer due at or before `until`, waiting for each to settle. */
    async drain(scheduler, until, lateBy = 0) {
      let fired = 0
      for (;;) {
        const next = pending()[0]
        if (next === undefined || next.at > until) return fired
        clock.fireNext(lateBy)
        fired += 1
        await scheduler.settled()
      }
    },
  }
  return clock
}

/** A recording `run` implementation. */
function createRecorder(options = {}) {
  const calls = []
  const run = async (kind, key, range, signal) => {
    calls.push({ kind, key, range, signal })
    if (options.fail !== undefined && options.fail(kind, key, calls.length)) throw new Error(`boom:${kind}:${key}`)
    if (options.hold !== undefined) await options.hold(signal, kind, key)
  }
  return { calls, run }
}

/** Create a throwaway state directory and a scheduler over it. */
async function withStateDir(body) {
  const directory = await mkdtemp(join(tmpdir(), 'wj-sched-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Build a scheduler with a fake clock and a recording run. */
function scenario(options = {}) {
  const clock = createFakeClock(options.now ?? at('2026-10-04T10:00:00'))
  const recorder = createRecorder(options)
  const warnings = []
  const infos = []
  // Format like a real logger would, so assertions read the message a person
  // would actually see rather than the raw template.
  const capture = (sink) => (first, ...rest) => sink.push(format(first, ...rest))
  const scheduler = createScheduler({
    timer: clock.timer,
    tzOffsetMinutes: TZ,
    stateDir: options.stateDir,
    run: options.run ?? recorder.run,
    now: clock.now,
    logger: { warn: capture(warnings), info: capture(infos) },
    maxCatchUp: options.maxCatchUp,
    enabled: options.enabled,
    readFile: options.readFile,
    writeFile: options.writeFile,
  })
  return { clock, recorder, scheduler, warnings, infos }
}

test('names the calendar period each kind is responsible for', () => {
  // The Saturday slot: yesterday's daily report, the week that ended on Friday,
  // and the month that ended on the previous last day.
  const saturday = at('2026-10-10T00:00:00')
  assert.deepEqual(reportRange('day', saturday, TZ), {
    kind: 'day',
    key: '2026-10-09',
    label: '2026-10-09',
    startDate: '2026-10-09',
    endDate: '2026-10-09',
    startTime: midnight('2026-10-09'),
    endTime: lastMs('2026-10-09'),
  })
  assert.deepEqual(reportRange('week', saturday, TZ), {
    kind: 'week',
    key: '2026-W41',
    label: '2026-10-03 ~ 2026-10-09',
    startDate: '2026-10-03',
    endDate: '2026-10-09',
    startTime: midnight('2026-10-03'),
    endTime: lastMs('2026-10-09'),
  })
  assert.deepEqual(reportRange('month', saturday, TZ), {
    kind: 'month',
    key: '2026-09',
    label: '2026-09',
    startDate: '2026-09-01',
    endDate: '2026-09-30',
    startTime: midnight('2026-09-01'),
    endTime: lastMs('2026-09-30'),
  })
})

test('covers exactly seven days for a weekly report and the whole month for a monthly one', () => {
  const week = reportRange('week', at('2026-10-10T00:00:00'), TZ)
  assert.equal((week.endTime - week.startTime + 1) / 86400000, 7)
  const leapFebruary = reportRange('month', at('2028-03-04T00:00:00'), TZ)
  assert.equal(leapFebruary.key, '2028-02')
  assert.equal(leapFebruary.endDate, '2028-02-29')
  // A month is not a fixed duration; the range follows the calendar.
  const thirtyOne = reportRange('month', at('2026-11-01T00:00:00'), TZ)
  assert.equal(thirtyOne.key, '2026-10')
  assert.equal(thirtyOne.endDate, '2026-10-31')
})

test('labels a weekly report with its ISO week and a monthly report with its month', () => {
  // A week whose days straddle the year boundary still names the ISO week year.
  const yearEnd = reportRange('week', at('2027-01-02T00:00:00'), TZ)
  assert.equal(yearEnd.startDate, '2026-12-26')
  assert.equal(yearEnd.endDate, '2027-01-01')
  assert.equal(yearEnd.key, '2026-W53')
})

test('aligns the next fire to the calendar, not to elapsed time', () => {
  const sunday = at('2026-10-04T10:00:00')
  assert.equal(nextFireAfter('day', sunday, TZ), midnight('2026-10-05'))
  assert.equal(nextFireAfter('week', sunday, TZ), midnight('2026-10-10'))
  assert.equal(nextFireAfter('month', sunday, TZ), midnight('2026-11-01'))
})

test('arms the next slot strictly after the current one', () => {
  // Exactly on the boundary the slot that just became due is *this* one, so a
  // non-strict next fire would re-arm a zero-delay timer for the same report.
  const saturday = at('2026-10-10T00:00:00')
  assert.equal(nextFireAfter('day', saturday, TZ), midnight('2026-10-11'))
  assert.equal(nextFireAfter('week', saturday, TZ), midnight('2026-10-17'))
  assert.equal(nextFireAfter('month', saturday, TZ), midnight('2026-11-01'))
})

test('crosses month, year, leap-day and month-end boundaries', () => {
  // Month end: the next slot is the 1st, never the 31st rolled over.
  assert.equal(nextFireAfter('month', at('2026-10-31T23:59:59'), TZ), midnight('2026-11-01'))
  // Year end: December rolls into January of the next year.
  assert.equal(nextFireAfter('month', at('2026-12-31T23:00:00'), TZ), midnight('2027-01-01'))
  assert.equal(nextFireAfter('day', at('2026-12-31T23:00:00'), TZ), midnight('2027-01-01'))
  assert.equal(nextFireAfter('week', at('2026-12-31T23:00:00'), TZ), midnight('2027-01-02'))
  // Leap day: February has 29 days in 2028, so the March slot is a day later.
  assert.equal(nextFireAfter('month', at('2028-02-29T00:00:00'), TZ), midnight('2028-03-01'))
  assert.equal(nextFireAfter('day', at('2028-02-28T12:00:00'), TZ), midnight('2028-02-29'))
  // A 31-day month followed by a 30-day one.
  assert.equal(nextFireAfter('month', at('2026-09-30T12:00:00'), TZ), midnight('2026-10-01'))
  assert.equal(nextFireAfter('month', at('2026-01-31T12:00:00'), TZ), midnight('2026-02-01'))
})

test('rejects an unknown kind or a missing timer', async () => {
  assert.throws(() => reportRange('quarter', at('2026-10-04T10:00:00'), TZ), /unknown schedule kind/u)
  assert.throws(() => nextFireAfter('quarter', at('2026-10-04T10:00:00'), TZ), /unknown schedule kind/u)
  const { run } = createRecorder()
  await withStateDir(async (stateDir) => {
    assert.throws(() => createScheduler({ stateDir, run, tzOffsetMinutes: TZ, now: () => 0 }), /requires a timer/u)
    assert.throws(() => createScheduler({ timer: createFakeClock(0).timer, run, tzOffsetMinutes: TZ }), /stateDir/u)
    assert.throws(() => createScheduler({ timer: createFakeClock(0).timer, stateDir, tzOffsetMinutes: TZ }), /run\(/u)
    const clock = createFakeClock(0)
    const scheduler = createScheduler({ timer: clock.timer, stateDir, run, tzOffsetMinutes: TZ, now: clock.now })
    assert.throws(() => scheduler.nextFireAt('decade'), /unknown schedule kind/u)
  })
})

test('backfills the reports that should exist, oldest first, on a first start', async () => {
  await withStateDir(async (stateDir) => {
    const { clock, recorder, scheduler, infos } = scenario({ stateDir, maxCatchUp: 3 })
    assert.equal(clock.pending().length, 0)
    await scheduler.start()

    // Ascending time order across kinds: the September monthly report opens the
    // backlog, then the weekly one, then yesterday.
    assert.deepEqual(recorder.calls.map((call) => `${call.kind}:${call.key}`), [
      'month:2026-09',
      'week:2026-W40',
      'day:2026-10-03',
    ])
    for (const call of recorder.calls) {
      assert.equal(call.range.kind, call.kind)
      assert.equal(call.range.key, call.key)
    }
    const day = recorder.calls[2]
    assert.equal(day.range.startTime, midnight('2026-10-03'))
    assert.equal(day.range.endTime, lastMs('2026-10-03'))
    // Every run is handed a live abort signal so stop() can cancel the work.
    assert.equal(typeof day.signal?.aborted, 'boolean')
    assert.equal(infos.length, 1)
    assert.match(infos[0], /catching up 3 scheduled report/u)
    // The backlog is frozen at start so an inspector sees what was generated.
    assert.equal(scheduler.pending().length, 3)
  })
})

test('arms each kind at its next calendar slot after the backfill', async () => {
  await withStateDir(async (stateDir) => {
    const clock = createFakeClock(at('2026-10-04T10:00:00'))
    const { run } = createRecorder()
    const scheduler = createScheduler({
      timer: clock.timer,
      tzOffsetMinutes: TZ,
      stateDir,
      run,
      now: clock.now,
      maxCatchUp: 3,
    })
    await scheduler.start()
    assert.equal(scheduler.nextFireAt('day'), midnight('2026-10-05'))
    assert.equal(scheduler.nextFireAt('week'), midnight('2026-10-10'))
    assert.equal(scheduler.nextFireAt('month'), midnight('2026-11-01'))
    assert.equal(clock.size, 3)
    const [, ...later] = clock.pending()
    // Ordered soonest first, and never negative.
    assert.ok(clock.pending()[0].delay >= 0)
    assert.ok(later.every((entry) => entry.at >= clock.pending()[0].at))
  })
})

test('caps the backlog at maxCatchUp, keeping the newest of every kind', async () => {
  await withStateDir(async (stateDir) => {
    const { scheduler, warnings } = scenario({ stateDir, maxCatchUp: 4 })
    const pending = scheduler.pending()
    assert.equal(pending.length, 4)
    // Every kind keeps its newest period, so a long outage still produces a
    // monthly report instead of spending the whole budget on daily ones.
    assert.deepEqual(pending.map((entry) => entry.key), ['2026-09', '2026-W40', '2026-10-02', '2026-10-03'])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /more than maxCatchUp=4 behind/u)
  })
})

test('defaults to a 31-period backlog and only keeps contiguous daily reports', async () => {
  await withStateDir(async (stateDir) => {
    const { scheduler, warnings } = scenario({ stateDir })
    const pending = scheduler.pending()
    assert.equal(DEFAULT_MAX_CATCH_UP, 31)
    assert.equal(pending.length, 31)
    assert.equal(warnings.length, 1)
    const keys = pending.map((entry) => entry.key)
    assert.equal(new Set(keys).size, keys.length)
    const days = pending.filter((entry) => entry.kind === 'day').map((entry) => entry.key)
    // The daily keys that survive the cap are the newest ones, back to back:
    // the oldest surviving day is exactly the number of kept days before today.
    assert.equal(days[days.length - 1], '2026-10-03')
    assert.equal(days[0], '2026-09-07')
    assert.equal(days.length, 27)
    for (let i = 1; i < days.length; i += 1) {
      const previous = Date.parse(`${days[i - 1]}T00:00:00Z`)
      const current = Date.parse(`${days[i]}T00:00:00Z`)
      assert.equal(current - previous, 86400000)
    }
    // The other kinds are never squeezed out by the daily backlog, which is the
    // difference between a useful monthly report and thirty daily ones.
    assert.ok(pending.some((entry) => entry.kind === 'week'))
    assert.ok(pending.some((entry) => entry.kind === 'month'))
    // Oldest first, so a backfill produces a readable chronology.
    const starts = pending.map((entry) => entry.range.startTime)
    assert.deepEqual(starts, [...starts].sort((left, right) => left - right))
  })
})

test('persists a contiguous watermark and stops backfilling once it is caught up', async () => {
  await withStateDir(async (stateDir) => {
    const first = scenario({ stateDir, maxCatchUp: 3 })
    await first.scheduler.start()
    const saved = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8'))
    assert.deepEqual(saved.runs, { day: '2026-10-03', week: '2026-W40', month: '2026-09' })
    await first.scheduler.stop()

    // A second boot at the same instant owes nothing. `pending()` only reflects
    // the persisted watermark once `start()` has loaded it, which is the
    // contract: it reports what the last start decided to catch up.
    const second = scenario({ stateDir, maxCatchUp: 3 })
    await second.scheduler.start()
    assert.deepEqual(second.scheduler.pending(), [])
    assert.equal(second.recorder.calls.length, 0)
    assert.equal(second.warnings.length, 0)
  })
})

test('backfills only the periods after the watermark', async () => {
  await withStateDir(async (stateDir) => {
    await writeFile(join(stateDir, 'state.json'), `${JSON.stringify({
      version: 1,
      runs: { day: '2026-10-02', week: '2026-W40', month: '2026-09' },
    })}\n`)
    const { recorder, scheduler } = scenario({ stateDir, maxCatchUp: 5 })
    await scheduler.start()
    // Only yesterday is missing; the weekly and monthly periods are current.
    assert.deepEqual(recorder.calls.map((call) => `${call.kind}:${call.key}`), ['day:2026-10-03'])
  })
})

test('recovers from an unreadable watermark instead of failing to start', async () => {
  await withStateDir(async (stateDir) => {
    await writeFile(join(stateDir, 'state.json'), '{"version":1,"runs":{"day":')
    const { recorder, scheduler, warnings } = scenario({ stateDir, maxCatchUp: 3 })
    await scheduler.start()
    assert.equal(recorder.calls.length, 3)
    // One warning for the unreadable document and one for the capped backlog.
    assert.equal(warnings.length, 2)
    assert.match(warnings[0], /unreadable scheduler state/u)
    // The recovered run rewrites a readable document.
    const saved = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8'))
    assert.equal(saved.runs.day, '2026-10-03')
  })
})

test('discards a state document written by an incompatible version', async () => {
  await withStateDir(async (stateDir) => {
    await writeFile(join(stateDir, 'state.json'), `${JSON.stringify({ version: 99, runs: { day: '2026-10-03' } })}\n`)
    const { recorder, scheduler } = scenario({ stateDir, maxCatchUp: 3 })
    await scheduler.start()
    assert.equal(recorder.calls.length, 3)
  })
})

test('writes the watermark atomically with owner-only permissions', async () => {
  await withStateDir(async (stateDir) => {
    const writes = []
    const { scheduler } = scenario({
      stateDir,
      maxCatchUp: 3,
      writeFile: async (path, content, options) => { writes.push({ path, content, options }) },
    })
    await scheduler.start()
    assert.equal(writes.length, 3)
    assert.equal(writes[0].path, join(stateDir, 'state.json'))
    // The document quotes report keys only, but it is still user-private state.
    assert.equal(writes[0].options.mode, 0o600)
    assert.equal(writes[0].options.dirMode, 0o700)
    assert.ok(writes[0].content.endsWith('\n'))
  })
})

test('keeps running after a failed report and retries it at the next start', async () => {
  await withStateDir(async (stateDir) => {
    const attempt = scenario({
      stateDir,
      maxCatchUp: 3,
      // The daily report is the failure; the other kinds succeed.
      fail: (kind) => kind === 'day',
    })
    await attempt.scheduler.start()
    assert.deepEqual(attempt.recorder.calls.map((call) => call.kind), ['month', 'week', 'day'])
    // One warning for the capped backlog and one for the failure itself.
    assert.equal(attempt.warnings.length, 2)
    assert.match(attempt.warnings[1], /day report for 2026-10-03 failed: boom:day:2026-10-03/u)
    // A failed period must not be stepped over: advancing the watermark past it
    // would orphan it, because the next start only looks above the watermark.
    const saved = JSON.parse(await readFile(join(stateDir, 'state.json'), 'utf8'))
    assert.deepEqual(saved.runs, { week: '2026-W40', month: '2026-09' })
    // The scheduler is still armed and alive.
    assert.equal(attempt.scheduler.nextFireAt('day'), midnight('2026-10-05'))
    await attempt.scheduler.stop()

    // A later boot retries the daily kind, oldest first. Because the watermark
    // never advanced past the failure, the retry covers the whole cap-bounded
    // window that ends at the failed period, not just that one day. That is the
    // deliberate cost of never stepping over a hole: regeneration is a keyed
    // upsert, so an extra run is cheap and an orphaned missing report is not.
    const retry = scenario({ stateDir, maxCatchUp: 3 })
    await retry.scheduler.start()
    assert.deepEqual(retry.recorder.calls.map((call) => `${call.kind}:${call.key}`), [
      'day:2026-10-01',
      'day:2026-10-02',
      'day:2026-10-03',
    ])
    assert.equal(retry.recorder.calls.at(-1).range.startTime, midnight('2026-10-03'))
  })
})

test('keeps firing a kind after one of its scheduled runs fails', async () => {
  await withStateDir(async (stateDir) => {
    const { clock, recorder, scheduler, warnings } = scenario({
      stateDir,
      maxCatchUp: 3,
      // Fail only the backfilled daily run (the third call); later ones succeed.
      fail: (kind, _key, count) => kind === 'day' && count === 3,
    })
    await scheduler.start()
    assert.equal(scheduler.nextFireAt('day'), midnight('2026-10-05'))

    // Let the weekly, monthly, and daily slots all come around. The failed
    // daily run must not cancel the kind's timer chain.
    await clock.drain(scheduler, midnight('2026-11-02'))
    const dayCalls = recorder.calls.filter((call) => call.kind === 'day')
    assert.ok(dayCalls.length >= 28, `expected a daily run for every day, got ${dayCalls.length}`)
    // The failed backfill is still recorded first, then every later slot runs.
    assert.deepEqual(dayCalls[0].key, '2026-10-03')
    assert.deepEqual(dayCalls[1].key, '2026-10-04')
    assert.equal(dayCalls[1].range.startTime, midnight('2026-10-04'))
    assert.equal(dayCalls[1].range.endTime, lastMs('2026-10-04'))
    // The cap warning plus the one failure.
    assert.equal(warnings.length, 2)
    assert.match(warnings[1], /day report for 2026-10-03 failed/u)
    // The chain is still armed well past the failure.
    assert.ok(scheduler.nextFireAt('day') >= midnight('2026-11-02'))
    assert.ok(scheduler.nextFireAt('week') >= midnight('2026-10-31'))
    assert.ok(scheduler.nextFireAt('month') >= midnight('2026-12-01'))
  })
})

test('realigns after a late timer instead of drifting by the lateness', async () => {
  await withStateDir(async (stateDir) => {
    const { clock, recorder, scheduler } = scenario({ stateDir, maxCatchUp: 3 })
    await scheduler.start()
    // The day slot fires three hours late, as a suspended process would.
    const late = 3 * 3600000
    for (let i = 0; i < 3; i += 1) {
      assert.equal(clock.fireNext(late), true)
      await scheduler.settled()
    }
    // The range is still the calendar day of the slot, and the next slot is the
    // next midnight rather than midnight plus the lateness.
    const dayCalls = recorder.calls.filter((call) => call.kind === 'day')
    assert.deepEqual(dayCalls.map((call) => call.range.startDate), [
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
    ])
    assert.equal(scheduler.nextFireAt('day'), midnight('2026-10-08'))
  })
})

test('a slow report delays its own kind and never overlaps it', async () => {
  await withStateDir(async (stateDir) => {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    let signalDayEntered
    const dayEntered = new Promise((resolve) => { signalDayEntered = resolve })
    let active = 0
    let peak = 0
    const calls = []
    const { clock, scheduler } = scenario({
      stateDir,
      maxCatchUp: 3,
      run: async (kind, key) => {
        calls.push(`${kind}:${key}`)
        active += 1
        peak = Math.max(peak, active)
        if (kind === 'day') {
          signalDayEntered()
          await gate
        }
        active -= 1
      },
    })
    // The daily backfill is held open while the other kinds complete.
    const started = scheduler.start()
    await dayEntered
    assert.deepEqual(calls, ['month:2026-09', 'week:2026-W40', 'day:2026-10-03'])
    // Nothing is armed while the backfill is still in progress.
    assert.equal(clock.size, 0)
    release()
    await started
    // Every kind is then armed, and the day chain only after its run settled.
    assert.equal(clock.size, 3)
    assert.equal(scheduler.nextFireAt('day'), midnight('2026-10-05'))
    await clock.drain(scheduler, midnight('2026-10-07'))
    assert.deepEqual(calls.filter((call) => call.startsWith('day:')), [
      'day:2026-10-03',
      'day:2026-10-04',
      'day:2026-10-05',
      'day:2026-10-06',
    ])
    // One run at a time, even when the earlier ones are slow.
    assert.equal(peak, 1)
    await scheduler.stop()
  })
})

test('stop clears every timer, aborts in-flight work, and is idempotent', async () => {
  await withStateDir(async (stateDir) => {
    let seen
    const { clock, scheduler } = scenario({
      stateDir,
      maxCatchUp: 3,
      run: async (_kind, _key, _range, signal) => { seen = signal },
    })
    await scheduler.start()
    assert.equal(clock.size, 3)
    await scheduler.stop()
    assert.equal(clock.size, 0)
    assert.equal(clock.disposed, 3)
    // The in-flight generation is told to stop rather than being left running.
    assert.equal(seen.aborted, true)
    // Idempotent: a second disposal is a no-op, not a double-dispose crash.
    await scheduler.stop()
    assert.equal(clock.disposed, 3)
    assert.equal(clock.size, 0)
    // Still queryable after stop, and never throws.
    assert.ok(scheduler.nextFireAt('day') >= midnight('2026-10-05'))
  })
})

test('does not fire anything after stop even if a timer callback arrives', async () => {
  await withStateDir(async (stateDir) => {
    const { clock, recorder, scheduler } = scenario({ stateDir, maxCatchUp: 3 })
    await scheduler.start()
    const armed = clock.pending().map((entry) => entry.callback)
    await scheduler.stop()
    // A callback already queued when stop() ran must be inert.
    for (const callback of armed) callback()
    await scheduler.settled()
    assert.equal(recorder.calls.length, 3)
    assert.equal(clock.size, 0)
  })
})

test('installs inert when disabled, without ever touching the timer or state', async () => {
  await withStateDir(async (stateDir) => {
    const { recorder, scheduler, clock, infos } = scenario({ stateDir, enabled: false, maxCatchUp: 3 })
    assert.deepEqual(scheduler.pending(), [])
    await scheduler.start()
    await scheduler.settled()
    assert.equal(clock.size, 0)
    assert.equal(clock.disposed, 0)
    assert.equal(recorder.calls.length, 0)
    assert.equal(infos.length, 1)
    assert.match(infos[0], /scheduler disabled/u)
    // No state file is invented while disabled.
    await assert.rejects(readFile(join(stateDir, 'state.json'), 'utf8'), { code: 'ENOENT' })
    await scheduler.stop()
  })
})

test('does not require a timer at all when disabled', async () => {
  await withStateDir(async (stateDir) => {
    const { run } = createRecorder()
    const scheduler = createScheduler({ stateDir, run, tzOffsetMinutes: TZ, enabled: false, now: () => at('2026-10-04T10:00:00') })
    await scheduler.start()
    await scheduler.stop()
    assert.deepEqual(scheduler.pending(), [])
  })
})

test('accepts the plain-functional timer and the ctx.timer service shape', async () => {
  await withStateDir(async (stateDir) => {
    const { run } = createRecorder()
    const armed = []
    const fake = createFakeClock(at('2026-10-04T10:00:00'))
    const functional = createScheduler({
      timer: (callback, delay) => { armed.push(delay); return fake.timer.setTimeout(callback, delay) },
      tzOffsetMinutes: TZ,
      stateDir,
      run,
      now: fake.now,
      maxCatchUp: 3,
    })
    await functional.start()
    assert.equal(armed.length, 3)
    await functional.stop()

    const byMethod = []
    const viaTimeout = createScheduler({
      timer: { timeout: (callback, delay) => { byMethod.push(delay); return fake.timer.setTimeout(callback, delay) } },
      tzOffsetMinutes: TZ,
      stateDir,
      run,
      now: fake.now,
      maxCatchUp: 3,
    })
    await viaTimeout.start()
    assert.equal(byMethod.length, 3)
    await viaTimeout.stop()
  })
})
