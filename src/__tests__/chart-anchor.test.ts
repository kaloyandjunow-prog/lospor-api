import { describe, expect, it } from "vitest"
import {
  chartAnchorFor,
  resolveChartStart,
  shouldPreserveUnanchoredSnapshot,
  snapshotLogForReconcile,
} from "@/lib/case-events"
import type { LegacyKeyEvents, LogEvent } from "@/types/timetable"

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

describe("legacy snapshot reconciliation", () => {
  it("does not convert a snapshot without a trusted start instant", () => {
    const snapshot: LegacyKeyEvents = { vitals: [{ systolic: 120 }] }
    expect(snapshotLogForReconcile(snapshot, null)).toBeNull()
  })

  it("rejects the reported Sofia mirror that would create future vitals", () => {
    // 11:45 Europe/Sofia is 08:45Z. At 13:00 local (10:00Z), column 36
    // represents 14:45 local and must never be synthesized.
    const vitals = Array.from({ length: 37 }, () => ({}))
    vitals[0] = { systolic: 150 }
    vitals[36] = { systolic: 150 }
    const snapshot: LegacyKeyEvents = { vitals }
    expect(snapshotLogForReconcile(
      snapshot,
      Date.parse("2026-07-24T08:45:00.000Z"),
      Date.parse("2026-07-24T10:00:00.000Z"),
    )).toBeNull()
  })

  it("converts past columns when the start instant is trusted", () => {
    const snapshot: LegacyKeyEvents = {
      vitals: [{ systolic: 120 }, {}, { systolic: 118 }],
    }
    const log = snapshotLogForReconcile(
      snapshot,
      Date.parse("2026-07-24T08:45:00.000Z"),
      Date.parse("2026-07-24T10:00:00.000Z"),
    )
    expect(log?.map(event => event.ts)).toEqual([
      "2026-07-24T08:45:00.000Z",
      "2026-07-24T08:55:00.000Z",
    ])
  })

  it("preserves an explicit event log without re-dating it", () => {
    const log = [eventAt("2026-07-24T08:45:00.000Z")]
    expect(snapshotLogForReconcile({ log }, null)).toEqual(log)
  })

  it("preserves an unanchored snapshot even when an empty log array was added", () => {
    expect(shouldPreserveUnanchoredSnapshot(null, {
      vitals: [{ systolic: 120 }],
      log: [],
    })).toBe(true)
  })
})
