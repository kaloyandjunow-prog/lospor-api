import { INTRAOP_COLUMN_MS, intraopInstantForColumn } from "@lospor/core/intraop-engine"
import type { ClinicalEvent, LogEvent } from "@/types/timetable"

/**
 * Turning a web-shaped timetable back into the event log both clients read.
 *
 * The web client charts into a column grid; mobile charts events with real
 * timestamps, and CaseEvent rows are the record of truth. These two functions
 * are the bridge, and they are pure -- split out of the PATCH handler because
 * they are where a silently-dropped vital or a duplicated event would come
 * from, and neither was reachable by a test while inlined in the route.
 */

/**
 * Clinical events the web client added to its grid, as log entries.
 *
 * Web writes them into `timetableData.clinicalEvents` with a column index and
 * no timestamp; mobile only ever sees the log. Matching is by (label, column)
 * against the events already logged, so re-saving the same case does not
 * duplicate them -- but two separate episodes that happen to share a label
 * (two hypotension events, say) at different times are not the same event and
 * must not collapse into one just because dedup only ever looked at the
 * label. Returns the original log unchanged when there is nothing to merge or
 * no chart start to resolve columns against.
 */
export function mergeWebClinicalEventsIntoLog(
  existingLog: LogEvent[],
  webClinicalEvents: ClinicalEvent[],
  chartStartMs: number | null,
): LogEvent[] {
  if (webClinicalEvents.length === 0 || existingLog.length === 0) return existingLog
  if (!chartStartMs) return existingLog

  const eventKey = (label: string | undefined, column: number | null) => `${label}@${column}`
  const loggedKeys = new Set(
    existingLog
      .filter(event => event.type === "clinical_event" || event.type === "event")
      .map(event => {
        const column = typeof event.ts === "string"
          ? Math.floor((new Date(event.ts).getTime() - chartStartMs) / INTRAOP_COLUMN_MS)
          : null
        return eventKey(event.label, column)
      }),
  )
  const added: LogEvent[] = webClinicalEvents
    .filter(event => !loggedKeys.has(eventKey(event.label, event.colIdx)))
    .map(event => ({
      id: `web-${event.colIdx}-${event.label}`,
      ts: intraopInstantForColumn(chartStartMs, event.colIdx).toISOString(),
      type: "clinical_event",
      label: event.label,
      color: event.color,
    }))
  return added.length > 0 ? [...existingLog, ...added] : existingLog
}

const NON_VITAL_FIELD_KEYS = new Set(["id", "ts", "type"])

/**
 * Grid-typed vitals as vital events, for any 5-minute column carrying a value
 * no logged vital event already covers.
 *
 * Older cached web builds write vitals straight into the grid without emitting
 * vital events. `rebuildProjection` rebuilds keyEvents purely from event rows,
 * so without this bridge those vitals are wiped the moment the case has any
 * events at all -- a clinician's typed observations disappearing on the next
 * save.
 *
 * Merging is per field, not per column. A column with a single logged
 * heart-rate event used to be treated as fully represented, so a systolic and
 * diastolic value sitting in the grid at that same column -- entered before
 * anything in that bucket was ever turned into an event -- were silently
 * dropped forever, because the whole column was skipped once anything in it
 * had an event. Only the fields still missing at a column are bridged now.
 */
export function bridgeGridVitalsIntoLog(
  projectedLog: LogEvent[],
  gridVitals: unknown[],
  chartStartMs: number | null,
): LogEvent[] {
  if (chartStartMs === null || gridVitals.length === 0) return projectedLog
  if (projectedLog.length === 0) return projectedLog

  const loggedFieldsByColumn = new Map<number, Set<string>>()
  for (const event of projectedLog) {
    if (event.type !== "vital" || typeof event.ts !== "string") continue
    const column = Math.floor((new Date(event.ts).getTime() - chartStartMs) / INTRAOP_COLUMN_MS)
    const fields = loggedFieldsByColumn.get(column) ?? new Set<string>()
    for (const [key, value] of Object.entries(event)) {
      if (NON_VITAL_FIELD_KEYS.has(key) || value == null) continue
      fields.add(key)
    }
    loggedFieldsByColumn.set(column, fields)
  }

  const bridged: LogEvent[] = []
  gridVitals.forEach((vital, column) => {
    if (!vital || typeof vital !== "object") return
    const alreadyLogged = loggedFieldsByColumn.get(column)
    const missing = Object.fromEntries(
      Object.entries(vital).filter(([key, value]) => value != null && !alreadyLogged?.has(key)),
    )
    if (Object.keys(missing).length === 0) return
    bridged.push({
      id: `web-vital-${column}`,
      ts: intraopInstantForColumn(chartStartMs, column).toISOString(),
      type: "vital",
      ...missing,
    } as LogEvent)
  })
  return bridged.length > 0 ? [...projectedLog, ...bridged] : projectedLog
}
