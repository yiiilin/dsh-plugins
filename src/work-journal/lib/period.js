/**
 * Calendar-range arithmetic for the work journal, in local wall-clock dates.
 *
 * Every range is an inclusive pair of `YYYY-MM-DD` strings, because that is
 * exactly how activity records are bucketed: a date string is compared
 * lexicographically, so "does this day fall in the range" needs no date object
 * and no timezone lookup at read time. Date arithmetic itself runs on UTC
 * midnight of the date parts, which makes day/week/month stepping exact —
 * adding 86 400 000 ms to a UTC midnight is always the next calendar day, with
 * no daylight-saving discontinuity to guard against.
 */

/** Range kinds the journal can report over. */
export const RANGE_KINDS = Object.freeze(['day', 'week', 'month', 'recent', 'all'])
/** Longest span a single report enumerates day by day. */
export const MAX_REPORT_DAYS = 400

const DAY_MS = 86400000
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Whether a value is a well-formed calendar date string.
 * @param value - candidate value.
 * @returns true when the value matches `YYYY-MM-DD`.
 */
export function isDate(value) {
  return typeof value === 'string' && DATE_PATTERN.test(value)
}

/** UTC midnight of one calendar date, as epoch milliseconds. */
function utcOf(date) {
  const [year, month, day] = date.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

/** Calendar date of one UTC-midnight epoch value. */
function dateOf(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Shift a calendar date by whole days.
 * @param date - starting `YYYY-MM-DD`.
 * @param days - signed day count.
 * @returns the shifted date.
 */
export function addDays(date, days) {
  return dateOf(utcOf(date) + days * DAY_MS)
}

/** Weekday of a calendar date, Sunday = 0, matching `Date#getUTCDay`. */
function weekday(date) {
  return new Date(utcOf(date)).getUTCDay()
}

/**
 * Monday of the ISO week containing a date.
 * @param date - any `YYYY-MM-DD`.
 * @returns that week's Monday.
 */
export function startOfWeek(date) {
  return addDays(date, -((weekday(date) + 6) % 7))
}

/**
 * First day of the month containing a date.
 * @param date - any `YYYY-MM-DD`.
 * @returns the month's `01`.
 */
export function startOfMonth(date) {
  return `${date.slice(0, 7)}-01`
}

/**
 * Last day of the month containing a date.
 * @param date - any `YYYY-MM-DD`.
 * @returns the month's final calendar day.
 */
export function endOfMonth(date) {
  return addDays(addDays(startOfMonth(date), 32).slice(0, 7) + '-01', -1)
}

/**
 * Local calendar date of an instant, applying an explicit UTC offset.
 * @param time - Unix epoch milliseconds.
 * @param tzOffsetMinutes - minutes east of UTC.
 * @returns the local `YYYY-MM-DD`.
 */
export function localDateOf(time, tzOffsetMinutes) {
  return new Date(time + tzOffsetMinutes * 60000).toISOString().slice(0, 10)
}

/**
 * Resolve one report range.
 *
 * `anchor` is the date the range is built around; omitting it uses `today`, so
 * "this week" means the week containing today. `recent` counts backwards from
 * the anchor inclusive, which is what "last 7 days" should mean to a person.
 * @param kind - one of {@link RANGE_KINDS}.
 * @param options - `anchor` date, `today` date, and `days` for `recent`.
 * @returns the inclusive range, its day list, and a human label.
 * @throws when the kind is unknown or the anchor is malformed.
 */
export function resolveRange(kind, options = {}) {
  if (!RANGE_KINDS.includes(kind)) throw new Error(`unknown range kind: ${String(kind)}`)
  const today = isDate(options.today) ? options.today : localDateOf(Date.now(), options.tzOffsetMinutes ?? 0)
  const anchor = options.anchor === undefined ? today : options.anchor
  if (!isDate(anchor)) throw new Error(`invalid date: ${String(options.anchor)} (expected YYYY-MM-DD)`)

  let startDate
  let endDate
  let label
  switch (kind) {
    case 'day':
      startDate = anchor
      endDate = anchor
      label = anchor
      break
    case 'week':
      startDate = startOfWeek(anchor)
      endDate = addDays(startDate, 6)
      label = `${startDate} ~ ${endDate}`
      break
    case 'month':
      startDate = startOfMonth(anchor)
      endDate = endOfMonth(anchor)
      label = anchor.slice(0, 7)
      break
    case 'recent': {
      const days = Number.isSafeInteger(options.days) && options.days > 0 ? options.days : 7
      startDate = addDays(anchor, -(days - 1))
      endDate = anchor
      label = `最近 ${days} 天（${startDate} ~ ${endDate}）`
      break
    }
    default: {
      const earliest = isDate(options.earliest) ? options.earliest : anchor
      startDate = earliest <= anchor ? earliest : anchor
      endDate = anchor
      label = `${startDate} ~ ${endDate}`
      break
    }
  }

  const dates = []
  for (let date = startDate; date <= endDate && dates.length < MAX_REPORT_DAYS; date = addDays(date, 1)) dates.push(date)
  return { kind, startDate, endDate, label, dates, truncated: dates.length >= MAX_REPORT_DAYS && dates[dates.length - 1] < endDate }
}
