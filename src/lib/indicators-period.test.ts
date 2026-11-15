import { describe, expect, it } from "vitest"
import { indicatorPeriod } from "./indicators-period"

describe("the indicators period", () => {
  it("runs on Sofia calendar days, so a case started after local midnight counts today", () => {
    // 00:30 Sofia on 15 Nov is 22:30 UTC on 14 Nov: a UTC "today" was still the 14th.
    const now = new Date("2026-11-14T22:30:00Z")
    const period = indicatorPeriod(null, null, 366, now)!
    expect(period.to.toISOString()).toBe("2026-11-15T22:00:00.000Z")
    expect(period.from.toISOString()).toBe("2026-08-17T21:00:00.000Z")
  })

  it("takes the given days inclusively, across a clock change", () => {
    const period = indicatorPeriod("2026-10-24", "2026-10-25", 366)!
    expect(period.from.toISOString()).toBe("2026-10-23T21:00:00.000Z")
    expect(period.to.toISOString()).toBe("2026-10-25T22:00:00.000Z")
  })

  it("refuses a backwards period or one past the limit", () => {
    expect(indicatorPeriod("2026-03-31", "2026-03-01", 366)).toBeNull()
    expect(indicatorPeriod("2025-01-01", "2026-03-01", 366)).toBeNull()
  })
})
