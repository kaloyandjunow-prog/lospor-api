import { describe, expect, it } from "vitest"
import {
  chartAnchorFor,
  resolveChartStart,
  shouldPreserveUnanchoredSnapshot,
} from "@/lib/case-events"
import type { LogEvent } from "@/types/timetable"

const legacyStart = (hhmm: string) => new Date(`2000-01-01T${hhmm}:00.000Z`)
const eventAt = (ts: string): LogEvent => ({ id: ts, ts, type: "vital" })

describe("chart anchors", () => {
  it("uses a persisted start instant directly", () => {
    const startedAt = new Date("2026-07-21T05:00:00.000Z")
    expect(chartAnchorFor({
      startedAt,
      startTime: legacyStart("08:00"),
      createdAt: new Date("2026-07-21T05:25:00.000Z"),
    })).toEqual(startedAt)
  })

  it("does not invent an instant from a legacy wall clock", () => {
    expect(chartAnchorFor({
      startTime: legacyStart("08:00"),
      createdAt: new Date("2026-07-21T05:25:00.000Z"),
    })).toBeNull()
  })

  it("falls back to the earliest real event for legacy records", () => {
    const start = resolveChartStart(
      {
        startTime: legacyStart("08:00"),
        createdAt: new Date("2026-07-21T05:25:00.000Z"),
      },
      [
        eventAt("2026-07-21T05:30:00.000Z"),
        eventAt("2026-07-21T05:25:00.000Z"),
      ],
    )
    expect(start.toISOString()).toBe("2026-07-21T05:25:00.000Z")
  })

  for (const startedAt of [
    "2026-07-21T05:00:00.000Z",
    "2026-07-21T08:00:00.000Z",
    "2026-07-21T12:00:00.000Z",
    "2026-07-20T23:00:00.000Z",
  ]) {
    it(`keeps explicit instant ${startedAt}`, () => {
      const resolved = resolveChartStart(
        {
          startedAt: new Date(startedAt),
          startTime: null,
          createdAt: new Date(startedAt),
        },
        [eventAt(new Date(Date.parse(startedAt) + 25 * 60_000).toISOString())],
      )
      expect(resolved.toISOString()).toBe(startedAt)
    })
  }
})

// 1.4.9: a legacy snapshot is never turned back into events (reverse
// projection is retired); it is kept as stored.
describe("legacy snapshots", () => {
  it("preserves an unanchored snapshot even when an empty log array was added", () => {
    expect(shouldPreserveUnanchoredSnapshot(null, {
      vitals: [{ systolic: 120 }],
      log: [],
    })).toBe(true)
  })
})
