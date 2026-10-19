import { describe, expect, it } from "vitest"
import { computeBundledBaselineArtifacts } from "./bundled-baseline-contract"
import {
  assertExactBundledBaselineV3Artifacts,
  bundledBaselineV3AuditDetail,
  computeBundledBaselineV3Artifacts,
} from "./bundled-baseline-v3"

describe("LOSPOR 9.15.0 v3 baselines", () => {
  const v3 = computeBundledBaselineV3Artifacts(computeBundledBaselineArtifacts())

  it("matches the pinned fingerprints; a draft change must be a new release", () => {
    expect(() => assertExactBundledBaselineV3Artifacts(v3)).not.toThrow()
  })

  it("records the exact change from v2: plain Ringer added; mannitol, adjuvant routes, epidural fentanyl and regrouped drugs changed", () => {
    const [adult, pediatric] = v3
    expect(adult.exactDiff).toMatchObject({ baselinePresetId: "lospor-adults-v2", baselinePresetVersion: 2, removed: [] })
    // Plain Ringer and the 15 infusions added on 2026-10-18.
    expect(adult.exactDiff.added).toHaveLength(16)
    expect(adult.exactDiff.added.map(item => item.ruleKey)).toContain("ADULT_FLUID_PROFILE:RINGER_S_SOLUTION")
    expect(adult.exactDiff.added.map(item => item.ruleKey)).toContain("ADULT_INFUSION_PROFILE:URAPIDIL")
    expect(adult.exactDiff.changed).toHaveLength(59)
    expect(adult.exactDiff.unchangedRuleCount).toBe(192)
    // Children also get the prefill review: bands split by age or weight
    // replace the 12 single bands they came from; ropivacaine infusions take
    // the 3-month boundary of the other local anaesthetics (2 more).
    expect(pediatric.exactDiff.added).toHaveLength(46)
    expect(pediatric.exactDiff.removed).toHaveLength(14)
    expect(pediatric.exactDiff.removed.map(item => item.ruleKey)).toContain("PEDIATRIC_DRUG_PROFILE:BUPIVACAINE:0-6574.365")
    expect(pediatric.exactDiff.changed).toHaveLength(178)
    const mannitol = adult.exactDiff.changed.find(item => item.ruleKey === "ADULT_FLUID_PROFILE:MANNITOL")
    expect(JSON.stringify(mannitol?.before.payload)).not.toContain("20%")
    expect(JSON.stringify(mannitol?.after.payload)).toContain("20%")
    const morphine = adult.exactDiff.changed.find(item => item.ruleKey === "ADULT_DRUG_PROFILE:MORPHINE")
    expect(JSON.stringify(morphine?.after.payload)).toContain("INTRATHECAL")
    expect(adult.exactDiff.changed.map(item => item.ruleKey)).toContain("ADULT_INFUSION_PROFILE:FENTANYL")
  })

  it("stamps every rule with the v3 release", () => {
    for (const artifact of v3) {
      expect(new Set(artifact.rules.map(rule => rule.ruleVersion)))
        .toEqual(new Set([`${artifact.identity.presetKey}.v3.release-9.15.0`]))
    }
  })

  it("keeps its audit detail within the bounded contract", () => {
    expect(bundledBaselineV3AuditDetail(v3[0], true)).toMatchObject({ operation: "INSTALL_PUBLISH_SELECT", presetVersion: 3, previousPresetId: "lospor-adults-v2" })
    expect(bundledBaselineV3AuditDetail(v3[1], false).operation).toBe("INSTALL_PUBLISH")
  })
})
