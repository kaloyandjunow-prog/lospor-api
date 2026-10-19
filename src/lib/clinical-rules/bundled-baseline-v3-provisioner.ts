import type { Prisma } from "@/generated/prisma/client"
import type { AuditActionCode } from "@/lib/audit-actions"
import {
  canonicalBundledBaselineJson,
  exactStoredRule,
  LOSPOR_BUNDLED_BASELINE_RELEASE,
} from "./bundled-baseline-contract"
import {
  assertBundledBaselineV3AuditDetail,
  bundledBaselineV3AuditDetail,
  LOSPOR_BUNDLED_BASELINE_V3_RELEASE,
  type BundledBaselineV3Artifact,
} from "./bundled-baseline-v3"

const AUDIT_ACTION = "CLINICAL_BUNDLED_BASELINE_PROVISION" satisfies AuditActionCode
const PUBLICATION_REASON = "Exact immutable canonical v3 baseline bundled with LOSPOR 9.15.0, superseding v2"

/** Raised as the 1.2.0 provisioner raises its own, with the same codes. */
export class BundledBaselineV3ProvisionError extends Error {
  constructor(
    readonly code: "BUNDLED_BASELINE_COLLISION" | "BUNDLED_BASELINE_PARTIAL_STATE" | "BUNDLED_BASELINE_VERIFICATION_FAILED",
    message: string,
  ) {
    super(message)
  }
}

export type BundledBaselineV3ProvisionResult = {
  outcome: "installed" | "verified"
  releaseVersion: "9.15.0"
  technicalPrincipalId: "lospor-release:9.15.0"
  baselines: Array<{
    clinicalMode: "ADULT" | "PEDIATRIC"
    presetId: string
    presetVersion: 3
    ruleCount: number
    contentSha256: string
    /** Whether this release moved the platform selection from v2 to v3. */
    selected: boolean
  }>
}

function publicationEvidenceId(artifact: BundledBaselineV3Artifact): string {
  return `${LOSPOR_BUNDLED_BASELINE_V3_RELEASE.technicalPrincipal.id}:${artifact.identity.clinicalMode.toLowerCase()}:publication`
}

function auditEvidenceId(artifact: BundledBaselineV3Artifact): string {
  return `${LOSPOR_BUNDLED_BASELINE_V3_RELEASE.technicalPrincipal.id}:${artifact.identity.clinicalMode.toLowerCase()}:audit`
}

function sameInstant(left: Date | null, right: Date | null): boolean {
  return left instanceof Date && right instanceof Date && left.getTime() === right.getTime()
}

/**
 * A platform selection this release made: v3, by the 9.15.0 principal. The
 * 1.2.0 verification accepts its own v2 selection having been moved to one.
 */
export function isBundledV3Selection(selection: {
  presetId: string
  selectedByTechnicalPrincipalId: string | null
}, artifacts: readonly BundledBaselineV3Artifact[]): boolean {
  return selection.selectedByTechnicalPrincipalId === LOSPOR_BUNDLED_BASELINE_V3_RELEASE.technicalPrincipal.id
    && artifacts.some(artifact => artifact.identity.presetId === selection.presetId)
}

async function inspectV3State(tx: Prisma.TransactionClient, artifacts: readonly BundledBaselineV3Artifact[]) {
  const principal = LOSPOR_BUNDLED_BASELINE_V3_RELEASE.technicalPrincipal
  const presetIds = artifacts.map(artifact => artifact.identity.presetId)
  const [principals, accountCount, sessionCount, presets, selections, audits] = await Promise.all([
    tx.technicalPrincipal.findMany({
      where: { OR: [{ id: principal.id }, { kind: principal.kind, releaseVersion: LOSPOR_BUNDLED_BASELINE_V3_RELEASE.releaseVersion }] },
      orderBy: { id: "asc" },
    }),
    tx.user.count({ where: { id: principal.id } }),
    tx.authSession.count({ where: { userId: principal.id } }),
    tx.clinicalPreset.findMany({
      where: {
        OR: [
          ...artifacts.flatMap(artifact => [
            { id: artifact.identity.presetId },
            {
              key: artifact.identity.presetKey,
              clinicalMode: artifact.identity.clinicalMode,
              scope: "PLATFORM" as const,
              version: artifact.identity.presetVersion,
            },
          ]),
          { publicationEvidence: { is: { id: { in: artifacts.map(publicationEvidenceId) } } } },
        ],
      },
      include: { rules: { orderBy: { ruleKey: "asc" } }, publicationEvidence: true },
      orderBy: { id: "asc" },
    }),
    tx.platformClinicalPresetSelection.findMany({
      where: { clinicalMode: { in: artifacts.map(artifact => artifact.identity.clinicalMode) } },
      orderBy: { clinicalMode: "asc" },
    }),
    tx.auditLog.findMany({
      where: {
        OR: [
          { id: { in: artifacts.map(auditEvidenceId) } },
          { action: AUDIT_ACTION, entityId: { in: presetIds } },
          { userId: principal.id },
        ],
      },
      orderBy: { createdAt: "asc" },
    }),
  ])
  return { principals, accountCount, sessionCount, presets, selections, audits }
}

type V3Inspection = Awaited<ReturnType<typeof inspectV3State>>

function isV3Pristine(inspection: V3Inspection): boolean {
  return inspection.principals.length === 0
    && inspection.accountCount === 0
    && inspection.sessionCount === 0
    && inspection.presets.length === 0
    && inspection.audits.length === 0
}

async function installV3(
  tx: Prisma.TransactionClient,
  artifacts: readonly BundledBaselineV3Artifact[],
  selections: V3Inspection["selections"],
  installedAt: Date,
): Promise<boolean[]> {
  const principal = LOSPOR_BUNDLED_BASELINE_V3_RELEASE.technicalPrincipal
  await tx.technicalPrincipal.create({
    data: {
      id: principal.id,
      kind: principal.kind,
      displayName: principal.displayName,
      releaseVersion: LOSPOR_BUNDLED_BASELINE_V3_RELEASE.releaseVersion,
      createdAt: installedAt,
    },
  })
  const selected: boolean[] = []
  for (const artifact of artifacts) {
    await tx.clinicalPreset.create({
      data: {
        id: artifact.identity.presetId,
        key: artifact.identity.presetKey,
        name: artifact.name,
        description: artifact.description,
        clinicalMode: artifact.identity.clinicalMode,
        scope: "PLATFORM",
        version: artifact.identity.presetVersion,
        status: "DRAFT",
        createdByTechnicalPrincipalId: principal.id,
        createdAt: installedAt,
        rules: {
          create: artifact.rules.map(rule => ({
            ruleKey: rule.ruleKey,
            ruleVersion: rule.ruleVersion,
            payload: rule.payload as Prisma.InputJsonValue,
            sourceRefs: rule.sourceRefs as Prisma.InputJsonValue,
          })),
        },
      },
    })
    await tx.clinicalRulesetPublicationEvidence.create({
      data: {
        id: publicationEvidenceId(artifact),
        presetId: artifact.identity.presetId,
        baselinePresetId: artifact.identity.previousPresetId,
        baselinePresetVersion: 2,
        reason: PUBLICATION_REASON,
        contentSha256: artifact.contentSha256,
        diffSha256: artifact.diffSha256,
        exactDiff: artifact.exactDiff as unknown as Prisma.InputJsonValue,
        confirmedByTechnicalPrincipalId: principal.id,
        confirmedAt: installedAt,
      },
    })
    await tx.clinicalPreset.update({
      where: { id: artifact.identity.presetId },
      data: {
        status: "PUBLISHED",
        publishedByTechnicalPrincipalId: principal.id,
        publishedAt: installedAt,
        updatedAt: installedAt,
      },
    })
    // The platform follows the bundled baseline only where the bundled 1.2.0
    // release chose it; a selection a person made is never overwritten.
    const current = selections.find(selection => selection.clinicalMode === artifact.identity.clinicalMode)
    const move = current?.presetId === artifact.identity.previousPresetId
      && current.selectedByTechnicalPrincipalId === LOSPOR_BUNDLED_BASELINE_RELEASE.technicalPrincipal.id
    if (move) {
      await tx.platformClinicalPresetSelection.update({
        where: { clinicalMode: artifact.identity.clinicalMode },
        data: {
          presetId: artifact.identity.presetId,
          selectedById: null,
          selectedByTechnicalPrincipalId: principal.id,
          selectedAt: installedAt,
          updatedAt: installedAt,
        },
      })
    }
    selected.push(move)
    await tx.auditLog.create({
      data: {
        id: auditEvidenceId(artifact),
        userId: principal.id,
        action: AUDIT_ACTION,
        entityId: artifact.identity.presetId,
        detail: bundledBaselineV3AuditDetail(artifact, move) as unknown as Prisma.InputJsonValue,
        createdAt: installedAt,
      },
    })
  }
  return selected
}

function verifyV3(inspection: V3Inspection, artifacts: readonly BundledBaselineV3Artifact[]): boolean[] {
  const principal = LOSPOR_BUNDLED_BASELINE_V3_RELEASE.technicalPrincipal
  const fail = (message: string): never => {
    throw new BundledBaselineV3ProvisionError("BUNDLED_BASELINE_VERIFICATION_FAILED", message)
  }
  if (inspection.accountCount !== 0 || inspection.sessionCount !== 0) {
    throw new BundledBaselineV3ProvisionError("BUNDLED_BASELINE_COLLISION", "The LOSPOR 9.15.0 release principal collides with a login-capable account or session")
  }
  if (inspection.principals.length !== 1
    || inspection.presets.length !== artifacts.length
    || inspection.audits.length !== artifacts.length) {
    throw new BundledBaselineV3ProvisionError("BUNDLED_BASELINE_PARTIAL_STATE", "Bundled v3 baseline state is partial or collides with another platform v3; no rows were repaired or overwritten")
  }
  const stored = inspection.principals[0]
  if (stored?.id !== principal.id
    || stored.kind !== principal.kind
    || stored.displayName !== principal.displayName
    || stored.releaseVersion !== LOSPOR_BUNDLED_BASELINE_V3_RELEASE.releaseVersion
    || !(stored.createdAt instanceof Date)) {
    throw new BundledBaselineV3ProvisionError("BUNDLED_BASELINE_COLLISION", "LOSPOR 9.15.0 technical principal identity collision")
  }
  return artifacts.map(artifact => {
    const preset = inspection.presets.find(item => item.id === artifact.identity.presetId)
    if (!preset) {
      throw new BundledBaselineV3ProvisionError("BUNDLED_BASELINE_COLLISION", `Bundled ${artifact.identity.clinicalMode} v3 identity collision`)
    }
    if (preset.key !== artifact.identity.presetKey
      || preset.name !== artifact.name
      || preset.description !== artifact.description
      || preset.clinicalMode !== artifact.identity.clinicalMode
      || preset.scope !== "PLATFORM"
      || preset.ownerInstitutionId !== null
      || preset.ownerUserId !== null
      || preset.version !== artifact.identity.presetVersion
      || preset.status !== "PUBLISHED"
      || preset.createdById !== null
      || preset.publishedById !== null
      || preset.createdByTechnicalPrincipalId !== principal.id
      || preset.publishedByTechnicalPrincipalId !== principal.id
      || !sameInstant(preset.createdAt, stored.createdAt)
      || !sameInstant(preset.publishedAt, stored.createdAt)
      || preset.rules.length !== artifact.rules.length) {
      fail(`Stored ${artifact.identity.clinicalMode} v3 baseline metadata is not the exact release`)
    }
    const storedRules = new Map(preset.rules.map(rule => [rule.ruleKey, rule]))
    for (const rule of artifact.rules) {
      const found = storedRules.get(rule.ruleKey)
      if (!found || !exactStoredRule(found, rule)) fail(`Stored ${artifact.identity.clinicalMode} v3 rule content or source references differ`)
    }
    const evidence = preset.publicationEvidence
    if (!evidence
      || evidence.id !== publicationEvidenceId(artifact)
      || evidence.baselinePresetId !== artifact.identity.previousPresetId
      || evidence.baselinePresetVersion !== 2
      || evidence.reason !== PUBLICATION_REASON
      || evidence.contentSha256 !== artifact.contentSha256
      || evidence.diffSha256 !== artifact.diffSha256
      || evidence.confirmedById !== null
      || evidence.confirmedByTechnicalPrincipalId !== principal.id
      || !sameInstant(evidence.confirmedAt, stored.createdAt)
      || canonicalBundledBaselineJson(evidence.exactDiff) !== canonicalBundledBaselineJson(artifact.exactDiff)) {
      fail(`Stored ${artifact.identity.clinicalMode} v3 publication evidence differs`)
    }
    const audit = inspection.audits.find(item => item.id === auditEvidenceId(artifact))
    if (!audit
      || audit.userId !== principal.id
      || audit.action !== AUDIT_ACTION
      || audit.entityId !== artifact.identity.presetId
      || !sameInstant(audit.createdAt, stored.createdAt)) {
      fail(`Stored ${artifact.identity.clinicalMode} v3 audit evidence is missing or ambiguous`)
    }
    const detail = audit!.detail as Record<string, unknown> | null
    const selected = detail?.operation === "INSTALL_PUBLISH_SELECT"
    try {
      assertBundledBaselineV3AuditDetail(detail, bundledBaselineV3AuditDetail(artifact, selected))
    } catch (error) {
      fail(error instanceof Error ? error.message : "Invalid bundled v3 baseline audit evidence")
    }
    // A selection made later by an administrator is theirs to make; the 1.2.0
    // verification decides whether it is acceptable, as it always has.
    return selected
  })
}

/**
 * Installs the v3 baselines beside the verified 1.2.0 ones, or verifies them.
 * Runs inside the caller's SERIALIZABLE transaction, after the 1.2.0 step.
 */
export async function provisionBundledBaselineV3InTransaction(
  tx: Prisma.TransactionClient,
  artifacts: readonly BundledBaselineV3Artifact[],
  installedAt: Date,
): Promise<BundledBaselineV3ProvisionResult> {
  const inspection = await inspectV3State(tx, artifacts)
  let outcome: BundledBaselineV3ProvisionResult["outcome"] = "verified"
  let selected: boolean[]
  if (isV3Pristine(inspection)) {
    await installV3(tx, artifacts, inspection.selections, installedAt)
    selected = verifyV3(await inspectV3State(tx, artifacts), artifacts)
    outcome = "installed"
  } else {
    selected = verifyV3(inspection, artifacts)
  }
  return {
    outcome,
    releaseVersion: LOSPOR_BUNDLED_BASELINE_V3_RELEASE.releaseVersion,
    technicalPrincipalId: LOSPOR_BUNDLED_BASELINE_V3_RELEASE.technicalPrincipal.id,
    baselines: artifacts.map((artifact, index) => ({
      clinicalMode: artifact.identity.clinicalMode,
      presetId: artifact.identity.presetId,
      presetVersion: 3,
      ruleCount: artifact.ruleCount,
      contentSha256: artifact.contentSha256,
      selected: selected[index] ?? false,
    })),
  }
}
