import assert from 'node:assert/strict'
import test from 'node:test'
import { aggregate, formatDuration, formatInt, projectOf, renderMarkdown, unionDuration } from '../lib/report.js'
import { resolveRange } from '../lib/period.js'

const TZ = 480
/** 2026-09-13 12:00 UTC — inside the CST day 2026-09-13. */
const BASE = Date.UTC(2026, 8, 13, 12, 0, 0)
const NEXT_DAY = Date.UTC(2026, 8, 14, 12, 0, 0)

/** Build one activity record the way the collector would store it. */
function activity(overrides = {}) {
  const day = {
    date: '2026-09-13',
    firstTime: BASE,
    lastTime: BASE + 3600000,
    turns: 2,
    steps: 3,
    prompts: 1,
    toolCalls: 4,
    toolErrors: 0,
    outputTokens: 500,
    tools: { bash: 3, edit: 1 },
    files: { '/w/app/a.js': 1 },
    commands: ['npm test'],
    spans: [[BASE, BASE + 3600000]],
  }
  return {
    version: 2,
    id: 's1',
    title: 'work',
    cwd: '/w/app',
    createdAt: BASE,
    origin: 'root',
    depth: 0,
    preset: 'yiln',
    parent: null,
    firstTime: BASE,
    lastTime: BASE + 3600000,
    days: ['2026-09-13'],
    totals: { turns: 2, steps: 3, prompts: 1, delegated: 0, toolCalls: 4, toolErrors: 0, inputTokens: 10, outputTokens: 500, llmMs: 1000, toolMs: 2000 },
    tools: { bash: 3, edit: 1 },
    files: { '/w/app/a.js': 1 },
    prompts: [{ seq: 1, time: BASE, date: '2026-09-13', text: 'build it' }],
    byDay: { '2026-09-13': day },
    ...overrides,
  }
}

/** Wrap records into an index document. */
const indexOf = (activities) => ({
  version: 2,
  tzOffsetMinutes: TZ,
  updatedAt: BASE,
  scans: 1,
  activities: Object.fromEntries(activities.map((entry) => [entry.id, entry])),
  revisions: {},
  errors: {},
  stats: { sessions: activities.length, indexed: activities.length, skipped: 0, failed: 0, lastScanAt: BASE, lastScanMs: 1, complete: true },
})

const day = (anchor) => resolveRange('day', { anchor, tzOffsetMinutes: TZ })

test('formats integers and durations without a locale dependency', () => {
  assert.equal(formatInt(1234567), '1,234,567')
  assert.equal(formatInt(0), '0')
  assert.equal(formatDuration(0), '不足 1 分钟')
  assert.equal(formatDuration(45 * 60000), '45 分钟')
  assert.equal(formatDuration(120 * 60000), '2 小时')
  assert.equal(formatDuration(150 * 60000), '2 小时 30 分')
})

test('unions overlapping intervals instead of summing them', () => {
  // Three agents working the same hour is one hour of work, not three.
  assert.equal(unionDuration([[0, 3600000], [600000, 4200000], [1800000, 2400000]]), 4200000)
  assert.equal(unionDuration([[0, 1000], [2000, 3000]]), 2000)
  assert.equal(unionDuration([]), 0)
  assert.equal(unionDuration([[5, 1]]), 0)
})

test('labels a project by its final path segment', () => {
  assert.equal(projectOf('/usr/local/src/project/dsh-plugin'), 'dsh-plugin')
  assert.equal(projectOf('/w/app/'), 'app')
  assert.equal(projectOf(''), '(未知目录)')
  assert.equal(projectOf(null), '(未知目录)')
})

test('counts only the days inside the requested range', () => {
  const record = activity({
    days: ['2026-09-13', '2026-09-14'],
    byDay: {
      '2026-09-13': { date: '2026-09-13', firstTime: BASE, lastTime: BASE + 3600000, turns: 2, steps: 3, prompts: 1, toolCalls: 4, toolErrors: 0, outputTokens: 500, tools: { bash: 3 }, files: {}, commands: [], spans: [[BASE, BASE + 3600000]] },
      '2026-09-14': { date: '2026-09-14', firstTime: NEXT_DAY, lastTime: NEXT_DAY + 1800000, turns: 1, steps: 1, prompts: 2, toolCalls: 1, toolErrors: 1, outputTokens: 100, tools: { read: 1 }, files: {}, commands: [], spans: [[NEXT_DAY, NEXT_DAY + 1800000]] },
    },
  })
  const index = indexOf([record])
  const first = aggregate(index, day('2026-09-13'))
  assert.equal(first.totals.sessions, 1)
  assert.equal(first.totals.prompts, 1)
  assert.equal(first.totals.toolCalls, 4)
  assert.equal(first.totals.toolErrors, 0)
  const second = aggregate(index, day('2026-09-14'))
  assert.equal(second.totals.prompts, 2)
  assert.equal(second.totals.toolErrors, 1)
  // A session is not double-counted across the two ranges.
  const both = aggregate(index, resolveRange('recent', { anchor: '2026-09-14', days: 2, tzOffsetMinutes: TZ }))
  assert.equal(both.totals.sessions, 1)
  assert.equal(both.totals.prompts, 3)
  assert.equal(both.totals.toolCalls, 5)
})

test('separates root sessions from delegated children in the totals', () => {
  const root = activity({ id: 'r' })
  const child = activity({ id: 'c', origin: 'subagent', depth: 1, prompts: [], totals: { ...activity().totals, prompts: 0, delegated: 1 } })
  const report = aggregate(indexOf([root, child]), day('2026-09-13'))
  assert.equal(report.totals.sessions, 1)
  assert.equal(report.totals.childSessions, 1)
  assert.equal(report.totals.delegated, 1)
})

test('groups projects and ranks tools and files', () => {
  const first = activity({ id: 'a', cwd: '/w/alpha' })
  const second = activity({ id: 'b', cwd: '/w/beta', tools: { read: 9 }, files: { '/w/beta/b.js': 2 } })
  const report = aggregate(indexOf([first, second]), day('2026-09-13'))
  assert.deepEqual(report.projects.map((entry) => entry.project).sort(), ['alpha', 'beta'])
  assert.equal(report.files[0].path, '/w/beta/b.js')
  assert.equal(report.tools[0].name, 'read')
  assert.equal(report.tools[0].count, 9)
})

test('reports an empty range without inventing a project list', () => {
  const report = aggregate(indexOf([activity()]), day('2026-09-20'))
  assert.equal(report.totals.sessions, 0)
  assert.deepEqual(report.projects, [])
  const markdown = renderMarkdown(report, {})
  assert.match(markdown, /没有记录到任何 DSH 活动/u)
})

test('renders a report with the overview, prompts, and session list', () => {
  const markdown = renderMarkdown(aggregate(indexOf([activity()]), day('2026-09-13')), { heading: '日报' })
  assert.match(markdown, /^# 日报$/mu)
  assert.match(markdown, /活跃时长：1 小时/u)
  assert.match(markdown, /我提的需求：1 条/u)
  assert.match(markdown, /build it/u)
  assert.match(markdown, /npm test/u)
  assert.match(markdown, /\/w\/app\/a\.js/u)
  assert.match(markdown, /主会话：1 个；子 agent 会话：0 个/u)
})

test('renders a multi-day table only when more than one day has activity', () => {
  const single = renderMarkdown(aggregate(indexOf([activity()]), day('2026-09-13')), {})
  assert.doesNotMatch(single, /每日分布/u)
  // A week range whose only activity is one day still renders no day table:
  // the table exists to compare days, and there is nothing to compare.
  const quietWeek = renderMarkdown(aggregate(indexOf([activity()]), resolveRange('week', { anchor: '2026-09-13', tzOffsetMinutes: TZ })), {})
  assert.doesNotMatch(quietWeek, /每日分布/u)
  const second = activity({
    id: 's2',
    days: ['2026-09-14'],
    byDay: {
      '2026-09-14': { date: '2026-09-14', firstTime: NEXT_DAY, lastTime: NEXT_DAY + 1800000, turns: 1, steps: 1, prompts: 1, toolCalls: 2, toolErrors: 0, outputTokens: 100, tools: { read: 2 }, files: {}, commands: [], spans: [[NEXT_DAY, NEXT_DAY + 1800000]] },
    },
  })
  // 09-13 is a Sunday and 09-14 the following Monday, so they sit in different
  // ISO weeks; a two-day recent window covers both.
  const week = renderMarkdown(aggregate(indexOf([activity(), second]), resolveRange('recent', { anchor: '2026-09-14', days: 2, tzOffsetMinutes: TZ })), {})
  assert.match(week, /每日分布/u)
  assert.match(week, /\| 2026-09-13 \|/u)
  assert.match(week, /\| 2026-09-14 \|/u)
})
