import { describe, expect, it } from "vitest"
import { Prisma } from "@/generated/prisma/client"
import { mapPreop, mapIntraop, mapIntraopUpdate } from "./_mappers"

describe("mapPreop — mobile/legacy aliases → canonical fields", () => {
  it("maps ulbt / difficultAirway / familyProblems aliases", () => {
    const r = mapPreop({ ulbt: "II", difficultAirway: true, familyProblems: true, familyProblemNotes: "MH risk" })
    expect(r.upperLipBiteTest).toBe("CLASS_II")
    expect(r.difficultAirwayHistory).toBe(true)
    expect(r.familyAnesthesiaProblems).toBe(true)
    expect(r.familyAnesthesiaDetails).toBe("MH risk")
  })

  it("drops family details when there is no family problem", () => {
    const r = mapPreop({ familyProblems: false, familyProblemNotes: "ignored" })
    expect(r.familyAnesthesiaProblems).toBe(false)
    expect(r.familyAnesthesiaDetails).toBeNull()
  })
})

describe("mapPreop — BMI validation", () => {
  it("computes BMI from height+weight when none supplied", () => {
    const r = mapPreop({ heightCm: 180, weightKg: 80 })
    expect(r.bmi).toBeCloseTo(24.69, 1)
  })
  it("keeps a client BMI within 10% of computed", () => {
    const r = mapPreop({ heightCm: 180, weightKg: 80, bmi: 24.7 })
    expect(r.bmi).toBe(24.7)
  })
  it("discards a client BMI that diverges >10%", () => {
    const r = mapPreop({ heightCm: 180, weightKg: 80, bmi: 50 })
    expect(r.bmi).toBeCloseTo(24.69, 1)
  })
  it("BMI null when biometrics missing", () => {
    expect(mapPreop({}).bmi).toBeNull()
  })
})

describe("mapPreop — biometrics + enums + structured lists", () => {
  it("uses null (not 0) for missing biometrics and UNKNOWN for missing sex", () => {
    const r = mapPreop({})
    expect(r.ageYears).toBeNull()
    expect(r.heightCm).toBeNull()
    expect(r.weightKg).toBeNull()
    // Not OTHER: "nobody recorded it" and "recorded as other" are different
    // facts, and a research register must not merge them.
    expect(r.sex).toBe("UNKNOWN")
  })

  it("keeps an explicitly recorded OTHER distinct from unrecorded", () => {
    expect(mapPreop({ sex: "OTHER" }).sex).toBe("OTHER")
    expect(mapPreop({}).sex).toBe("UNKNOWN")
  })

  it("validates blood-type enum", () => {
    expect(mapPreop({ bloodType: "A" }).bloodType).toBe("A")
    expect(mapPreop({ bloodType: "Z" }).bloodType).toBeNull()
  })

  it("builds legacy strings + JSON columns + icdCode from diagnoses/procedures", () => {
    const r = mapPreop({
      diagnoses: [{ label: "Appendicitis", sub: "K35.8" }],
      procedures: [{ label: "Appendectomy", code: "0DTJ4ZZ" }],
    })
    expect(r.diagnosis).toBe("Appendicitis")
    expect(r.plannedProcedure).toBe("Appendectomy")
    expect(r.icdCode).toBe("K35.8")
    expect(Array.isArray(r.diagnosesJson)).toBe(true)
  })

  it("uses Prisma.JsonNull for empty diagnosis/procedure arrays", () => {
    const r = mapPreop({})
    expect(r.diagnosesJson).toBe(Prisma.JsonNull)
    expect(r.proceduresJson).toBe(Prisma.JsonNull)
    expect(r.diagnosis).toBe("")
  })

  it("serializes tagged medication lists to JSON storage", () => {
    const r = mapPreop({ currentMedications: [{ label: "Aspirin", atcCode: "B01AC06" }] })
    expect(typeof r.currentMedications).toBe("string")
    expect(JSON.parse(r.currentMedications as string)[0]).toMatchObject({ label: "Aspirin", atcCode: "B01AC06" })
  })
})

// ── Start/end times ──────────────────────────────────────────────────────────
//
// Two bugs shared one cause: the column could not express "not started yet", so
// the code faked it as midnight — and a JS Date is always truthy, so every
// `if (startTime)` guard in the app passed for a case nobody had started. On the
// web that locked the Timing field to "00:00" with no way back.
//
// The second, quieter half: a bare wall clock has no timezone, so it could not
// be compared against event timestamps, which are real instants.

describe("mapIntraop — start time is never fabricated", () => {
  it("leaves startTime null when the payload does not mention it", () => {
    // The first intraop autosave fires on any watched field — a monitoring
    // checkbox is enough — long before Timing is touched.
    const r = mapIntraop({ ecg: true })
    expect(r.startTime).toBeNull()
    expect(r.startedAt ?? null).toBeNull()
  })

  it("leaves startTime null for a malformed time rather than defaulting", () => {
    expect(mapIntraop({ startTime: "" }).startTime).toBeNull()
    expect(mapIntraop({ startTime: "8:00" }).startTime).toBeNull()
    expect(mapIntraop({ startTime: "25:00" }).startTime).toBeNull()
  })

  it("never writes the old midnight sentinel", () => {
    // The specific value that caused the lockout.
    const sentinel = new Date("2000-01-01T00:00:00.000Z").getTime()
    expect((mapIntraop({}).startTime as Date | null)?.getTime()).not.toBe(sentinel)
  })

  it("still stores a real wall clock in the legacy column", () => {
    const r = mapIntraop({ startTime: "08:00" })
    expect((r.startTime as Date).toISOString()).toBe("2000-01-01T08:00:00.000Z")
  })

  it("accepts a genuine midnight start", () => {
    // Night lists are real. "00:00" must remain distinguishable from "unset",
    // which is exactly what the sentinel made impossible.
    const r = mapIntraop({ startTime: "00:00", timezone: "UTC", caseDay: new Date("2026-07-21T00:00:00.000Z") })
    expect(r.startTime).not.toBeNull()
    expect((r.startedAt as Date).toISOString()).toBe("2026-07-21T00:00:00.000Z")
  })
})

describe("mapIntraop — wall clock resolves to a real instant", () => {
  const day = new Date("2026-07-21T05:25:00.000Z") // 08:25 in Sofia

  it("converts local time to the correct UTC instant (UTC+3)", () => {
    const r = mapIntraop({ startTime: "08:00", timezone: "Europe/Sofia", caseDay: day })
    expect((r.startedAt as Date).toISOString()).toBe("2026-07-21T05:00:00.000Z")
    expect(r.timezone).toBe("Europe/Sofia")
  })

  it("computes duration from the instants, not the wall clock", () => {
    const r = mapIntraop({
      startTime: "08:00", endTime: "09:30",
      timezone: "Europe/Sofia", caseDay: day,
    })
    expect(r.durationMinutes).toBe(90)
  })

  it("leaves instants null when no usable zone is supplied", () => {
    // A guessed timestamp is worse than a missing one: it cannot be told apart
    // from a real one later.
    const r = mapIntraop({ startTime: "08:00", caseDay: day })
    expect(r.startedAt).toBeNull()
    expect(r.timezone).toBeNull()
    expect((r.startTime as Date).toISOString()).toBe("2000-01-01T08:00:00.000Z")
  })

  it("ignores a bogus timezone rather than falling back to UTC", () => {
    const r = mapIntraop({ startTime: "08:00", timezone: "Mars/Olympus_Mons", caseDay: day })
    expect(r.startedAt).toBeNull()
    expect(r.timezone).toBeNull()
  })

  it("accepts a full ISO instant sent directly by a client", () => {
    const r = mapIntraop({ startedAt: "2026-07-21T05:00:00.000Z", timezone: "Europe/Sofia" })
    expect((r.startedAt as Date).toISOString()).toBe("2026-07-21T05:00:00.000Z")
  })
})

describe("mapIntraopUpdate — a partial save never blanks a stored time", () => {
  it("omits startTime entirely when the payload does not mention it", () => {
    const r = mapIntraopUpdate({ ecg: true })
    expect("startTime" in r).toBe(false)
    expect("startedAt" in r).toBe(false)
  })

  it("omits startTime when the value is present but malformed", () => {
    // Otherwise an autosave carrying a half-typed time would erase a real one.
    const r = mapIntraopUpdate({ startTime: "" })
    expect(r.startTime).toBeUndefined()
  })

  it("writes both forms when the client supplies a wall clock and real instant", () => {
    const r = mapIntraopUpdate({
      startTime: "08:00",
      startedAt: "2026-07-21T05:00:00.000Z",
      timezone: "Europe/Sofia",
    })
    expect((r.startTime as Date).toISOString()).toBe("2000-01-01T08:00:00.000Z")
    expect((r.startedAt as Date).toISOString()).toBe("2026-07-21T05:00:00.000Z")
    expect(r.timezone).toBe("Europe/Sofia")
  })
})
