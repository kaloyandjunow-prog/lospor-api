import { describe, it, expect } from "vitest"
import {
  instantFromLocalTime, localTimeOf, legacyWallClock,
  isValidTimeZone, durationMinutesBetween,
} from "@/lib/intraop-time"

// Start times are entered as the clinician's local wall clock; events are real
// instants. Storing the former as if it were the latter put every chart an
// offset out — three hours in Bulgaria in summer — which is what these cover.

describe("instantFromLocalTime", () => {
  it("resolves a summer Sofia morning to the right instant (UTC+3)", () => {
    // 08:00 in Sofia on 21 July is 05:00 UTC.
    const got = instantFromLocalTime(new Date("2026-07-21T05:25:00.000Z"), "08:00", "Europe/Sofia")
    expect(got?.toISOString()).toBe("2026-07-21T05:00:00.000Z")
  })

  it("resolves a winter Sofia morning to the right instant (UTC+2)", () => {
    // Same wall clock, different offset — an hour's difference no fixed
    // offset could express.
    const got = instantFromLocalTime(new Date("2026-01-21T06:25:00.000Z"), "08:00", "Europe/Sofia")
    expect(got?.toISOString()).toBe("2026-01-21T06:00:00.000Z")
  })

  it("is the identity at UTC", () => {
    const got = instantFromLocalTime(new Date("2026-07-21T05:25:00.000Z"), "08:00", "UTC")
    expect(got?.toISOString()).toBe("2026-07-21T08:00:00.000Z")
  })

  it("handles a zone behind UTC", () => {
    // 08:00 in New York on 21 July (EDT, UTC-4) is 12:00 UTC.
    const got = instantFromLocalTime(new Date("2026-07-21T12:25:00.000Z"), "08:00", "America/New_York")
    expect(got?.toISOString()).toBe("2026-07-21T12:00:00.000Z")
  })

  it("takes the calendar date from the clinician's zone, not UTC", () => {
    // 01:00 on 22 July in Sofia is 22:00 on the 21st in UTC. Reading the day
    // as UTC would date the case a day early.
    const created = new Date("2026-07-21T22:10:00.000Z") // = 01:10 on the 22nd, local
    const got = instantFromLocalTime(created, "01:00", "Europe/Sofia")
    expect(got?.toISOString()).toBe("2026-07-21T22:00:00.000Z")
  })

  it("stays correct across the spring daylight-saving boundary", () => {
    // Sofia springs forward at 03:00 on 29 March 2026. 04:00 that morning is
    // already summer time (UTC+3) → 01:00 UTC.
    const got = instantFromLocalTime(new Date("2026-03-29T01:30:00.000Z"), "04:00", "Europe/Sofia")
    expect(got?.toISOString()).toBe("2026-03-29T01:00:00.000Z")
  })

  it("resolves an ambiguous repeated hour to the later instant", () => {
    // When the clocks go back, 03:30 local occurs twice in Sofia: at 00:30 UTC
    // (still summer time) and again at 01:30 UTC. There is no way to tell which
    // the clinician meant, so the resolution is fixed and documented here
    // rather than left to chance — one hour, once a year, and never silent.
    const got = instantFromLocalTime(new Date("2026-10-25T00:00:00.000Z"), "03:30", "Europe/Sofia")
    expect(got?.toISOString()).toBe("2026-10-25T01:30:00.000Z")
  })

  it("refuses a malformed time rather than guessing", () => {
    const day = new Date("2026-07-21T05:00:00.000Z")
    expect(instantFromLocalTime(day, "8:00", "Europe/Sofia")).toBeNull()
    expect(instantFromLocalTime(day, "25:00", "Europe/Sofia")).toBeNull()
    expect(instantFromLocalTime(day, "", "Europe/Sofia")).toBeNull()
  })

  it("refuses an unknown zone rather than falling back to UTC", () => {
    // A fabricated timestamp is worse than a missing one in a research record.
    const day = new Date("2026-07-21T05:00:00.000Z")
    expect(instantFromLocalTime(day, "08:00", "Mars/Olympus_Mons")).toBeNull()
    expect(instantFromLocalTime(day, "08:00", "")).toBeNull()
  })
})

describe("localTimeOf", () => {
  it("renders an instant back as local wall clock", () => {
    expect(localTimeOf(new Date("2026-07-21T05:00:00.000Z"), "Europe/Sofia")).toBe("08:00")
    expect(localTimeOf(new Date("2026-01-21T06:00:00.000Z"), "Europe/Sofia")).toBe("08:00")
    expect(localTimeOf(new Date("2026-07-21T08:00:00.000Z"), "UTC")).toBe("08:00")
  })

  it("renders midnight as 00:00, never 24:00", () => {
    expect(localTimeOf(new Date("2026-07-20T21:00:00.000Z"), "Europe/Sofia")).toBe("00:00")
  })

  it("round-trips with instantFromLocalTime", () => {
    const day = new Date("2026-07-21T05:25:00.000Z")
    for (const hhmm of ["00:00", "07:30", "12:00", "17:54", "23:59"]) {
      const instant = instantFromLocalTime(day, hhmm, "Europe/Sofia")!
      expect(localTimeOf(instant, "Europe/Sofia")).toBe(hhmm)
    }
  })

  it("returns null for an unusable zone or date", () => {
    expect(localTimeOf(new Date("2026-07-21T05:00:00.000Z"), "nope")).toBeNull()
    expect(localTimeOf(new Date("invalid"), "Europe/Sofia")).toBeNull()
  })
})

describe("legacyWallClock", () => {
  it("reads the bare HH:MM out of a legacy dummy-dated value", () => {
    expect(legacyWallClock(new Date("2000-01-01T08:00:00.000Z"))).toBe("08:00")
    expect(legacyWallClock(new Date("2000-01-01T17:54:00.000Z"))).toBe("17:54")
  })

  it("reads the old sentinel as plain midnight", () => {
    // Legacy rows cannot distinguish "never started" from a genuine midnight
    // start, which is precisely why no backfill guesses at them.
    expect(legacyWallClock(new Date("2000-01-01T00:00:00.000Z"))).toBe("00:00")
  })

  it("returns null for absent or invalid values", () => {
    expect(legacyWallClock(null)).toBeNull()
    expect(legacyWallClock(undefined)).toBeNull()
    expect(legacyWallClock(new Date("invalid"))).toBeNull()
  })
})

describe("isValidTimeZone", () => {
  it("accepts real IANA names and rejects everything else", () => {
    expect(isValidTimeZone("Europe/Sofia")).toBe(true)
    expect(isValidTimeZone("UTC")).toBe(true)
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false)
    expect(isValidTimeZone("")).toBe(false)
    expect(isValidTimeZone(undefined)).toBe(false)
    expect(isValidTimeZone(123)).toBe(false)
  })
})

describe("durationMinutesBetween", () => {
  it("measures a normal case", () => {
    expect(durationMinutesBetween(
      new Date("2026-07-21T05:00:00.000Z"),
      new Date("2026-07-21T06:30:00.000Z"),
    )).toBe(90)
  })

  it("measures a case crossing midnight without special handling", () => {
    // Real instants make this arithmetic, not a puzzle about +1 day flags.
    expect(durationMinutesBetween(
      new Date("2026-07-21T20:00:00.000Z"),
      new Date("2026-07-22T01:30:00.000Z"),
    )).toBe(330)
  })

  it("measures a case spanning the autumn clock change in real elapsed time", () => {
    // Sofia falls back at 04:00 local on 25 October 2026, so 03:00–04:00
    // happens twice. A case from 02:00 to 05:00 local reads as three hours on
    // the wall but really ran four — exactly the kind of error a wall clock
    // cannot represent and an instant can.
    const start = instantFromLocalTime(new Date("2026-10-25T00:00:00.000Z"), "02:00", "Europe/Sofia")!
    expect(start.toISOString()).toBe("2026-10-24T23:00:00.000Z") // still UTC+3
    const end = new Date("2026-10-25T03:00:00.000Z")             // 05:00 local, now UTC+2
    expect(localTimeOf(end, "Europe/Sofia")).toBe("05:00")
    expect(durationMinutesBetween(start, end)).toBe(240)
  })

  it("returns null when either end is missing", () => {
    const t = new Date("2026-07-21T05:00:00.000Z")
    expect(durationMinutesBetween(null, t)).toBeNull()
    expect(durationMinutesBetween(t, null)).toBeNull()
    expect(durationMinutesBetween(null, null)).toBeNull()
  })
})
