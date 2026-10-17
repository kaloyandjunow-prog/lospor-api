import { createHash } from "node:crypto"
import { clinicalRuleKey } from "@lospor/core/clinical-rules"
import {
  createLosporAdultV3Draft,
  createLosporPediatricV3Draft,
  type PlatformClinicalDraft,
} from "@lospor/core/platform-clinical-drafts"
import {
  canonicalBundledBaselineJson,
  type BundledBaselineArtifact,
  type BundledBaselineRule,
} from "./bundled-baseline-contract"

/**
 * The v3 clinical baselines bundled with LOSPOR 9.15.0: v2 over the current
 * catalogues (drugs in their corrected groups, plain Ringer, mannitol 20%).
 *
 * A later release than 1.2.0, with its own immutable release principal. It
 * installs beside the 1.2.0 baselines, which stay exactly as installed, and
 * moves the platform selection from v2 to v3 only where the 1.2.0 release
 * itself made that selection. Its publication evidence is the exact
 * difference from v2.
 */
export const LOSPOR_BUNDLED_BASELINE_V3_RELEASE = {
  schemaVersion: 1,
  releaseVersion: "9.15.0",
  hashCanonicalization: "UTF16_CODE_UNIT_V1",
  technicalPrincipal: {
    id: "lospor-release:9.15.0",
    kind: "RELEASE",
    displayName: "LOSPOR 9.15.0",
  },
} as const

const SHA256 = /^[a-f0-9]{64}$/
const RULE_VERSION_SUFFIX = "release-9.15.0"
const MAX_AUDIT_DETAIL_BYTES = 2_048

const V3_IDENTITIES = [
  { clinicalMode: "ADULT", presetId: "lospor-adults-v3", presetKey: "LOSPOR_ADULTS", presetVersion: 3, ruleCount: 252, previousPresetId: "lospor-adults-v2" },
  { clinicalMode: "PEDIATRIC", presetId: "lospor-pediatrics-v3", presetKey: "LOSPOR_PEDIATRICS", presetVersion: 3, ruleCount: 336, previousPresetId: "lospor-pediatrics-v2" },
] as const

export type LosporBundledBaselineV3Identity = (typeof V3_IDENTITIES)[number]

export const BUNDLED_BASELINE_V3_PRESET_IDS: ReadonlySet<string> = new Set(V3_IDENTITIES.map(identity => identity.presetId))

export type BundledBaselineV3Expectation = {
  ruleCount: number
  contentSha256: string
  diffSha256: string
  ruleKeysSha256: string
  sourceRefsSha256: string
  descriptorSha256: string
}

/** Pinned once v3 was reviewed; a change to the drafts must be a new release. */
export const BUNDLED_BASELINE_V3_EXPECTATIONS: Readonly<Record<"ADULT" | "PEDIATRIC", BundledBaselineV3Expectation>> = {
  ADULT: {
    ruleCount: 252,
    contentSha256: "b26333e57d3fa669f24e1415a3f1294a19abb68195362a23f85e1acf9037d145",
    diffSha256: "d42ef76e7bbe4d17e0221e1a52d97f7c18813f86d167bb856880566b8896d28d",
    ruleKeysSha256: "9594b0f33907ab4eda62ef7f29b1b333738e9026c94193bb98a184a3c58ed49d",
    sourceRefsSha256: "dd013b34bd0837742b2b9f9e601d9938f4cd030b6c8775ccea8893c0a250e8ea",
    descriptorSha256: "41544f26994ef231cf1cdff5fc3a0a701b328c383a97a85fa72c41b01231e537",
  },
  PEDIATRIC: {
    ruleCount: 336,
    contentSha256: "0181ef72ef532b72bc31c66076e3e14a7686be7ea6c39ed6cba01c21d13d7302",
    diffSha256: "d15d79526643caac416374d8cf1a921dedaf712e456e81a9cbf7a0e157813a67",
    ruleKeysSha256: "770f5c6174ed65a188f3061cc9b0375b8e26275250561c660c37e525673a1758",
    sourceRefsSha256: "f85b4622b4002e4b0abd52fc26c988187f4d49165320e19e61c310c5189cdae7",
    descriptorSha256: "cac3fb3deccdcc260f1ea3c5712ff5c41b4e85529737b2a940dc6d4883d9f492",
  },
}

/** The exact change from the v2 baseline, in the bundled byte format. */
export type BundledBaselineV3Diff = {
  schemaVersion: 2
  hashCanonicalization: "UTF16_CODE_UNIT_V1"
  baselinePresetId: string
  baselinePresetVersion: 2
  added: Array<{ ruleKey: string; afterSha256: string; after: BundledBaselineRule }>
  removed: Array<{ ruleKey: string; beforeSha256: string; before: BundledBaselineRule }>
  changed: Array<{ ruleKey: string; beforeSha256: string; afterSha256: string; before: BundledBaselineRule; after: BundledBaselineRule }>
  unchangedRuleCount: number
}

export type BundledBaselineV3Artifact = {
  identity: LosporBundledBaselineV3Identity
  name: string
  description: string
  rules: BundledBaselineRule[]
  ruleCount: number
  contentSha256: string
  diffSha256: string
  ruleKeysSha256: string
  sourceRefsSha256: string
  descriptorSha256: string
  exactDiff: BundledBaselineV3Diff
}

export type BundledBaselineV3AuditDetail = {
  schemaVersion: 1
  operation: "INSTALL_PUBLISH_SELECT" | "INSTALL_PUBLISH"
  releaseVersion: "9.15.0"
  hashCanonicalization: "UTF16_CODE_UNIT_V1"
  principalKind: "RELEASE"
  clinicalMode: "ADULT" | "PEDIATRIC"
  presetVersion: 3
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

function exactDiff(previous: BundledBaselineArtifact, rules: BundledBaselineRule[]): BundledBaselineV3Diff {
  const before = new Map(previous.rules.map(rule => [rule.ruleKey, normalizedRule(rule)]))
  const diff: BundledBaselineV3Diff = {
    schemaVersion: 2,
    hashCanonicalization: LOSPOR_BUNDLED_BASELINE_V3_RELEASE.hashCanonicalization,
    baselinePresetId: previous.identity.presetId,
    baselinePresetVersion: 2,
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

/** The v3 artifacts, each measured against the v2 artifact it supersedes. */
export function computeBundledBaselineV3Artifacts(
  v2: readonly BundledBaselineArtifact[],
): readonly [BundledBaselineV3Artifact, BundledBaselineV3Artifact] {
  const drafts: ReadonlyArray<{ identity: LosporBundledBaselineV3Identity; draft: PlatformClinicalDraft }> = [
    { identity: V3_IDENTITIES[0], draft: createLosporAdultV3Draft() },
    { identity: V3_IDENTITIES[1], draft: createLosporPediatricV3Draft() },
  ]
  return drafts.map(({ identity, draft }) => {
    const previous = v2.find(artifact => artifact.identity.presetId === identity.previousPresetId)
    if (!previous) throw new Error(`Bundled ${identity.clinicalMode} v3 has no v2 baseline to supersede`)
    if (draft.id !== identity.presetId
      || draft.key !== identity.presetKey
      || draft.version !== identity.presetVersion
      || draft.clinicalMode !== identity.clinicalMode
      || draft.rules.length !== identity.ruleCount
      || !draft.publishable
      || draft.blockers.length !== 0) {
      throw new Error(`Bundled ${identity.clinicalMode} v3 factory differs from LOSPOR 9.15.0`)
    }
    const rules = draft.rules.map(rule => ({
      ruleKey: clinicalRuleKey(rule.payload),
      ruleVersion: `${identity.presetKey}.v${identity.presetVersion}.${RULE_VERSION_SUFFIX}`,
      payload: rule.payload,
      sourceRefs: [...rule.sourceRefs],
    })).sort((left, right) => compareCodeUnits(left.ruleKey, right.ruleKey))
    if (new Set(rules.map(rule => rule.ruleKey)).size !== rules.length) {
      throw new Error(`Bundled ${identity.clinicalMode} v3 rules have duplicate keys`)
    }
    const diff = exactDiff(previous, rules)
    const contentSha256 = sha256(rules.map(normalizedRule))
    const diffSha256 = sha256(diff)
    const ruleKeysSha256 = sha256(rules.map(rule => rule.ruleKey))
    const sourceRefsSha256 = sha256(rules.map(rule => ({ ruleKey: rule.ruleKey, sourceRefs: [...rule.sourceRefs].sort(compareCodeUnits) })))
    const descriptor = {
      schemaVersion: LOSPOR_BUNDLED_BASELINE_V3_RELEASE.schemaVersion,
      releaseVersion: LOSPOR_BUNDLED_BASELINE_V3_RELEASE.releaseVersion,
      hashCanonicalization: LOSPOR_BUNDLED_BASELINE_V3_RELEASE.hashCanonicalization,
      technicalPrincipalId: LOSPOR_BUNDLED_BASELINE_V3_RELEASE.technicalPrincipal.id,
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
  }) as unknown as readonly [BundledBaselineV3Artifact, BundledBaselineV3Artifact]
}

export function v3ArtifactExpectation(artifact: BundledBaselineV3Artifact): BundledBaselineV3Expectation {
  return {
    ruleCount: artifact.ruleCount,
    contentSha256: artifact.contentSha256,
    diffSha256: artifact.diffSha256,
    ruleKeysSha256: artifact.ruleKeysSha256,
    sourceRefsSha256: artifact.sourceRefsSha256,
    descriptorSha256: artifact.descriptorSha256,
  }
}

export function assertExactBundledBaselineV3Artifacts(artifacts: readonly BundledBaselineV3Artifact[]): void {
  if (artifacts.length !== 2
    || artifacts[0]?.identity.clinicalMode !== "ADULT"
    || artifacts[1]?.identity.clinicalMode !== "PEDIATRIC") {
    throw new Error("LOSPOR 9.15.0 must contain exactly the adult and pediatric v3 baselines")
  }
  for (const artifact of artifacts) {
    const expected = BUNDLED_BASELINE_V3_EXPECTATIONS[artifact.identity.clinicalMode]
    const actual = v3ArtifactExpectation(artifact)
    if (canonicalBundledBaselineJson(actual) !== canonicalBundledBaselineJson(expected)) {
      throw new Error(`Bundled ${artifact.identity.clinicalMode} v3 baseline digest mismatch: ${canonicalBundledBaselineJson(actual)}`)
    }
  }
}

export function bundledBaselineV3AuditDetail(
  artifact: BundledBaselineV3Artifact,
  selected: boolean,
): BundledBaselineV3AuditDetail {
  const detail: BundledBaselineV3AuditDetail = {
    schemaVersion: 1,
    operation: selected ? "INSTALL_PUBLISH_SELECT" : "INSTALL_PUBLISH",
    releaseVersion: LOSPOR_BUNDLED_BASELINE_V3_RELEASE.releaseVersion,
    hashCanonicalization: LOSPOR_BUNDLED_BASELINE_V3_RELEASE.hashCanonicalization,
    principalKind: LOSPOR_BUNDLED_BASELINE_V3_RELEASE.technicalPrincipal.kind,
    clinicalMode: artifact.identity.clinicalMode,
    presetVersion: 3,
    previousPresetId: artifact.identity.previousPresetId,
    ruleCount: artifact.ruleCount,
    contentSha256: artifact.contentSha256,
    diffSha256: artifact.diffSha256,
    ruleKeysSha256: artifact.ruleKeysSha256,
    sourceRefsSha256: artifact.sourceRefsSha256,
    descriptorSha256: artifact.descriptorSha256,
  }
  assertBundledBaselineV3AuditDetail(detail)
  return detail
}

export function assertBundledBaselineV3AuditDetail(
  value: unknown,
  expected?: BundledBaselineV3AuditDetail,
): asserts value is BundledBaselineV3AuditDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bundled v3 baseline audit detail must be an object")
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
    || record.releaseVersion !== "9.15.0"
    || record.hashCanonicalization !== "UTF16_CODE_UNIT_V1"
    || record.principalKind !== "RELEASE"
    || (record.clinicalMode !== "ADULT" && record.clinicalMode !== "PEDIATRIC")
    || record.presetVersion !== 3
    || typeof record.previousPresetId !== "string"
    || !Number.isInteger(record.ruleCount)
    || Number(record.ruleCount) <= 0
    || ![record.contentSha256, record.diffSha256, record.ruleKeysSha256, record.sourceRefsSha256, record.descriptorSha256]
      .every(hash => SHA256.test(String(hash)))
    || Buffer.byteLength(canonicalBundledBaselineJson(record), "utf8") > MAX_AUDIT_DETAIL_BYTES
  ) {
    throw new Error("Bundled v3 baseline audit detail is outside the bounded contract")
  }
  if (expected && canonicalBundledBaselineJson(record) !== canonicalBundledBaselineJson(expected)) {
    throw new Error("Bundled v3 baseline audit detail differs from the canonical release")
  }
}
