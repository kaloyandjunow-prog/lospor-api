import { describe, expect, it } from "vitest"
import { computeBundledBaselineArtifacts } from "./bundled-baseline-contract"
import { assertExactBundledBaselineV3Artifacts, computeBundledBaselineV3Artifacts } from "./bundled-baseline-v3"
import { assertExactBundledBaselineV4Artifacts, computeBundledBaselineV4Artifacts } from "./bundled-baseline-v4"
import {
  assertExactBundledBaselineV5Artifacts,
  bundledBaselineV5AuditDetail,
  computeBundledBaselineV5Artifacts,
  LOSPOR_BUNDLED_BASELINE_V5_RELEASE,
} from "./bundled-baseline-v5"
import { isBundledV5Selection } from "./bundled-baseline-v5-provisioner"

describe("LOSPOR 10.7.0 v5 baselines", () => {
  const v3 = computeBundledBaselineV3Artifacts(computeBundledBaselineArtifacts())
  const v4 = computeBundledBaselineV4Artifacts(v3)
  const v5 = computeBundledBaselineV5Artifacts(v4)

  it("leaves v3 and v4 exactly as released", () => {
    expect(() => assertExactBundledBaselineV3Artifacts(v3)).not.toThrow()
    expect(() => assertExactBundledBaselineV4Artifacts(v4)).not.toThrow()
  })

  it("matches the pinned fingerprints; a draft change must be a new release", () => {
    expect(() => assertExactBundledBaselineV5Artifacts(v5)).not.toThrow()
  })

  it("has its own release principal", () => {
    expect(LOSPOR_BUNDLED_BASELINE_V5_RELEASE).toMatchObject({ releaseVersion: "10.7.0", technicalPrincipal: { id: "lospor-release:10.7.0", kind: "RELEASE" } })
  })

  it("records the exact change from v4: the three inhaled agents as rules, nothing else", () => {
    const [adult, pediatric] = v5
    expect(adult.exactDiff).toMatchObject({ baselinePresetId: "lospor-adults-v4", baselinePresetVersion: 4, removed: [], changed: [], unchangedRuleCount: 268 })
    expect(adult.exactDiff.added.map(item => item.ruleKey).sort()).toEqual([
      "ADULT_AGENT_PROFILE:DESFLURANE", "ADULT_AGENT_PROFILE:ISOFLURANE", "ADULT_AGENT_PROFILE:SEVOFLURANE",
    ])
    expect(pediatric.exactDiff).toMatchObject({ baselinePresetId: "lospor-pediatrics-v4", baselinePresetVersion: 4, removed: [], changed: [], unchangedRuleCount: 366 })
    expect(pediatric.exactDiff.added).toHaveLength(3)
  })

  it("carries the values in use before they were rules", () => {
    const sevoflurane = v5[0].rules.find(rule => rule.ruleKey === "ADULT_AGENT_PROFILE:SEVOFLURANE")
    expect(sevoflurane?.payload).toMatchObject({ profile: { min: 0, max: 8, step: 0.1, quickValues: [1, 2, 2.5, 3, 8] } })
    const desflurane = v5[1].rules.find(rule => rule.ruleKey.startsWith("PEDIATRIC_AGENT_PROFILE:DESFLURANE"))
    expect(desflurane?.payload).toMatchObject({ profile: { min: 0, max: 18, step: 0.1, quickValues: [4, 6, 8, 12, 18] } })
  })

  it("stamps every rule with the v5 release", () => {
    for (const artifact of v5) {
      expect(new Set(artifact.rules.map(rule => rule.ruleVersion)))
        .toEqual(new Set([`${artifact.identity.presetKey}.v5.release-10.7.0`]))
    }
  })

  it("keeps its audit detail within the bounded contract", () => {
    expect(bundledBaselineV5AuditDetail(v5[0], true)).toMatchObject({ operation: "INSTALL_PUBLISH_SELECT", presetVersion: 5, previousPresetId: "lospor-adults-v4", releaseVersion: "10.7.0" })
    expect(bundledBaselineV5AuditDetail(v5[1], false).operation).toBe("INSTALL_PUBLISH")
  })

  it("recognises only its own principal's selections", () => {
    expect(isBundledV5Selection({ presetId: "lospor-adults-v5", selectedByTechnicalPrincipalId: "lospor-release:10.7.0" }, v5)).toBe(true)
    expect(isBundledV5Selection({ presetId: "lospor-adults-v5", selectedByTechnicalPrincipalId: "lospor-release:10.2.0" }, v5)).toBe(false)
    expect(isBundledV5Selection({ presetId: "lospor-adults-v4", selectedByTechnicalPrincipalId: "lospor-release:10.7.0" }, v5)).toBe(false)
  })
})
