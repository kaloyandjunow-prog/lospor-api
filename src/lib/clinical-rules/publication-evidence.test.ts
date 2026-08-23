import { describe, expect, it } from "vitest"
import type { ClinicalRulePayload } from "@lospor/core/clinical-rules"
import {
  buildClinicalRulesetExactDiff,
  canonicalClinicalRulesJson,
} from "./publication-evidence"

function rule(ruleKey: string, max: number, sourceRefs = ["source-b", "source-a"]) {
  return {
    ruleKey,
    ruleVersion: "v1",
    payload: {
      kind: "ADULT_DRUG_PROFILE",
      itemKey: ruleKey,
      labelEn: ruleKey,
      profile: { routeModes: { IV: { max, min: 0 } }, routes: ["IV"] },
      unit: null,
      routeUnits: {},
    } as unknown as ClinicalRulePayload,
    sourceRefs,
  }
}

describe("clinical rules publication evidence", () => {
  it("canonicalizes object keys without changing array order", () => {
    expect(canonicalClinicalRulesJson({ z: 1, a: { y: 2, x: [3, 1] } }))
      .toBe('{"a":{"x":[3,1],"y":2},"z":1}')
  })

  it("records self-contained added, removed, and changed payloads", () => {
    const result = buildClinicalRulesetExactDiff({
      baselinePresetId: "platform-1",
      baselinePresetVersion: 4,
      baselineRules: [rule("A", 10), rule("B", 20), rule("D", 40)],
      nextRules: [rule("A", 10, ["source-a", "source-b"]), rule("B", 25), rule("C", 30)],
    })
    expect(result.exactDiff.unchangedRuleCount).toBe(1)
    expect(result.exactDiff.added.map(item => item.ruleKey)).toEqual(["C"])
    expect(result.exactDiff.removed.map(item => item.ruleKey)).toEqual(["D"])
    expect(result.exactDiff.changed.map(item => item.ruleKey)).toEqual(["B"])
    expect(result.exactDiff.changed[0]?.before.payload).toBeTruthy()
    expect(result.exactDiff.changed[0]?.after.payload).toBeTruthy()
    expect(result.contentSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.diffSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it("is deterministic across input ordering and source-reference ordering", () => {
    const left = buildClinicalRulesetExactDiff({
      baselinePresetId: "p",
      baselinePresetVersion: 1,
      baselineRules: [rule("B", 2), rule("A", 1)],
      nextRules: [rule("A", 3), rule("B", 2)],
    })
    const right = buildClinicalRulesetExactDiff({
      baselinePresetId: "p",
      baselinePresetVersion: 1,
      baselineRules: [rule("A", 1, ["source-a", "source-b"]), rule("B", 2)],
      nextRules: [rule("B", 2), rule("A", 3, ["source-a", "source-b"])],
    })
    expect(right).toEqual(left)
  })
})
