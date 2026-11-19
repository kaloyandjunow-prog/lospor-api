import { createHash } from "node:crypto"
import { clinicalRuleKey } from "@lospor/core/clinical-rules"
import {
  createLosporAdultV5Draft,
  createLosporPediatricV5Draft,
  type PlatformClinicalDraft,
} from "@lospor/core/platform-clinical-drafts"
import {
  canonicalBundledBaselineJson,
  type BundledBaselineRule,
} from "./bundled-baseline-contract"
import type { BundledBaselineV4Artifact } from "./bundled-baseline-v4"

/**
 * The v5 clinical baselines bundled with LOSPOR 10.7.0: v4, and each inhaled
 * agent's range, step and quick buttons as a rule of its own (see
 * createLosporAdultV5Draft and createLosporPediatricV5Draft in core). The
 * values are the ones in use before they were rules.
 *
 * A later release than 10.2.0, with its own immutable release principal. It
 * installs beside the 1.2.0, 9.15.0 and 10.2.0 baselines, which stay exactly as
 * installed, and moves the platform selection from v4 to v5 only where the
 * 10.2.0 release itself made that selection, so an appliance that follows the
 * bundled baseline follows it to v5 on update, and a selection a person made
 * is never overwritten. Its publication evidence is the exact difference from v4
 * (three added agent rules for each population, nothing removed or changed).
 */
export const LOSPOR_BUNDLED_BASELINE_V5_RELEASE = {
  schemaVersion: 1,
  releaseVersion: "10.7.0",
  hashCanonicalization: "UTF16_CODE_UNIT_V1",
  technicalPrincipal: {
    id: "lospor-release:10.7.0",
    kind: "RELEASE",
    displayName: "LOSPOR 10.7.0",
  },
} as const

const SHA256 = /^[a-f0-9]{64}$/
const RULE_VERSION_SUFFIX = "release-10.7.0"
const MAX_AUDIT_DETAIL_BYTES = 2_048

const V5_IDENTITIES = [
  { clinicalMode: "ADULT", presetId: "lospor-adults-v5", presetKey: "LOSPOR_ADULTS", presetVersion: 5, ruleCount: 271, previousPresetId: "lospor-adults-v4" },
  { clinicalMode: "PEDIATRIC", presetId: "lospor-pediatrics-v5", presetKey: "LOSPOR_PEDIATRICS", presetVersion: 5, ruleCount: 369, previousPresetId: "lospor-pediatrics-v4" },
] as const

export type LosporBundledBaselineV5Identity = (typeof V5_IDENTITIES)[number]

export const BUNDLED_BASELINE_V5_PRESET_IDS: ReadonlySet<string> = new Set(V5_IDENTITIES.map(identity => identity.presetId))

export type BundledBaselineV5Expectation = {
  ruleCount: number
  contentSha256: string
  diffSha256: string
  ruleKeysSha256: string
  sourceRefsSha256: string
  descriptorSha256: string
}

/** Pinned once v5 was reviewed; a change to the drafts must be a new release. */
export const BUNDLED_BASELINE_V5_EXPECTATIONS: Readonly<Record<"ADULT" | "PEDIATRIC", BundledBaselineV5Expectation>> = {
  ADULT: {
    ruleCount: 271,
    contentSha256: "318de36b0f377665fe4bab8bac50c67664823fa494cd2fd162c2fb947c0d34ae",
    diffSha256: "2e70378f3d916128f18535fb65f00978e77b6ccb867c88b70d15c9a11b8f5001",
    ruleKeysSha256: "12e9bdd9d895fcef6fe1ddca8f086943a7597f9b4032a089ad24bf13a83d3a95",
    sourceRefsSha256: "cb725855a7e0b3c73766df74d41977268e593bbba7b428eeee7bcbb562174406",
    descriptorSha256: "27dccd93c1f93088bfdae863d59f10504857c7521398dd8a927096e39c1ba820",
  },
  PEDIATRIC: {
    ruleCount: 369,
    contentSha256: "a4748c113b023c467005f912fe60535cc2c8d2ed9210e30251255ca5b210430d",
    diffSha256: "619d9368d63caae5d852e3e3bef7d320a5bed7add807f7803e5377a9af2306f4",
    ruleKeysSha256: "33e86caecf10fd06f14766a3bd65966de74724dbd6224960f3b66d26442e0c2f",
    sourceRefsSha256: "da05888f440531a2373a8fb6ec7718461ade55b7526a256340e03995aed43b7e",
    descriptorSha256: "5fbca5eed050463419eb77d9583e20a5f39549db22fd3ade2eb914a42d7275f5",
  },
}

/** The exact change from the v4 baseline, in the bundled byte format. */
export type BundledBaselineV5Diff = {
  schemaVersion: 2
  hashCanonicalization: "UTF16_CODE_UNIT_V1"
  baselinePresetId: string
  baselinePresetVersion: 4
  added: Array<{ ruleKey: string; afterSha256: string; after: BundledBaselineRule }>
  removed: Array<{ ruleKey: string; beforeSha256: string; before: BundledBaselineRule }>
  changed: Array<{ ruleKey: string; beforeSha256: string; afterSha256: string; before: BundledBaselineRule; after: BundledBaselineRule }>
  unchangedRuleCount: number
}

export type BundledBaselineV5Artifact = {
  identity: LosporBundledBaselineV5Identity
  name: string
  description: string
  rules: BundledBaselineRule[]
  ruleCount: number
  contentSha256: string
  diffSha256: string
  ruleKeysSha256: string
  sourceRefsSha256: string
  descriptorSha256: string
  exactDiff: BundledBaselineV5Diff
}

export type BundledBaselineV5AuditDetail = {
  schemaVersion: 1
  operation: "INSTALL_PUBLISH_SELECT" | "INSTALL_PUBLISH"
  releaseVersion: "10.7.0"
  hashCanonicalization: "UTF16_CODE_UNIT_V1"
  principalKind: "RELEASE"
  clinicalMode: "ADULT" | "PEDIATRIC"
  presetVersion: 5
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

function exactDiff(previous: BundledBaselineV4Artifact, rules: BundledBaselineRule[]): BundledBaselineV5Diff {
  const before = new Map(previous.rules.map(rule => [rule.ruleKey, normalizedRule(rule)]))
  const diff: BundledBaselineV5Diff = {
    schemaVersion: 2,
    hashCanonicalization: LOSPOR_BUNDLED_BASELINE_V5_RELEASE.hashCanonicalization,
    baselinePresetId: previous.identity.presetId,
    baselinePresetVersion: 4,
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

/** The v5 artifacts, each measured against the v4 artifact it supersedes. */
export function computeBundledBaselineV5Artifacts(
  v4: readonly BundledBaselineV4Artifact[],
): readonly [BundledBaselineV5Artifact, BundledBaselineV5Artifact] {
  const drafts: ReadonlyArray<{ identity: LosporBundledBaselineV5Identity; draft: PlatformClinicalDraft }> = [
    { identity: V5_IDENTITIES[0], draft: createLosporAdultV5Draft() },
    { identity: V5_IDENTITIES[1], draft: createLosporPediatricV5Draft() },
  ]
  return drafts.map(({ identity, draft }) => {
    const previous = v4.find(artifact => artifact.identity.presetId === identity.previousPresetId)
    if (!previous) throw new Error(`Bundled ${identity.clinicalMode} v5 has no v4 baseline to supersede`)
    if (draft.id !== identity.presetId
      || draft.key !== identity.presetKey
      || draft.version !== identity.presetVersion
      || draft.clinicalMode !== identity.clinicalMode
      || draft.rules.length !== identity.ruleCount
      || !draft.publishable
      || draft.blockers.length !== 0) {
      throw new Error(`Bundled ${identity.clinicalMode} v5 factory differs from LOSPOR 10.7.0`)
    }
    const rules = draft.rules.map(rule => ({
      ruleKey: clinicalRuleKey(rule.payload),
      ruleVersion: `${identity.presetKey}.v${identity.presetVersion}.${RULE_VERSION_SUFFIX}`,
      payload: rule.payload,
      sourceRefs: [...rule.sourceRefs],
    })).sort((left, right) => compareCodeUnits(left.ruleKey, right.ruleKey))
    if (new Set(rules.map(rule => rule.ruleKey)).size !== rules.length) {
      throw new Error(`Bundled ${identity.clinicalMode} v5 rules have duplicate keys`)
    }
    const diff = exactDiff(previous, rules)
    const contentSha256 = sha256(rules.map(normalizedRule))
    const diffSha256 = sha256(diff)
    const ruleKeysSha256 = sha256(rules.map(rule => rule.ruleKey))
    const sourceRefsSha256 = sha256(rules.map(rule => ({ ruleKey: rule.ruleKey, sourceRefs: [...rule.sourceRefs].sort(compareCodeUnits) })))
    const descriptor = {
      schemaVersion: LOSPOR_BUNDLED_BASELINE_V5_RELEASE.schemaVersion,
      releaseVersion: LOSPOR_BUNDLED_BASELINE_V5_RELEASE.releaseVersion,
      hashCanonicalization: LOSPOR_BUNDLED_BASELINE_V5_RELEASE.hashCanonicalization,
      technicalPrincipalId: LOSPOR_BUNDLED_BASELINE_V5_RELEASE.technicalPrincipal.id,
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
  }) as unknown as readonly [BundledBaselineV5Artifact, BundledBaselineV5Artifact]
}

export function v5ArtifactExpectation(artifact: BundledBaselineV5Artifact): BundledBaselineV5Expectation {
  return {
    ruleCount: artifact.ruleCount,
    contentSha256: artifact.contentSha256,
    diffSha256: artifact.diffSha256,
    ruleKeysSha256: artifact.ruleKeysSha256,
    sourceRefsSha256: artifact.sourceRefsSha256,
    descriptorSha256: artifact.descriptorSha256,
  }
}

export function assertExactBundledBaselineV5Artifacts(artifacts: readonly BundledBaselineV5Artifact[]): void {
  if (artifacts.length !== 2
    || artifacts[0]?.identity.clinicalMode !== "ADULT"
    || artifacts[1]?.identity.clinicalMode !== "PEDIATRIC") {
    throw new Error("LOSPOR 10.7.0 must contain exactly the adult and pediatric v5 baselines")
  }
  for (const artifact of artifacts) {
    const expected = BUNDLED_BASELINE_V5_EXPECTATIONS[artifact.identity.clinicalMode]
    const actual = v5ArtifactExpectation(artifact)
    if (canonicalBundledBaselineJson(actual) !== canonicalBundledBaselineJson(expected)) {
      throw new Error(`Bundled ${artifact.identity.clinicalMode} v5 baseline digest mismatch: ${canonicalBundledBaselineJson(actual)}`)
    }
  }
}

export function bundledBaselineV5AuditDetail(
  artifact: BundledBaselineV5Artifact,
  selected: boolean,
): BundledBaselineV5AuditDetail {
  const detail: BundledBaselineV5AuditDetail = {
    schemaVersion: 1,
    operation: selected ? "INSTALL_PUBLISH_SELECT" : "INSTALL_PUBLISH",
    releaseVersion: LOSPOR_BUNDLED_BASELINE_V5_RELEASE.releaseVersion,
    hashCanonicalization: LOSPOR_BUNDLED_BASELINE_V5_RELEASE.hashCanonicalization,
    principalKind: LOSPOR_BUNDLED_BASELINE_V5_RELEASE.technicalPrincipal.kind,
    clinicalMode: artifact.identity.clinicalMode,
    presetVersion: 5,
    previousPresetId: artifact.identity.previousPresetId,
    ruleCount: artifact.ruleCount,
    contentSha256: artifact.contentSha256,
    diffSha256: artifact.diffSha256,
    ruleKeysSha256: artifact.ruleKeysSha256,
    sourceRefsSha256: artifact.sourceRefsSha256,
    descriptorSha256: artifact.descriptorSha256,
  }
  assertBundledBaselineV5AuditDetail(detail)
  return detail
}

export function assertBundledBaselineV5AuditDetail(
  value: unknown,
  expected?: BundledBaselineV5AuditDetail,
): asserts value is BundledBaselineV5AuditDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bundled v5 baseline audit detail must be an object")
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
    || record.releaseVersion !== "10.7.0"
    || record.hashCanonicalization !== "UTF16_CODE_UNIT_V1"
    || record.principalKind !== "RELEASE"
    || (record.clinicalMode !== "ADULT" && record.clinicalMode !== "PEDIATRIC")
    || record.presetVersion !== 5
    || typeof record.previousPresetId !== "string"
    || !Number.isInteger(record.ruleCount)
    || Number(record.ruleCount) <= 0
    || ![record.contentSha256, record.diffSha256, record.ruleKeysSha256, record.sourceRefsSha256, record.descriptorSha256]
      .every(hash => SHA256.test(String(hash)))
    || Buffer.byteLength(canonicalBundledBaselineJson(record), "utf8") > MAX_AUDIT_DETAIL_BYTES
  ) {
    throw new Error("Bundled v5 baseline audit detail is outside the bounded contract")
  }
  if (expected && canonicalBundledBaselineJson(record) !== canonicalBundledBaselineJson(expected)) {
    throw new Error("Bundled v5 baseline audit detail differs from the canonical release")
  }
}
