import { describe, expect, it } from "vitest"
import { bridgeGridVitalsIntoLog, mergeWebClinicalEventsIntoLog } from "./_patch-intraop-log"
import type { ClinicalEvent, LogEvent } from "@/types/timetable"

const START = new Date("2026-09-06T08:00:00.000Z").getTime()
const COLUMN_MS = 5 * 60_000
const atColumn = (col: number) => new Date(START + col * COLUMN_MS).toISOString()

const logged = (over: Partial<LogEvent> = {}): LogEvent => ({
  id: "e1", ts: atColumn(0), type: "clinical_event", label: "Incision", ...over,
} as LogEvent)

describe("mergeWebClinicalEventsIntoLog", () => {
  it("turns a web grid event into a timestamped log entry mobile can read", () => {
    const merged = mergeWebClinicalEventsIntoLog(
      [logged()],
      [{ colIdx: 3, label: "Extubation", color: "#f00" } as ClinicalEvent],
      START,
    )
    expect(merged).toHaveLength(2)
    expect(merged[1]).toMatchObject({
      type: "clinical_event", label: "Extubation", ts: atColumn(3),
    })
  })

  // Saving the same case twice must not chart the same event twice.
  it("does not re-add an event already in the log", () => {
    const existing = [logged({ label: "Extubation", ts: atColumn(3) })]
    expect(mergeWebClinicalEventsIntoLog(
      existing,
      [{ colIdx: 3, label: "Extubation" } as ClinicalEvent],
      START,
    )).toBe(existing)
  })

  it("matches against plain 'event' entries too, not only clinical_event", () => {
    const existing = [logged({ type: "event", label: "Extubation", ts: atColumn(3) })]
    expect(mergeWebClinicalEventsIntoLog(
      existing,
      [{ colIdx: 3, label: "Extubation" } as ClinicalEvent],
      START,
    )).toBe(existing)
  })

  /**
   * A column index means nothing without a chart start to resolve it against.
   * Guessing one would stamp the event at an invented time, so the merge stands
   * down and leaves the log untouched.
   */
  it("leaves the log alone when there is no chart start", () => {
    const existing = [logged()]
    expect(mergeWebClinicalEventsIntoLog(
      existing,
      [{ colIdx: 3, label: "Extubation" } as ClinicalEvent],
      null,
    )).toBe(existing)
  })

  it("leaves the log alone when there is nothing to merge", () => {
    const existing = [logged()]
    expect(mergeWebClinicalEventsIntoLog(existing, [], START)).toBe(existing)
  })

  /**
   * The regression this rewrite exists to fix. Two genuinely separate
   * hypotension episodes charted at different times share a label, and a
   * label-only dedup collapsed the second one into "already logged" -- so an
   * event that happened twice in one case was recorded as having happened
   * once.
   */
  it("does not collapse two separate episodes that share a label at different columns", () => {
    const existing = [logged({ label: "Hypotension", ts: atColumn(2) })]
    const merged = mergeWebClinicalEventsIntoLog(
      existing,
      [{ colIdx: 10, label: "Hypotension", color: "#f00" } as ClinicalEvent],
      START,
    )
    expect(merged).toHaveLength(2)
    expect(merged[1]).toMatchObject({ label: "Hypotension", ts: atColumn(10) })
  })

  // Same label, same column -- this is the genuine re-save case the dedup
  // must still catch, not a second episode.
  it("still dedupes the same label at the same column", () => {
    const existing = [logged({ label: "Hypotension", ts: atColumn(10) })]
    expect(mergeWebClinicalEventsIntoLog(
      existing,
      [{ colIdx: 10, label: "Hypotension" } as ClinicalEvent],
      START,
    )).toBe(existing)
  })
})

describe("bridgeGridVitalsIntoLog", () => {
  /**
   * The failure this exists to prevent: rebuildProjection rebuilds keyEvents
   * purely from event rows, so a vital typed into the grid by an older web
   * build vanishes on the next save unless it becomes an event first.
   */
  it("turns a grid-only vital into a vital event", () => {
    const bridged = bridgeGridVitalsIntoLog(
      [logged()],
      [null, { systolic: 120, diastolic: 80 }],
      START,
    )
    expect(bridged).toHaveLength(2)
    expect(bridged[1]).toMatchObject({ type: "vital", systolic: 120, ts: atColumn(1) })
  })

  it("does not duplicate a field a vital event has already logged at that column", () => {
    const existing = [{ id: "v1", type: "vital", ts: atColumn(1), systolic: 120 } as unknown as LogEvent]
    expect(bridgeGridVitalsIntoLog(
      existing,
      [null, { systolic: 120 }],
      START,
    )).toBe(existing)
  })

  /**
   * The regression this rewrite exists to fix. A column used to be treated as
   * fully represented the moment ANY vital event fell in it, so a systolic and
   * diastolic value sitting in the grid at a column whose only logged event
   * was a heart rate were silently dropped forever. Only the still-missing
   * fields are bridged now, and the existing heart-rate event is left alone.
   */
  it("bridges a field the grid has that no logged event at that column covers", () => {
    const existing = [{ id: "v1", type: "vital", ts: atColumn(1), heartRate: 72 } as unknown as LogEvent]
    const bridged = bridgeGridVitalsIntoLog(
      existing,
      [null, { systolic: 120, diastolic: 80, heartRate: 72 }],
      START,
    )
    expect(bridged).toHaveLength(2)
    // The original heart-rate event survives untouched, and the systolic/
    // diastolic values --- not heartRate again --- arrive as a second event at
    // the same column.
    expect(bridged[0]).toBe(existing[0])
    expect(bridged[1]).toMatchObject({ type: "vital", systolic: 120, diastolic: 80, ts: atColumn(1) })
    expect(bridged[1]).not.toHaveProperty("heartRate")
  })

  // An all-null column is an untouched cell, not a recorded observation.
  it("ignores columns holding no value at all", () => {
    const existing = [logged()]
    expect(bridgeGridVitalsIntoLog(
      existing,
      [{ systolic: null, diastolic: null }, null],
      START,
    )).toBe(existing)
  })

  it("stands down without a chart start, rather than inventing timestamps", () => {
    const existing = [logged()]
    expect(bridgeGridVitalsIntoLog(existing, [{ systolic: 120 }], null)).toBe(existing)
  })

  it("leaves an empty log alone", () => {
    expect(bridgeGridVitalsIntoLog([], [{ systolic: 120 }], START)).toEqual([])
  })
})
