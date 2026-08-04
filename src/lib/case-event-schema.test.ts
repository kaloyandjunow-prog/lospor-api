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
