import { isValidTimeZone } from "@lospor/core/intraop-time"

/**
 * Date/number coercion shared across the OMOP mapper's domains, split out of
 * omop-mapper.ts. These are pure and have no OMOP-specific meaning of their
 * own -- they exist so every domain formats a date or a number the same way.
 */

export function numOrNull(value: unknown): number | null {
  if (value == null || value === "") return null
  const n = typeof value === "number" ? value : parseFloat(String(value))
  return Number.isFinite(n) ? n : null
}

/**
 * The zone of the case being exported (2026-10-19). Research data shows the
 * actual date and clock time in the theatre: a case begun at 01:30 in Sofia
 * was dated the day before when dates were taken in UTC. Set for one case at a
 * time by inCaseZone; null (UTC, as before) for an old case with no zone.
 */
let caseZone: string | null = null

/** Runs one case's mapping with its dates and times in the case's zone. */
export function inCaseZone<T>(timeZone: string | null | undefined, map: () => T): T {
  const previous = caseZone
  caseZone = isValidTimeZone(timeZone) ? timeZone : null
  try {
    return map()
  } finally {
    caseZone = previous
  }
}

/** Year to second of an instant on the clock of a zone. */
function clockParts(instant: Date, timeZone: string): { date: string; time: string; offsetMinutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant).map(part => [part.type, part.value]))
  const wall = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    offsetMinutes: Math.round((wall - Math.floor(instant.getTime() / 1000) * 1000) / 60_000),
  }
}

/** The calendar date of an instant: the case's local date, or UTC for a case with no zone. */
export function isoDate(d: Date | string | null | undefined): string | null {
  if (!d) return null
  const dt = typeof d === "string" ? new Date(d) : d
  if (isNaN(dt.getTime())) return null
  return caseZone ? clockParts(dt, caseZone).date : dt.toISOString().substring(0, 10)
}

/**
 * The full instant, for CDM's `*_datetime` columns.
 *
 * `isoDate` truncates to a bare date, which is right for `*_date` and wrong for
 * `*_datetime`: two blood gases half an hour apart are the clinically
 * interesting case, and writing both as "2026-06-01" collapses them into one
 * indistinguishable pair. The intraoperative event rows have always written a
 * real instant here; this is the same thing for everything else that knows one.
 */
export function isoInstant(d: Date | string | null | undefined): string | null {
  if (!d) return null
  const dt = typeof d === "string" ? new Date(d) : d
  if (isNaN(dt.getTime())) return null
  if (!caseZone) return dt.toISOString()
  // The theatre's clock with its offset: "2026-10-19T01:30:00+03:00" -- the
  // actual local time, and still the same unambiguous instant.
  const { date, time, offsetMinutes } = clockParts(dt, caseZone)
  const sign = offsetMinutes < 0 ? "-" : "+"
  const abs = Math.abs(offsetMinutes)
  return `${date}T${time}${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`
}
