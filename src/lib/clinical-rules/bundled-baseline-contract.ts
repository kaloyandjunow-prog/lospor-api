import { createHash } from "node:crypto"
import { clinicalRuleKey } from "@lospor/core/clinical-rules"
import {
  createLosporAdultV2Draft,
  createLosporPediatricV2Draft,
  type PlatformClinicalDraft,
} from "@lospor/core/platform-clinical-drafts"
import {
  type ClinicalRuleEvidenceSnapshot,
} from "./publication-evidence"

const SHA256 = /^[a-f0-9]{64}$/
const RULE_VERSION_SUFFIX = "release-1.2.0"
const MAX_AUDIT_DETAIL_BYTES = 2_048

export const LOSPOR_BUNDLED_BASELINE_RELEASE = {
  schemaVersion: 1,
  releaseVersion: "1.2.0",
  hashCanonicalization: "UTF16_CODE_UNIT_V1",
  technicalPrincipal: {
    id: "lospor-release:1.2.0",
    kind: "RELEASE",
    displayName: "LOSPOR 1.2.0",
  },
} as const

const BASELINE_IDENTITIES = [
  { clinicalMode: "ADULT", presetId: "lospor-adults-v2", presetKey: "LOSPOR_ADULTS", presetVersion: 2, ruleCount: 251 },
  { clinicalMode: "PEDIATRIC", presetId: "lospor-pediatrics-v2", presetKey: "LOSPOR_PEDIATRICS", presetVersion: 2, ruleCount: 335 },
] as const

export type LosporBundledBaselineIdentity = (typeof BASELINE_IDENTITIES)[number]

export type BundledBaselineExpectation = {
  ruleCount: number
  contentSha256: string
  diffSha256: string
  ruleKeysSha256: string
  sourceRefsSha256: string
  descriptorSha256: string
}

export const BUNDLED_BASELINE_EXPECTATIONS: Readonly<
  Record<"ADULT" | "PEDIATRIC", BundledBaselineExpectation>
> = {
  ADULT: {
    ruleCount: 251,
    contentSha256: "030a1f80784f367def47e828c0253e07f55e7ec6bbcc73437004844ccfdb2521",
    diffSha256: "b241c1c8ccdffde24a4b442758ab3bd25bb1141da0519f4d00fcbc6a246fd463",
    ruleKeysSha256: "3e6b29c596d4afb8d2e634b4dfd07ba047bbf08c723de4ee3642bbf79fa2be98",
    sourceRefsSha256: "84229bc5f7cd34cdd7dc08cd29b0e0a73d75d06729e56418dd08cb5e765ea560",
    descriptorSha256: "6505bd4cc51ac5aa12ccc40de9256eed5ff3b8101b113d83d5d77b1ee9c7d3b7",
  },
  PEDIATRIC: {
    ruleCount: 335,
    contentSha256: "233323da828092f572696c3363a06cee51420c8b66183acb0e5226ae27fd95c3",
    diffSha256: "b23b3c0ad39ef99ed7efea0fd4b98358cc380724cb85b0dbfda42431e948f45e",
    ruleKeysSha256: "b2575d605f6a486c29661d5f18098177243774cfd79b028d9b8a80f1fe930716",
    sourceRefsSha256: "f8168d43ac95a0be5aa2f2c55de438b393bebe0d73c87fe1ef06f8c7b81389f9",
    descriptorSha256: "e9b6010f726809f2295ff5b5889e563cc390260a01c0419d1668327579056c50",
  },
}

export type BundledBaselineRule = ClinicalRuleEvidenceSnapshot

export type BundledBaselineExactDiff = {
  schemaVersion: 2
  hashCanonicalization: "UTF16_CODE_UNIT_V1"
  baselinePresetId: null
  baselinePresetVersion: null
  added: Array<{
    ruleKey: string
    afterSha256: string
    after: BundledBaselineRule
  }>
  removed: []
  changed: []
  unchangedRuleCount: 0
}

export type BundledBaselineArtifact = {
  identity: LosporBundledBaselineIdentity
  name: string
  description: string
  rules: BundledBaselineRule[]
  ruleCount: number
  contentSha256: string
  diffSha256: string
  ruleKeysSha256: string
  sourceRefsSha256: string
  descriptorSha256: string
  exactDiff: BundledBaselineExactDiff
}

export type BundledBaselineAuditDetail = {
  schemaVersion: 1
  operation: "INSTALL_PUBLISH_SELECT"
  releaseVersion: "1.2.0"
  hashCanonicalization: "UTF16_CODE_UNIT_V1"
  principalKind: "RELEASE"
  clinicalMode: "ADULT" | "PEDIATRIC"
  presetVersion: 2
  ruleCount: number
  contentSha256: string
  diffSha256: string
  ruleKeysSha256: string
  sourceRefsSha256: string
  descriptorSha256: string
}

function ruleVersion(identity: LosporBundledBaselineIdentity): string {
  return `${identity.presetKey}.v${identity.presetVersion}.${RULE_VERSION_SUFFIX}`
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Release-v1 byte format. This is intentionally separate from the historical
 * human-publication canonicalizer, whose locale-aware ordering cannot be
 * changed without invalidating evidence already stored by older deployments.
 */
export function canonicalBundledBaselineJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null)
  if (Array.isArray(value)) {
    return `[${value.map(canonicalBundledBaselineJson).join(",")}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => compareCodeUnits(left, right))
  return `{${entries.map(([key, item]) => (
    `${JSON.stringify(key)}:${canonicalBundledBaselineJson(item)}`
  )).join(",")}}`
}

function bundledBaselineSha256(value: unknown): string {
  return createHash("sha256").update(canonicalBundledBaselineJson(value)).digest("hex")
}

function buildBundledBaselineEvidence(rules: BundledBaselineRule[]): {
  exactDiff: BundledBaselineExactDiff
  contentSha256: string
  diffSha256: string
} {
  const normalizedRules = rules.map(rule => ({
    ...rule,
    sourceRefs: [...rule.sourceRefs].sort(compareCodeUnits),
  })).sort((left, right) => compareCodeUnits(left.ruleKey, right.ruleKey))
  const exactDiff: BundledBaselineExactDiff = {
    schemaVersion: 2,
    hashCanonicalization: LOSPOR_BUNDLED_BASELINE_RELEASE.hashCanonicalization,
    baselinePresetId: null,
    baselinePresetVersion: null,
    added: normalizedRules.map(after => ({
      ruleKey: after.ruleKey,
      afterSha256: bundledBaselineSha256(after),
      after,
    })),
    removed: [],
    changed: [],
    unchangedRuleCount: 0,
  }
  return {
    exactDiff,
    contentSha256: bundledBaselineSha256(normalizedRules),
    diffSha256: bundledBaselineSha256(exactDiff),
  }
}

export function computeBundledBaselineArtifacts(): readonly [
  BundledBaselineArtifact,
  BundledBaselineArtifact,
] {
  const baselines: ReadonlyArray<{
    identity: LosporBundledBaselineIdentity
    draft: PlatformClinicalDraft
  }> = [
    { identity: BASELINE_IDENTITIES[0], draft: createLosporAdultV2Draft() },
    { identity: BASELINE_IDENTITIES[1], draft: createLosporPediatricV2Draft() },
  ]
  return baselines.map(({ identity, draft }) => {
    if (draft.id !== identity.presetId
      || draft.key !== identity.presetKey
      || draft.version !== identity.presetVersion
      || draft.clinicalMode !== identity.clinicalMode
      || draft.rules.length !== identity.ruleCount
      || !draft.publishable
      || draft.blockers.length !== 0) {
      throw new Error(`Bundled ${identity.clinicalMode} factory differs from LOSPOR 1.2.0`)
    }
    const rules = draft.rules.map(rule => ({
      ruleKey: clinicalRuleKey(rule.payload),
      ruleVersion: ruleVersion(identity),
      payload: rule.payload,
      sourceRefs: [...rule.sourceRefs],
    })).sort((left, right) => compareCodeUnits(left.ruleKey, right.ruleKey))
    if (new Set(rules.map(rule => rule.ruleKey)).size !== rules.length
      || rules.some(rule => (
        rule.sourceRefs.length > 64
        || rule.sourceRefs.some(source => (
          typeof source !== "string"
          || source.trim() !== source
          || source.length === 0
          || source.length > 512
        ))
        || new Set(rule.sourceRefs).size !== rule.sourceRefs.length
      ))) {
      throw new Error(`Bundled ${identity.clinicalMode} rules have invalid keys or source references`)
    }
    const evidence = buildBundledBaselineEvidence(rules)
    const ruleKeysSha256 = bundledBaselineSha256(rules.map(rule => rule.ruleKey))
    const sourceRefsSha256 = bundledBaselineSha256(rules.map(rule => ({
      ruleKey: rule.ruleKey,
      sourceRefs: [...rule.sourceRefs].sort(compareCodeUnits),
    })))
    const descriptor = {
      schemaVersion: LOSPOR_BUNDLED_BASELINE_RELEASE.schemaVersion,
      releaseVersion: LOSPOR_BUNDLED_BASELINE_RELEASE.releaseVersion,
      hashCanonicalization: LOSPOR_BUNDLED_BASELINE_RELEASE.hashCanonicalization,
      technicalPrincipalId: LOSPOR_BUNDLED_BASELINE_RELEASE.technicalPrincipal.id,
      identity,
      name: draft.name,
      description: draft.description,
      ruleCount: rules.length,
      contentSha256: evidence.contentSha256,
      diffSha256: evidence.diffSha256,
      ruleKeysSha256,
      sourceRefsSha256,
    }
    return {
      identity,
      name: draft.name,
      description: draft.description,
      rules,
      ruleCount: rules.length,
      contentSha256: evidence.contentSha256,
      diffSha256: evidence.diffSha256,
      ruleKeysSha256,
      sourceRefsSha256,
      descriptorSha256: bundledBaselineSha256(descriptor),
      exactDiff: evidence.exactDiff,
    }
  }) as unknown as readonly [BundledBaselineArtifact, BundledBaselineArtifact]
}

export function artifactExpectation(artifact: BundledBaselineArtifact): BundledBaselineExpectation {
  return {
    ruleCount: artifact.ruleCount,
    contentSha256: artifact.contentSha256,
    diffSha256: artifact.diffSha256,
    ruleKeysSha256: artifact.ruleKeysSha256,
    sourceRefsSha256: artifact.sourceRefsSha256,
    descriptorSha256: artifact.descriptorSha256,
  }
}

export function assertExactBundledBaselineArtifacts(
  artifacts: readonly BundledBaselineArtifact[],
): void {
  if (artifacts.length !== 2
    || artifacts[0]?.identity.clinicalMode !== "ADULT"
    || artifacts[1]?.identity.clinicalMode !== "PEDIATRIC") {
    throw new Error("LOSPOR 1.2.0 must contain exactly the adult and pediatric baselines")
  }
  for (const artifact of artifacts) {
    const expected = BUNDLED_BASELINE_EXPECTATIONS[artifact.identity.clinicalMode]
    const actual = artifactExpectation(artifact)
    if (canonicalBundledBaselineJson(actual) !== canonicalBundledBaselineJson(expected)) {
      throw new Error(
        `Bundled ${artifact.identity.clinicalMode} baseline digest mismatch: `
        + canonicalBundledBaselineJson(actual),
      )
    }
  }
}

export function bundledBaselineAuditDetail(
  artifact: BundledBaselineArtifact,
): BundledBaselineAuditDetail {
  const detail: BundledBaselineAuditDetail = {
    schemaVersion: 1,
    operation: "INSTALL_PUBLISH_SELECT",
    releaseVersion: LOSPOR_BUNDLED_BASELINE_RELEASE.releaseVersion,
    hashCanonicalization: LOSPOR_BUNDLED_BASELINE_RELEASE.hashCanonicalization,
    principalKind: LOSPOR_BUNDLED_BASELINE_RELEASE.technicalPrincipal.kind,
    clinicalMode: artifact.identity.clinicalMode,
    presetVersion: artifact.identity.presetVersion,
    ruleCount: artifact.ruleCount,
    contentSha256: artifact.contentSha256,
    diffSha256: artifact.diffSha256,
    ruleKeysSha256: artifact.ruleKeysSha256,
    sourceRefsSha256: artifact.sourceRefsSha256,
    descriptorSha256: artifact.descriptorSha256,
  }
  assertBundledBaselineAuditDetail(detail)
  return detail
}

export function assertBundledBaselineAuditDetail(
  value: unknown,
  expected?: BundledBaselineAuditDetail,
): asserts value is BundledBaselineAuditDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Bundled baseline audit detail must be an object")
  }
  const record = value as Record<string, unknown>
  const exactKeys = [
    "clinicalMode", "contentSha256", "descriptorSha256", "diffSha256", "hashCanonicalization",
    "operation", "presetVersion", "principalKind", "releaseVersion",
    "ruleCount", "ruleKeysSha256", "schemaVersion", "sourceRefsSha256",
  ]
  if (Object.keys(record).sort().join("\0") !== exactKeys.join("\0")
    || record.schemaVersion !== 1
    || record.operation !== "INSTALL_PUBLISH_SELECT"
    || record.releaseVersion !== "1.2.0"
    || record.hashCanonicalization !== "UTF16_CODE_UNIT_V1"
    || record.principalKind !== "RELEASE"
    || (record.clinicalMode !== "ADULT" && record.clinicalMode !== "PEDIATRIC")
    || record.presetVersion !== 2
    || !Number.isInteger(record.ruleCount)
    || Number(record.ruleCount) <= 0
    || !SHA256.test(String(record.contentSha256))
    || !SHA256.test(String(record.diffSha256))
    || !SHA256.test(String(record.ruleKeysSha256))
    || !SHA256.test(String(record.sourceRefsSha256))
    || !SHA256.test(String(record.descriptorSha256))
    || Buffer.byteLength(canonicalBundledBaselineJson(record), "utf8") > MAX_AUDIT_DETAIL_BYTES
  ) {
    throw new Error("Bundled baseline audit detail is outside the bounded v1 contract")
  }
  if (expected && canonicalBundledBaselineJson(record) !== canonicalBundledBaselineJson(expected)) {
    throw new Error("Bundled baseline audit detail differs from the canonical release")
  }
}

export function exactStoredRule(
  stored: { ruleKey: string; ruleVersion: string; payload: unknown; sourceRefs: unknown },
  expected: BundledBaselineRule,
): boolean {
  return stored.ruleKey === expected.ruleKey
    && stored.ruleVersion === expected.ruleVersion
    && canonicalBundledBaselineJson(stored.payload) === canonicalBundledBaselineJson(expected.payload)
    && canonicalBundledBaselineJson(stored.sourceRefs) === canonicalBundledBaselineJson(expected.sourceRefs)
}
