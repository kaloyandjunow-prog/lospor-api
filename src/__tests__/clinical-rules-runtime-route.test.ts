import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  clinicalPresetRulesToEffective,
  clinicalRuleKey,
  validateClinicalRulePayload,
} from "@lospor/core/clinical-rules"

const getAuthUserMock = vi.fn()
const effectiveRulesMock = vi.fn()

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: getAuthUserMock }))
vi.mock("@/lib/clinical-rules/service", () => ({
  effectiveClinicalRulesForUser: effectiveRulesMock,
}))

function pediatricProfileRule() {
  const parsed = validateClinicalRulePayload({
    kind: "PEDIATRIC_DRUG_PROFILE",
    medicationKey: "ATROPINE",
    labelEn: "Atropine",
    minimumAgeDays: 0,
    maximumAgeDaysExclusive: 18 * 365.2425,
    profile: {
      routes: ["IV", "IM"],
      defaultRoute: "IV",
      routeModes: {
        IV: {
          min: 0,
          max: 2,
          step: 0.1,
          unit: "mg",
          quickValues: [0.1, 0.2, 0.3],
          doseCalc: { perKg: 0.01, basis: "TBW", roundTo: 0.1 },
        },
        IM: {
          min: 0,
          max: 2,
          step: 0.1,
          unit: "mg",
          quickValues: [0.1, 0.2],
          doseCalc: { perKg: 0.02, basis: "TBW", roundTo: 0.1 },
        },
      },
    },
  })
  if (!parsed.valid) throw new Error(JSON.stringify(parsed.issues))
  const fluid = validateClinicalRulePayload({
    kind: "PEDIATRIC_FLUID_PROFILE",
    itemKey: "PLASMA_LYTE",
    labelEn: "Plasma-Lyte",
    category: "Crystalloids",
    minimumAgeDays: 0,
    maximumAgeDaysExclusive: 18 * 365.2425,
    profile: {
      min: 0,
      max: 2_000,
      step: 10,
      unit: "mL",
      fluidEntryModes: ["VOLUME", "RATE"],
      defaultFluidEntryMode: "RATE",
      fluidRate: {
        min: 1,
        max: 200,
        step: 1,
        allowManualOutsideRange: true,
        calculation: "HOLLIDAY_SEGAR_4_2_1",
      },
    },
  })
  if (!fluid.valid) throw new Error(JSON.stringify(fluid.issues))
  const infusion = validateClinicalRulePayload({
    kind: "PEDIATRIC_INFUSION_PROFILE",
    itemKey: "Propofol",
    labelEn: "Propofol",
    disposition: "AUTO",
    routeDispositions: {},
    manualEntryOnly: false,
    routeManualEntryOnly: {},
    minimumAgeDays: 28,
    maximumAgeDaysExclusive: 18 * 365.2425,
    profile: {
      mode: "rate",
      min: 0,
      max: 15,
      step: 0.5,
      quickValues: [6, 8, 10, 12, 15],
      unit: "mg/kg/hr",
      routes: ["IV"],
      defaultRoute: "IV",
      weightBasis: "TBW",
      suggestedRate: 10,
    },
  })
  if (!infusion.valid) throw new Error(JSON.stringify(infusion.issues))
  return clinicalPresetRulesToEffective("pediatric-preset", "INSTITUTION", [
    {
      id: "atropine-profile",
      ruleKey: clinicalRuleKey(parsed.value),
      ruleVersion: "pediatric-preset.v2.1",
      payload: parsed.value,
      sourceRefs: ["local-policy-v4"],
    },
    {
      id: "plasma-lyte-profile",
      ruleKey: clinicalRuleKey(fluid.value),
      ruleVersion: "pediatric-preset.v2.1",
      payload: fluid.value,
      sourceRefs: ["local-fluid-policy-v1"],
    },
    {
      id: "propofol-infusion-profile",
      ruleKey: clinicalRuleKey(infusion.value),
      ruleVersion: "pediatric-preset.v2.1",
      payload: infusion.value,
      sourceRefs: ["local-infusion-policy-v1"],
    },
  ])
}

describe("clinical rules runtime route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAuthUserMock.mockResolvedValue({ id: "user-1", institutionId: "inst-1" })
    effectiveRulesMock.mockResolvedValue({
      presetId: "pediatric-preset",
      presetName: "Pediatric rules",
      presetVersion: 2,
      scope: "INSTITUTION",
      rules: pediatricProfileRule(),
    })
  })

  it("returns canonical one-drug route profiles alongside the legacy field", async () => {
    const { GET } = await import("@/app/v1/clinical/rules/runtime/route")
    const response = await GET(new Request(
      "http://localhost/v1/clinical/rules/runtime?mode=PEDIATRIC",
    ) as Parameters<typeof GET>[0])
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.productionReady).toBe(true)
    expect(body).not.toHaveProperty("adultEquipmentPolicy")
    expect(body.doseProfiles).toEqual([])
    expect(body.pediatricDrugProfiles).toEqual([
      expect.objectContaining({
        ruleKey: "PEDIATRIC_DRUG_PROFILE:ATROPINE:0-6574.365",
        medicationKey: "ATROPINE",
        presetId: "pediatric-preset",
        sourceIds: [
          "preset:pediatric-preset",
          "rule:atropine-profile",
          "local-policy-v4",
        ],
        profile: expect.objectContaining({ defaultRoute: "IV", routes: ["IV", "IM"] }),
      }),
    ])
    expect(body.pediatricFluidProfiles).toEqual([
      expect.objectContaining({
        ruleKey: "PEDIATRIC_FLUID_PROFILE:PLASMA_LYTE:0-6574.365",
        itemKey: "PLASMA_LYTE",
        presetId: "pediatric-preset",
        profile: expect.objectContaining({ defaultFluidEntryMode: "RATE" }),
      }),
    ])
    expect(body.pediatricInfusionProfiles).toEqual([
      expect.objectContaining({
        ruleKey: "PEDIATRIC_INFUSION_PROFILE:PROPOFOL:28-6574.365:ANY-ANY",
        itemKey: "Propofol",
        disposition: "AUTO",
        presetId: "pediatric-preset",
        profile: expect.objectContaining({ suggestedRate: 10, unit: "mg/kg/hr" }),
      }),
    ])
  })
})
