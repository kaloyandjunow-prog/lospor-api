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

export function isoDate(d: Date | string | null | undefined): string | null {
  if (!d) return null
  const dt = typeof d === "string" ? new Date(d) : d
  return isNaN(dt.getTime()) ? null : dt.toISOString().substring(0, 10)
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
  return isNaN(dt.getTime()) ? null : dt.toISOString()
}
