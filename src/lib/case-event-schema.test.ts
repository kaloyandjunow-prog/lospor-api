import { describe, expect, it } from "vitest"

import {
  caseEventSchema,
  caseEventWriteSchema,
  formatCanonicalConcentration,
} from "./case-event-schema"

describe("caseEventSchema drug route-profile audit fields", () => {
  it("accepts the canonical selection and provenance fields", () => {
    const event = caseEventSchema.parse({
      id: "drug-1",
      type: "drug",
      name: "Bupivacaine",
      dose: "1.2",
      unit: "mL",
      drugRoute: "INTRATHECAL",
      concentration: "0.5%",
      concentrationValue: 0.5,
      concentrationUnit: "%",
      formulation: "HYPERBARIC",
      calculationBasis: "IBW",
      calculationWeightKg: 24.6,
      calculationMethod: "MCLAREN_CDC_2000",
      clinicalRuleKey: "PEDIATRIC_DRUG_PROFILE:BUPIVACAINE:0-6575",
      clinicalRuleVersion: "LOSAR_PEDIATRIC.v2.1",
      clinicalRuleSourceIds: ["ruleset-platform-v2", "rule-bupivacaine"],
      clinicalPresetId: "ruleset-user-v2",
      clinicalPresetVersion: 2,
      clinicalPresetScope: "USER",
      color: "#2563eb",
    })

    expect(event).toMatchObject({
      formulation: "HYPERBARIC",
      concentrationValue: 0.5,
      concentrationUnit: "PERCENT",
      calculationBasis: "IBW",
      calculationWeightKg: 24.6,
      calculationMethod: "MCLAREN_CDC_2000",
      clinicalPresetId: "ruleset-user-v2",
      clinicalPresetVersion: 2,
      clinicalPresetScope: "USER",
    })
    expect(event.color).toBe("#2563eb")
  })

  it("keeps legacy timetable events valid", () => {
    expect(caseEventSchema.safeParse({
      type: "drug",
      name: "Propofol",
      dose: "20",
      unit: "mg",
      concentration: "10 mg/mL",
      legacyProjectionField: true,
    }).success).toBe(true)
  })

  it("normalizes legacy concentration and calculation aliases", () => {
    expect(caseEventSchema.parse({
      type: "drug",
      concentrationValue: 10,
      concentrationUnit: "mg/mL",
      calculationBasis: "TBW_KG",
    })).toMatchObject({
      concentrationUnit: "MG_PER_ML",
      calculationBasis: "TBW",
    })
  })

  it.each([
    [{ type: "drug", formulation: "PLAIN" }],
    [{ type: "drug", concentrationValue: -0.5 }],
    [{ type: "drug", calculationWeightKg: 0 }],
    [{ type: "drug", clinicalRuleSourceIds: [""] }],
    [{ type: "drug", clinicalPresetVersion: 0 }],
    [{ type: "drug", clinicalPresetScope: "DEPARTMENT" }],
  ])("rejects malformed audit data: %j", payload => {
    expect(caseEventSchema.safeParse(payload).success).toBe(false)
  })
})

describe("formatCanonicalConcentration", () => {
  it("keeps percent compact and mass concentrations readable", () => {
    expect(formatCanonicalConcentration(0.5, "PERCENT")).toBe("0.5%")
    expect(formatCanonicalConcentration(10, "MG_PER_ML")).toBe("10 mg/mL")
  })
})

describe("caseEventSchema fluid entry modes", () => {
  it("accepts canonical rate starts, exact rate changes and delivered-volume overrides", () => {
    expect(caseEventSchema.parse({
      type: "fluid_start",
      fluidId: "fluid-1",
      name: "Plasma-Lyte",
      category: "Crystalloids",
      fluidEntryMode: "RATE",
      bagVolumeMl: 500,
      rate: 40,
      unit: "mL/h",
    })).toMatchObject({ fluidEntryMode: "RATE", bagVolumeMl: 500, rate: 40 })
    expect(caseEventSchema.safeParse({
      type: "fluid_rate",
      fluidId: "fluid-1",
      rate: "60",
      unit: "mL/h",
    }).success).toBe(true)
    expect(caseEventSchema.safeParse({
      type: "fluid_end",
      fluidId: "fluid-1",
      administeredVolumeMl: 18,
    }).success).toBe(true)
  })

  it.each([
    { type: "fluid_rate", rate: 60, unit: "mL/h" },
    { type: "fluid_rate", fluidId: "fluid-1", rate: 0, unit: "mL/h" },
    { type: "fluid_rate", fluidId: "fluid-1", rate: 60, unit: "ml/hr" },
    {
      type: "fluid_start",
      fluidId: "unknown-fluid",
      fluidEntryMode: "RATE",
      rate: 60,
      unit: "mL/h",
    },
    {
      type: "fluid_start",
      fluidId: "blood-1",
      category: "Blood products",
      fluidEntryMode: "RATE",
      rate: 60,
      unit: "mL/h",
    },
    {
      type: "fluid_start",
      fluidId: "blood-2",
      name: "Packed red blood cells (PRBC)",
      fluidEntryMode: "RATE",
      rate: 60,
      unit: "mL/h",
    },
    { type: "fluid_end", fluidId: "fluid-1", administeredVolumeMl: -1 },
  ])("rejects invalid canonical fluid events: %j", event => {
    expect(caseEventSchema.safeParse(event).success).toBe(false)
  })

  it("keeps legacy volume events valid when mode is absent", () => {
    expect(caseEventSchema.safeParse({
      type: "fluid_start",
      fluidId: "legacy-fluid",
      volume: "500",
    }).success).toBe(true)
  })
})

describe("caseEventWriteSchema timestamps", () => {
  it("requires a valid offset-aware ISO timestamp for new writes", () => {
    expect(caseEventWriteSchema.safeParse({
      type: "fluid_start",
      fluidId: "fluid-1",
      volume: "500",
    }).success).toBe(false)
    expect(caseEventWriteSchema.safeParse({
      type: "fluid_start",
      fluidId: "fluid-1",
      volume: "500",
      ts: "not-a-date",
    }).success).toBe(false)
    expect(caseEventWriteSchema.safeParse({
      type: "fluid_start",
      fluidId: "fluid-1",
      volume: "500",
      ts: "2026-08-02T08:00:00.000Z",
    }).success).toBe(true)
  })
})

describe("caseEventSchema entry times (9.13.0)", () => {
  const stop = { id: "stop-1", ts: "2026-09-27T14:43:00.000Z", type: "infusion_stop", infId: "i" }

  it("keeps when an event was entered and a stop's confirmation", () => {
    const parsed = caseEventSchema.parse({ ...stop, recordedAt: "2026-09-27T14:13:00.000Z", stopConfirmed: true })
    expect(parsed).toMatchObject({ recordedAt: "2026-09-27T14:13:00.000Z", stopConfirmed: true })
  })

  it("refuses an entry time that is not an instant", () => {
    expect(caseEventSchema.safeParse({ ...stop, recordedAt: "14:13" }).success).toBe(false)
    expect(caseEventSchema.safeParse({ ...stop, stopConfirmed: "yes" }).success).toBe(false)
  })
})

describe("an infusion pump rate (2026-10-18)", () => {
  const start = { id: "inf-1", type: "infusion_start", infId: "i", name: "Norepinephrine / Noradrenaline", rate: "0.1", unit: "mcg/kg/min", concentration: "4 mg/50 mL", calculationWeightKg: 70 }
  it("is accepted beside the dose rate and kept", () => {
    expect(caseEventSchema.parse({ ...start, volumeRateMlPerHour: 5.25 })).toMatchObject({ volumeRateMlPerHour: 5.25, rate: "0.1" })
    expect(caseEventSchema.parse(start)).not.toHaveProperty("volumeRateMlPerHour")
  })
  it("is refused when negative or beyond a pump", () => {
    expect(caseEventSchema.safeParse({ ...start, volumeRateMlPerHour: -1 }).success).toBe(false)
    expect(caseEventSchema.safeParse({ ...start, volumeRateMlPerHour: 5000 }).success).toBe(false)
  })
})

describe("a target-controlled infusion (2026-10-18)", () => {
  const tci = { id: "t", ts: "2026-10-18T08:00:00Z", type: "infusion_start", infId: "i", name: "Propofol", rate: "4", unit: "mcg/mL", tciModel: "SCHNIDER", tciSite: "EFFECT" }
  const issue = (value: Record<string, unknown>) => {
    const result = caseEventSchema.safeParse(value)
    return result.success ? null : result.error.issues.map(item => item.message).join(" | ")
  }

  it("is accepted with its model, site and a target in the model's unit", () => {
    expect(issue(tci)).toBeNull()
    expect(issue({ ...tci, name: "Remifentanil", rate: "3", unit: "ng/mL", tciModel: "MINTO" })).toBeNull()
  })

  it("is refused, saying why, with a wrong unit, no site, an unknown model or a target far out of range", () => {
    expect(issue({ ...tci, unit: "mg/kg/hr" })).toMatch(/SCHNIDER target is in mcg\/mL/)
    expect(issue({ ...tci, tciSite: undefined })).toMatch(/both its model and its site/)
    expect(issue({ ...tci, tciModel: "HOMEMADE" })).not.toBeNull()
    expect(issue({ ...tci, rate: "40" })).toMatch(/at most 16 mcg\/mL/)
    expect(issue({ ...tci, rate: "0" })).toMatch(/above 0/)
  })

  it("keeps the model on the start, and the pump total on the stop with its unit", () => {
    expect(issue({ ...tci, type: "infusion_rate" })).toMatch(/set when the infusion starts/)
    const stop = { id: "x", ts: "2026-10-18T09:00:00Z", type: "infusion_stop", infId: "i" }
    expect(issue({ ...stop, pumpTotal: 61.5, pumpTotalUnit: "mL" })).toBeNull()
    expect(issue({ ...stop, pumpTotal: 61.5 })).toMatch(/needs its unit/)
    expect(issue({ ...tci, pumpTotal: 10, pumpTotalUnit: "mL" })).toMatch(/entered on the stop/)
    expect(issue({ ...stop, pumpTotal: -1, pumpTotalUnit: "mL" })).not.toBeNull()
  })
})
