import { describe, expect, it } from "vitest"
import { computeBundledBaselineArtifacts } from "./bundled-baseline-contract"
import { assertExactBundledBaselineV3Artifacts, computeBundledBaselineV3Artifacts } from "./bundled-baseline-v3"
import {
  assertExactBundledBaselineV4Artifacts,
  bundledBaselineV4AuditDetail,
  computeBundledBaselineV4Artifacts,
  LOSPOR_BUNDLED_BASELINE_V4_RELEASE,
} from "./bundled-baseline-v4"
import { isBundledV4Selection } from "./bundled-baseline-v4-provisioner"

describe("LOSPOR 10.2.0 v4 baselines", () => {
  const v3 = computeBundledBaselineV3Artifacts(computeBundledBaselineArtifacts())
  const v4 = computeBundledBaselineV4Artifacts(v3)

  it("leaves v3 exactly as released", () => {
    expect(() => assertExactBundledBaselineV3Artifacts(v3)).not.toThrow()
  })

  it("matches the pinned fingerprints; a draft change must be a new release", () => {
    expect(() => assertExactBundledBaselineV4Artifacts(v4)).not.toThrow()
  })

  it("has its own release principal", () => {
    expect(LOSPOR_BUNDLED_BASELINE_V4_RELEASE).toMatchObject({ releaseVersion: "10.2.0", technicalPrincipal: { id: "lospor-release:10.2.0", kind: "RELEASE" } })
  })

  it("records the exact change from v3: the doses SPS relies on", () => {
    const [adult, pediatric] = v4
    expect(adult.exactDiff).toMatchObject({ baselinePresetId: "lospor-adults-v3", baselinePresetVersion: 3, removed: [] })
    expect(adult.exactDiff.added.map(item => item.ruleKey)).toEqual(["ADULT_FLUID_PROFILE:GLUCOSE"])
    expect(adult.exactDiff.changed.map(item => item.ruleKey).sort()).toEqual([
      "ADULT_DRUG_PROFILE:EPINEPHRINE_ADRENALINE", "ADULT_DRUG_PROFILE:GLUCAGON", "ADULT_DRUG_PROFILE:PARACETAMOL_ACETAMINOPHEN",
      "ADULT_DRUG_PROFILE:SALBUTAMOL_ALBUTEROL", "ADULT_DRUG_PROFILE:SUGAMMADEX", "ADULT_FLUID_PROFILE:LIPID_EMULSION_20",
    ])
    expect(adult.exactDiff.unchangedRuleCount).toBe(261)
    const adrenaline = adult.exactDiff.changed.find(item => item.ruleKey === "ADULT_DRUG_PROFILE:EPINEPHRINE_ADRENALINE")
    expect(JSON.stringify(adrenaline?.before.payload)).toContain("\"flat\":500")
    expect(JSON.stringify(adrenaline?.after.payload)).not.toContain("\"flat\":500")
    expect(pediatric.exactDiff).toMatchObject({ baselinePresetId: "lospor-pediatrics-v3", baselinePresetVersion: 3 })
    expect(pediatric.exactDiff.added).toHaveLength(2)
    expect(pediatric.exactDiff.removed).toHaveLength(3)
    expect(pediatric.exactDiff.changed).toHaveLength(9)
  })

  it("stamps every rule with the v4 release", () => {
    for (const artifact of v4) {
      expect(new Set(artifact.rules.map(rule => rule.ruleVersion)))
        .toEqual(new Set([`${artifact.identity.presetKey}.v4.release-10.2.0`]))
    }
  })

  it("keeps its audit detail within the bounded contract", () => {
    expect(bundledBaselineV4AuditDetail(v4[0], true)).toMatchObject({ operation: "INSTALL_PUBLISH_SELECT", presetVersion: 4, previousPresetId: "lospor-adults-v3", releaseVersion: "10.2.0" })
    expect(bundledBaselineV4AuditDetail(v4[1], false).operation).toBe("INSTALL_PUBLISH")
  })

  it("recognises only its own principal's selections", () => {
    expect(isBundledV4Selection({ presetId: "lospor-adults-v4", selectedByTechnicalPrincipalId: "lospor-release:10.2.0" }, v4)).toBe(true)
    expect(isBundledV4Selection({ presetId: "lospor-adults-v4", selectedByTechnicalPrincipalId: "lospor-release:9.15.0" }, v4)).toBe(false)
    expect(isBundledV4Selection({ presetId: "lospor-adults-v3", selectedByTechnicalPrincipalId: "lospor-release:10.2.0" }, v4)).toBe(false)
  })
})
