import { calendarDayKey, DASHBOARD_TIMEZONE } from "@lospor/core/dashboard-date-scope"
import { daysBetweenDateKeys, instantFromDateKey, shiftDateKey } from "@lospor/core/intraop-time"

/**
 * The indicators' period as instants, from ?from&to (YYYY-MM-DD, inclusive;
 * the last 90 days by default). The days are the department's calendar days,
 * not UTC ones: read as UTC, a case started between midnight and 02:00/03:00
 * Sofia time fell on the day before and was missing from "today".
 * Null for a period that is malformed, backwards or longer than maxDays.
 */
export function indicatorPeriod(
  fromParam: string | null,
  toParam: string | null,
  maxDays: number,
  now: Date = new Date(),
): { from: Date; to: Date } | null {
  const valid = (value: string | null) =>
    value && /^\d{4}-\d{2}-\d{2}$/.test(value) && instantFromDateKey(value, "00:00", DASHBOARD_TIMEZONE) ? value : null
  const toKey = valid(toParam) ?? calendarDayKey(now)
  // "to" is inclusive in the query, exclusive in the search.
  const toExclusive = shiftDateKey(toKey, 1)
  if (!toExclusive) return null
  const fromKey = valid(fromParam) ?? shiftDateKey(toExclusive, -90)
  if (!fromKey) return null
  const days = daysBetweenDateKeys(fromKey, toExclusive)
  const from = instantFromDateKey(fromKey, "00:00", DASHBOARD_TIMEZONE)
  const to = instantFromDateKey(toExclusive, "00:00", DASHBOARD_TIMEZONE)
  if (!from || !to || days == null || days < 1 || days > maxDays) return null
  return { from, to }
}
