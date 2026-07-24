import { describe, expect, it } from "vitest"
import { mapIntraop, mapIntraopUpdate } from "@/app/v1/cases/_mappers"

describe("mapIntraop timing", () => {
  it("preserves an overnight end instant in the case timezone", () => {
    const mapped = mapIntraop({
      startTime: "23:55",
      endTime: "00:20",
      endTimeNextDay: true,
      timezone: "Europe/Sofia",
      caseDay: "2026-07-24T10:00:00.000Z",
    })
    expect(mapped.startedAt).toEqual(new Date("2026-07-24T20:55:00.000Z"))
    expect(mapped.endedAt).toEqual(new Date("2026-07-24T21:20:00.000Z"))
    expect(mapped.durationMinutes).toBe(25)
  })

  it("keeps explicit instants authoritative", () => {
    const mapped = mapIntraop({
      startTime: "11:45",
      endTime: "13:00",
      startedAt: "2026-07-24T08:45:00.000Z",
      endedAt: "2026-07-24T10:00:00.000Z",
      timezone: "Europe/Sofia",
    })
    expect(mapped.startedAt).toEqual(new Date("2026-07-24T08:45:00.000Z"))
    expect(mapped.endedAt).toEqual(new Date("2026-07-24T10:00:00.000Z"))
    expect(mapped.durationMinutes).toBe(75)
  })

  it("allows resume to clear the persisted end instant", () => {
    expect(mapIntraopUpdate({ endTime: null, endedAt: null })).toMatchObject({
      endTime: null,
      endedAt: null,
    })
  })

  it("does not invent an instant for a wall-clock-only partial update", () => {
    const mapped = mapIntraopUpdate({
      startTime: "11:45",
      timezone: "Europe/Sofia",
    })
    expect(mapped.startTime).toEqual(new Date("2000-01-01T11:45:00.000Z"))
    expect(mapped).not.toHaveProperty("startedAt")
  })
})
