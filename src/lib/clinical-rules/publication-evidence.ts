import { createHash } from "node:crypto"
import type { ClinicalRulePayload } from "@lospor/core/clinical-rules"

export type ClinicalRuleEvidenceSnapshot = {
  ruleKey: string
  ruleVersion: string
  payload: ClinicalRulePayload
  sourceRefs: string[]
}

export type ClinicalRulesetExactDiff = {
  schemaVersion: 1
  baselinePresetId: string | null
  baselinePresetVersion: number | null
  added: Array<{
    ruleKey: string
    afterSha256: string
    after: ClinicalRuleEvidenceSnapshot
  }>
  removed: Array<{
    ruleKey: string
    beforeSha256: string
    before: ClinicalRuleEvidenceSnapshot
  }>
  changed: Array<{
    ruleKey: string
    beforeSha256: string
    afterSha256: string
    before: ClinicalRuleEvidenceSnapshot
    after: ClinicalRuleEvidenceSnapshot
  }>
  unchangedRuleCount: number
}

/** Stable JSON used only for hashes and immutable evidence, never display. */
export function canonicalClinicalRulesJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null)
  if (Array.isArray(value)) {
    return `[${value.map(canonicalClinicalRulesJson).join(",")}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, item]) => (
    `${JSON.stringify(key)}:${canonicalClinicalRulesJson(item)}`
  )).join(",")}}`
}

export function clinicalRulesSha256(value: unknown): string {
  return createHash("sha256").update(canonicalClinicalRulesJson(value)).digest("hex")
}

function normalized(snapshot: ClinicalRuleEvidenceSnapshot): ClinicalRuleEvidenceSnapshot {
  return {
    ruleKey: snapshot.ruleKey,
    ruleVersion: snapshot.ruleVersion,
    payload: snapshot.payload,
    sourceRefs: [...snapshot.sourceRefs].sort(),
  }
}

function snapshotHash(snapshot: ClinicalRuleEvidenceSnapshot): string {
  return clinicalRulesSha256(normalized(snapshot))
}

/**
 * Produce a byte-deterministic, self-contained diff of a draft against the
 * canonical platform preset it derives from. Before/after payloads are kept so
 * a later reviewer does not have to trust mutable source rows or prose.
 */
export function buildClinicalRulesetExactDiff(input: {
  baselinePresetId: string | null
  baselinePresetVersion: number | null
  baselineRules: ClinicalRuleEvidenceSnapshot[]
  nextRules: ClinicalRuleEvidenceSnapshot[]
}): {
  exactDiff: ClinicalRulesetExactDiff
  contentSha256: string
  diffSha256: string
} {
  const baseline = new Map(input.baselineRules.map(item => [item.ruleKey, normalized(item)]))
  const next = new Map(input.nextRules.map(item => [item.ruleKey, normalized(item)]))
  const keys = [...new Set([...baseline.keys(), ...next.keys()])].sort()
  const exactDiff: ClinicalRulesetExactDiff = {
    schemaVersion: 1,
    baselinePresetId: input.baselinePresetId,
    baselinePresetVersion: input.baselinePresetVersion,
    added: [],
    removed: [],
    changed: [],
    unchangedRuleCount: 0,
  }

  for (const ruleKey of keys) {
    const before = baseline.get(ruleKey)
    const after = next.get(ruleKey)
    if (!before && after) {
      exactDiff.added.push({ ruleKey, afterSha256: snapshotHash(after), after })
      continue
    }
    if (before && !after) {
      exactDiff.removed.push({ ruleKey, beforeSha256: snapshotHash(before), before })
      continue
    }
    if (!before || !after) continue
    const beforeSha256 = snapshotHash(before)
    const afterSha256 = snapshotHash(after)
    if (beforeSha256 === afterSha256) {
      exactDiff.unchangedRuleCount += 1
    } else {
      exactDiff.changed.push({ ruleKey, beforeSha256, afterSha256, before, after })
    }
  }

  const nextContent = [...next.values()].sort((left, right) => (
    left.ruleKey.localeCompare(right.ruleKey)
  ))
  return {
    exactDiff,
    contentSha256: clinicalRulesSha256(nextContent),
    diffSha256: clinicalRulesSha256(exactDiff),
  }
}
