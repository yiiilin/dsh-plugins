import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_REPORT_DAYS, addDays, endOfMonth, isDate, localDateOf, resolveRange, startOfMonth, startOfWeek } from '../lib/period.js'

test('recognizes only well-formed calendar dates', () => {
  assert.equal(isDate('2026-09-13'), true)
  assert.equal(isDate('2026-9-13'), false)
  assert.equal(isDate('20260913'), false)
  assert.equal(isDate(undefined), false)
})

test('resolves ISO weeks from Monday through Sunday', () => {
  // 2026-09-13 is a Sunday, so it closes the week that began on 09-07.
  assert.equal(startOfWeek('2026-09-13'), '2026-09-07')
  assert.equal(startOfWeek('2026-09-14'), '2026-09-14')
  const week = resolveRange('week', { anchor: '2026-09-13', today: '2026-09-13' })
  assert.equal(week.startDate, '2026-09-07')
  assert.equal(week.endDate, '2026-09-13')
  assert.equal(week.dates.length, 7)
})

test('resolves calendar months including leap February', () => {
  assert.equal(startOfMonth('2026-09-13'), '2026-09-01')
  assert.equal(endOfMonth('2026-09-13'), '2026-09-30')
  assert.equal(endOfMonth('2028-02-10'), '2028-02-29')
  assert.equal(endOfMonth('2026-12-15'), '2026-12-31')
})

test('steps days across a month and year boundary', () => {
  assert.equal(addDays('2026-09-30', 1), '2026-10-01')
  assert.equal(addDays('2026-01-01', -1), '2025-12-31')
})

test('anchors a day range on the requested date and defaults to today', () => {
  const day = resolveRange('day', { anchor: '2026-09-13', today: '2026-10-10' })
  assert.deepEqual(day.dates, ['2026-09-13'])
  assert.equal(day.label, '2026-09-13')
  const today = resolveRange('day', { today: '2026-10-10' })
  assert.deepEqual(today.dates, ['2026-10-10'])
})

test('counts a recent window backwards from the anchor inclusive', () => {
  const recent = resolveRange('recent', { anchor: '2026-09-13', days: 3, today: '2026-10-10' })
  assert.equal(recent.startDate, '2026-09-11')
  assert.equal(recent.endDate, '2026-09-13')
  assert.equal(recent.dates.length, 3)
  // A missing or nonsensical window falls back to seven days.
  assert.equal(resolveRange('recent', { anchor: '2026-09-13', days: 0 }).dates.length, 7)
})

test('floors an all-range at the earliest recorded day', () => {
  const all = resolveRange('all', { anchor: '2026-09-13', earliest: '2026-09-01' })
  assert.equal(all.startDate, '2026-09-01')
  assert.equal(all.endDate, '2026-09-13')
  // Without an earliest day it degenerates to the anchor rather than to 1970.
  assert.equal(resolveRange('all', { anchor: '2026-09-13' }).startDate, '2026-09-13')
})

test('caps an enumerated range and reports the truncation', () => {
  const wide = resolveRange('all', { anchor: '2026-09-13', earliest: '2020-01-01' })
  assert.equal(wide.dates.length, MAX_REPORT_DAYS)
  assert.equal(wide.truncated, true)
})

test('rejects an unknown kind or a malformed anchor', () => {
  assert.throws(() => resolveRange('quarter', { today: '2026-09-13' }), /unknown range kind/u)
  assert.throws(() => resolveRange('day', { anchor: '13/09/2026', today: '2026-09-13' }), /invalid date/u)
})

test('derives a local date from an instant at an explicit offset', () => {
  assert.equal(localDateOf(Date.UTC(2026, 8, 13, 16, 30), 480), '2026-09-14')
  assert.equal(localDateOf(Date.UTC(2026, 8, 13, 16, 30), 0), '2026-09-13')
})
