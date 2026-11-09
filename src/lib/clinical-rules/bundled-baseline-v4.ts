import { createHash } from "node:crypto"
import { clinicalRuleKey } from "@lospor/core/clinical-rules"
import {
  createLosporAdultV4Draft,
  createLosporPediatricV4Draft,
  type PlatformClinicalDraft,
} from "@lospor/core/platform-clinical-drafts"
import {
  canonicalBundledBaselineJson,
  type BundledBaselineRule,
} from "./bundled-baseline-contract"
import type { BundledBaselineV3Artifact } from "./bundled-baseline-v3"

/**
 * The v4 clinical baselines bundled with LOSPOR 10.2.0: v3 over the current
 * catalogues, with the doses SPS relies on (see
 * createLosporAdultV4Draft and createLosporPediatricV4Draft in core).
 *
 * A later release than 9.15.0, with its own immutable release principal. It
 * installs beside the 1.2.0 and 9.15.0 baselines, which stay exactly as
 * installed, and moves the platform selection from v3 to v4 only where the
 * 9.15.0 release itself made that selection. Its publication evidence is the
 * exact difference from v3.
 */
export const LOSPOR_BUNDLED_BASELINE_V4_RELEASE = {
  schemaVersion: 1,
  releaseVersion: "10.2.0",
  hashCanonicalization: "UTF16_CODE_UNIT_V1",
  technicalPrincipal: {
    id: "lospor-release:10.2.0",
    kind: "RELEASE",
    displayName: "LOSPOR 10.2.0",
  },
} as const

const SHA256 = /^[a-f0-9]{64}$/
const RULE_VERSION_SUFFIX = "release-10.2.0"
const MAX_AUDIT_DETAIL_BYTES = 2_048

const V4_IDENTITIES = [
  { clinicalMode: "ADULT", presetId: "lospor-adults-v4", presetKey: "LOSPOR_ADULTS", presetVersion: 4, ruleCount: 268, previousPresetId: "lospor-adults-v3" },
  { clinicalMode: "PEDIATRIC", presetId: "lospor-pediatrics-v4", presetKey: "LOSPOR_PEDIATRICS", presetVersion: 4, ruleCount: 366, previousPresetId: "lospor-pediatrics-v3" },
] as const

export type LosporBundledBaselineV4Identity = (typeof V4_IDENTITIES)[number]

export const BUNDLED_BASELINE_V4_PRESET_IDS: ReadonlySet<string> = new Set(V4_IDENTITIES.map(identity => identity.presetId))

export type BundledBaselineV4Expectation = {
  ruleCount: number
  contentSha256: string
  diffSha256: string
  ruleKeysSha256: string
  sourceRefsSha256: string
  descriptorSha256: string
}

/** Pinned once v4 was reviewed; a change to the drafts must be a new release. */
export const BUNDLED_BASELINE_V4_EXPECTATIONS: Readonly<Record<"ADULT" | "PEDIATRIC", BundledBaselineV4Expectation>> = {
  ADULT: {
    ruleCount: 268,
    contentSha256: "e3df78371aed7b11788a104771b5482464ff137582ade53b19744bcb776091b3",
    diffSha256: "9c347dfe916fec2bf6a7678f132115a0cb47a06d1acbdf4e3c0128675c5b16c1",
    ruleKeysSha256: "cbc06f951d4806a5f1d7c04f9b41eb7c21110548c92b9e4dbee4a2db8e77c8dc",
    sourceRefsSha256: "b29e769fb971f3774464f144acccd460301b289e64f242ccc96c59eef58dd64c",
    descriptorSha256: "a00a62a46b6d64be1fe84aa2d3e98f9edd408b081be56b78a1e7aa9fe14e020a",
  },
  PEDIATRIC: {
    ruleCount: 366,
    contentSha256: "a883b6be4b656ab8d33b7f4b45f6a8fc0c130f82c06491e4a795a62e5b42c237",
    diffSha256: "e3ba913280afebc818ebef567f641fdc71f4d49e610b8d4faf00f097fd11f0e8",
    ruleKeysSha256: "f2c9c09a57c2847d0c37878947b2d06704a4e7265469c184d1f1f60ab0b5e600",
    sourceRefsSha256: "83de574d82ab7652bdc9ca6bd531eb7ee36f62ba4fb2fd7fd333e26e56a466da",
    descriptorSha256: "d8052e90379ba0eb59f4f1d6eed2c0034a452087a13e009778e71aac295ca38b",
  },
}

/** The exact change from the v3 baseline, in the bundled byte format. */
export type BundledBaselineV4Diff = {
  schemaVersion: 2
  hashCanonicalization: "UTF16_CODE_UNIT_V1"
  baselinePresetId: string
  baselinePresetVersion: 3
  added: Array<{ ruleKey: string; afterSha256: string; after: BundledBaselineRule }>
  removed: Array<{ ruleKey: string; beforeSha256: string; before: BundledBaselineRule }>
  changed: Array<{ ruleKey: string; beforeSha256: string; afterSha256: string; before: BundledBaselineRule; after: BundledBaselineRule }>
  unchangedRuleCount: number
}

export type BundledBaselineV4Artifact = {
  identity: LosporBundledBaselineV4Identity
  name: string
  description: string
  rules: BundledBaselineRule[]
  ruleCount: number
  contentSha256: string
  diffSha256: string
  ruleKeysSha256: string
  sourceRefsSha256: string
  descriptorSha256: string
  exactDiff: BundledBaselineV4Diff
}

export type BundledBaselineV4AuditDetail = {
  schemaVersion: 1
  operation: "INSTALL_PUBLISH_SELECT" | "INSTALL_PUBLISH"
  releaseVersion: "10.2.0"
  hashCanonicalization: "UTF16_CODE_UNIT_V1"
  principalKind: "RELEASE"
  clinicalMode: "ADULT" | "PEDIATRIC"
  presetVersion: 4
  previousPresetId: string
  ruleCount: number
  contentSha256: string
  diffSha256: string
  ruleKeysSha256: string
  sourceRefsSha256: string
  descriptorSha256: string
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalBundledBaselineJson(value)).digest("hex")
}

function normalizedRule(rule: BundledBaselineRule): BundledBaselineRule {
  return { ...rule, sourceRefs: [...rule.sourceRefs].sort(compareCodeUnits) }
}

/** Rules are compared without their version stamp, which differs by release by design. */
function sameRuleContent(left: BundledBaselineRule, right: BundledBaselineRule): boolean {
  return canonicalBundledBaselineJson({ payload: left.payload, sourceRefs: [...left.sourceRefs].sort(compareCodeUnits) })
    === canonicalBundledBaselineJson({ payload: right.payload, sourceRefs: [...right.sourceRefs].sort(compareCodeUnits) })
}

function exactDiff(previous: BundledBaselineV3Artifact, rules: BundledBaselineRule[]): BundledBaselineV4Diff {
  const before = new Map(previous.rules.map(rule => [rule.ruleKey, normalizedRule(rule)]))
  const diff: BundledBaselineV4Diff = {
    schemaVersion: 2,
    hashCanonicalization: LOSPOR_BUNDLED_BASELINE_V4_RELEASE.hashCanonicalization,
    baselinePresetId: previous.identity.presetId,
    baselinePresetVersion: 3,
    added: [],
    removed: [],
    changed: [],
    unchangedRuleCount: 0,
  }
  for (const after of rules.map(normalizedRule)) {
    const old = before.get(after.ruleKey)
    before.delete(after.ruleKey)
    if (!old) diff.added.push({ ruleKey: after.ruleKey, afterSha256: sha256(after), after })
    else if (sameRuleContent(old, after)) diff.unchangedRuleCount += 1
    else diff.changed.push({ ruleKey: after.ruleKey, beforeSha256: sha256(old), afterSha256: sha256(after), before: old, after })
  }
  for (const old of [...before.values()].sort((left, right) => compareCodeUnits(left.ruleKey, right.ruleKey))) {
    diff.removed.push({ ruleKey: old.ruleKey, beforeSha256: sha256(old), before: old })
  }
  return diff
}

/** The v4 artifacts, each measured against the v3 artifact it supersedes. */
export function computeBundledBaselineV4Artifacts(
  v3: readonly BundledBaselineV3Artifact[],
): readonly [BundledBaselineV4Artifact, BundledBaselineV4Artifact] {
  const drafts: ReadonlyArray<{ identity: LosporBundledBaselineV4Identity; draft: PlatformClinicalDraft }> = [
    { identity: V4_IDENTITIES[0], draft: createLosporAdultV4Draft() },
    { identity: V4_IDENTITIES[1], draft: createLosporPediatricV4Draft() },
  ]
  return drafts.map(({ identity, draft }) => {
    const previous = v3.find(artifact => artifact.identity.presetId === identity.previousPresetId)
    if (!previous) throw new Error(`Bundled ${identity.clinicalMode} v4 has no v3 baseline to supersede`)
    if (draft.id !== identity.presetId
      || draft.key !== identity.presetKey
      || draft.version !== identity.presetVersion
      || draft.clinicalMode !== identity.clinicalMode
      || draft.rules.length !== identity.ruleCount
      || !draft.publishable
      || draft.blockers.length !== 0) {
      throw new Error(`Bundled ${identity.clinicalMode} v4 factory differs from LOSPOR 10.2.0`)
    }
    const rules = draft.rules.map(rule => ({
      ruleKey: clinicalRuleKey(rule.payload),
      ruleVersion: `${identity.presetKey}.v${identity.presetVersion}.${RULE_VERSION_SUFFIX}`,
      payload: rule.payload,
      sourceRefs: [...rule.sourceRefs],
    })).sort((left, right) => compareCodeUnits(left.ruleKey, right.ruleKey))
    if (new Set(rules.map(rule => rule.ruleKey)).size !== rules.length) {
      throw new Error(`Bundled ${identity.clinicalMode} v4 rules have duplicate keys`)
    }
    const diff = exactDiff(previous, rules)
    const contentSha256 = sha256(rules.map(normalizedRule))
    const diffSha256 = sha256(diff)
    const ruleKeysSha256 = sha256(rules.map(rule => rule.ruleKey))
    const sourceRefsSha256 = sha256(rules.map(rule => ({ ruleKey: rule.ruleKey, sourceRefs: [...rule.sourceRefs].sort(compareCodeUnits) })))
    const descriptor = {
      schemaVersion: LOSPOR_BUNDLED_BASELINE_V4_RELEASE.schemaVersion,
      releaseVersion: LOSPOR_BUNDLED_BASELINE_V4_RELEASE.releaseVersion,
      hashCanonicalization: LOSPOR_BUNDLED_BASELINE_V4_RELEASE.hashCanonicalization,
      technicalPrincipalId: LOSPOR_BUNDLED_BASELINE_V4_RELEASE.technicalPrincipal.id,
      identity,
      name: draft.name,
      description: draft.description,
      ruleCount: rules.length,
      contentSha256,
      diffSha256,
      ruleKeysSha256,
      sourceRefsSha256,
    }
    return {
      identity,
      name: draft.name,
      description: draft.description,
      rules,
      ruleCount: rules.length,
      contentSha256,
      diffSha256,
      ruleKeysSha256,
      sourceRefsSha256,
      descriptorSha256: sha256(descriptor),
      exactDiff: diff,
    }
  }) as unknown as readonly [BundledBaselineV4Artifact, BundledBaselineV4Artifact]
}

export function v4ArtifactExpectation(artifact: BundledBaselineV4Artifact): BundledBaselineV4Expectation {
  return {
    ruleCount: artifact.ruleCount,
    contentSha256: artifact.contentSha256,
    diffSha256: artifact.diffSha256,
    ruleKeysSha256: artifact.ruleKeysSha256,
    sourceRefsSha256: artifact.sourceRefsSha256,
    descriptorSha256: artifact.descriptorSha256,
  }
}

export function assertExactBundledBaselineV4Artifacts(artifacts: readonly BundledBaselineV4Artifact[]): void {
  if (artifacts.length !== 2
    || artifacts[0]?.identity.clinicalMode !== "ADULT"
    || artifacts[1]?.identity.clinicalMode !== "PEDIATRIC") {
    throw new Error("LOSPOR 10.2.0 must contain exactly the adult and pediatric v4 baselines")
  }
  for (const artifact of artifacts) {
    const expected = BUNDLED_BASELINE_V4_EXPECTATIONS[artifact.identity.clinicalMode]
    const actual = v4ArtifactExpectation(artifact)
    if (canonicalBundledBaselineJson(actual) !== canonicalBundledBaselineJson(expected)) {
      throw new Error(`Bundled ${artifact.identity.clinicalMode} v4 baseline digest mismatch: ${canonicalBundledBaselineJson(actual)}`)
    }
  }
}

export function bundledBaselineV4AuditDetail(
  artifact: BundledBaselineV4Artifact,
  selected: boolean,
): BundledBaselineV4AuditDetail {
  const detail: BundledBaselineV4AuditDetail = {
    schemaVersion: 1,
    operation: selected ? "INSTALL_PUBLISH_SELECT" : "INSTALL_PUBLISH",
    releaseVersion: LOSPOR_BUNDLED_BASELINE_V4_RELEASE.releaseVersion,
    hashCanonicalization: LOSPOR_BUNDLED_BASELINE_V4_RELEASE.hashCanonicalization,
    principalKind: LOSPOR_BUNDLED_BASELINE_V4_RELEASE.technicalPrincipal.kind,
    clinicalMode: artifact.identity.clinicalMode,
    presetVersion: 4,
    previousPresetId: artifact.identity.previousPresetId,
    ruleCount: artifact.ruleCount,
    contentSha256: artifact.contentSha256,
    diffSha256: artifact.diffSha256,
    ruleKeysSha256: artifact.ruleKeysSha256,
    sourceRefsSha256: artifact.sourceRefsSha256,
    descriptorSha256: artifact.descriptorSha256,
  }
  assertBundledBaselineV4AuditDetail(detail)
  return detail
}

export function assertBundledBaselineV4AuditDetail(
  value: unknown,
  expected?: BundledBaselineV4AuditDetail,
): asserts value is BundledBaselineV4AuditDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bundled v4 baseline audit detail must be an object")
  }
  const record = value as Record<string, unknown>
  const exactKeys = [
    "clinicalMode", "contentSha256", "descriptorSha256", "diffSha256", "hashCanonicalization",
    "operation", "presetVersion", "previousPresetId", "principalKind", "releaseVersion",
    "ruleCount", "ruleKeysSha256", "schemaVersion", "sourceRefsSha256",
  ]
  if (Object.keys(record).sort().join("\0") !== exactKeys.join("\0")
    || record.schemaVersion !== 1
    || (record.operation !== "INSTALL_PUBLISH_SELECT" && record.operation !== "INSTALL_PUBLISH")
    || record.releaseVersion !== "10.2.0"
    || record.hashCanonicalization !== "UTF16_CODE_UNIT_V1"
    || record.principalKind !== "RELEASE"
    || (record.clinicalMode !== "ADULT" && record.clinicalMode !== "PEDIATRIC")
    || record.presetVersion !== 4
    || typeof record.previousPresetId !== "string"
    || !Number.isInteger(record.ruleCount)
    || Number(record.ruleCount) <= 0
    || ![record.contentSha256, record.diffSha256, record.ruleKeysSha256, record.sourceRefsSha256, record.descriptorSha256]
      .every(hash => SHA256.test(String(hash)))
    || Buffer.byteLength(canonicalBundledBaselineJson(record), "utf8") > MAX_AUDIT_DETAIL_BYTES
  ) {
    throw new Error("Bundled v4 baseline audit detail is outside the bounded contract")
  }
  if (expected && canonicalBundledBaselineJson(record) !== canonicalBundledBaselineJson(expected)) {
    throw new Error("Bundled v4 baseline audit detail differs from the canonical release")
  }
}
