import type { Prisma, PrismaClient } from "@/generated/prisma/client"
import { Prisma as PrismaNamespace } from "@/generated/prisma/client"
import type { AuditActionCode } from "@/lib/audit-actions"
import {
  assertBundledBaselineAuditDetail,
  assertExactBundledBaselineArtifacts,
  bundledBaselineAuditDetail,
  canonicalBundledBaselineJson,
  computeBundledBaselineArtifacts,
  exactStoredRule,
  LOSPOR_BUNDLED_BASELINE_RELEASE,
  type BundledBaselineArtifact,
} from "./bundled-baseline-contract"

const AUDIT_ACTION = "CLINICAL_BUNDLED_BASELINE_PROVISION" satisfies AuditActionCode
const PUBLICATION_REASON = "Exact immutable canonical baseline bundled with LOSPOR 1.2.0"
const MAX_SERIALIZABLE_ATTEMPTS = 3

function publicationEvidenceId(artifact: BundledBaselineArtifact): string {
  return `${LOSPOR_BUNDLED_BASELINE_RELEASE.technicalPrincipal.id}:${artifact.identity.clinicalMode.toLowerCase()}:publication`
}

function auditEvidenceId(artifact: BundledBaselineArtifact): string {
  return `${LOSPOR_BUNDLED_BASELINE_RELEASE.technicalPrincipal.id}:${artifact.identity.clinicalMode.toLowerCase()}:audit`
}

export type BundledBaselineProvisionErrorCode =
  | "BUNDLED_BASELINE_COLLISION"
  | "BUNDLED_BASELINE_PARTIAL_STATE"
  | "BUNDLED_BASELINE_SELECTION_CONFLICT"
  | "BUNDLED_BASELINE_VERIFICATION_FAILED"

export class BundledBaselineProvisionError extends Error {
  constructor(
    readonly code: BundledBaselineProvisionErrorCode,
    message: string,
  ) {
    super(message)
  }
}

type TransactionRunner = {
  $transaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { isolationLevel: "Serializable"; maxWait: number; timeout: number },
  ): Promise<T>
}

type Inspection = Awaited<ReturnType<typeof inspectState>>

export type BundledBaselineProvisionResult = {
  outcome: "installed" | "verified"
  releaseVersion: "1.2.0"
  technicalPrincipalId: "lospor-release:1.2.0"
  baselines: Array<{
    clinicalMode: "ADULT" | "PEDIATRIC"
    presetId: string
    presetVersion: 2
    ruleCount: number
    contentSha256: string
    descriptorSha256: string
  }>
}

function result(
  outcome: BundledBaselineProvisionResult["outcome"],
  artifacts: readonly BundledBaselineArtifact[],
): BundledBaselineProvisionResult {
  return {
    outcome,
    releaseVersion: LOSPOR_BUNDLED_BASELINE_RELEASE.releaseVersion,
    technicalPrincipalId: LOSPOR_BUNDLED_BASELINE_RELEASE.technicalPrincipal.id,
    baselines: artifacts.map(artifact => ({
      clinicalMode: artifact.identity.clinicalMode,
      presetId: artifact.identity.presetId,
      presetVersion: artifact.identity.presetVersion,
      ruleCount: artifact.ruleCount,
      contentSha256: artifact.contentSha256,
      descriptorSha256: artifact.descriptorSha256,
    })),
  }
}

async function inspectState(
  tx: Prisma.TransactionClient,
  artifacts: readonly BundledBaselineArtifact[],
) {
  const principal = LOSPOR_BUNDLED_BASELINE_RELEASE.technicalPrincipal
  const presetIds = artifacts.map(artifact => artifact.identity.presetId)
  const publicationIds = artifacts.map(publicationEvidenceId)
  const auditIds = artifacts.map(auditEvidenceId)
  const clinicalModes = artifacts.map(artifact => artifact.identity.clinicalMode)
  const [principals, accountCount, sessionCount, presets, selections, audits] = await Promise.all([
    tx.technicalPrincipal.findMany({
      where: {
        OR: [
          { id: principal.id },
          { kind: principal.kind, releaseVersion: LOSPOR_BUNDLED_BASELINE_RELEASE.releaseVersion },
        ],
      },
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
          { publicationEvidence: { is: { id: { in: publicationIds } } } },
        ],
      },
      include: {
        rules: { orderBy: { ruleKey: "asc" } },
        publicationEvidence: true,
      },
      orderBy: { id: "asc" },
    }),
    tx.platformClinicalPresetSelection.findMany({
      where: { clinicalMode: { in: clinicalModes } },
      orderBy: { clinicalMode: "asc" },
    }),
    tx.auditLog.findMany({
      where: {
        OR: [
          { id: { in: auditIds } },
          { action: AUDIT_ACTION, entityId: { in: presetIds } },
          { userId: principal.id },
        ],
      },
      orderBy: { createdAt: "asc" },
    }),
  ])
  return { principals, accountCount, sessionCount, presets, selections, audits }
}

function isPristine(inspection: Inspection): boolean {
  return inspection.principals.length === 0
    && inspection.accountCount === 0
    && inspection.sessionCount === 0
    && inspection.presets.length === 0
    && inspection.selections.length === 0
    && inspection.audits.length === 0
}

function sameInstant(left: Date | null, right: Date | null): boolean {
  return left instanceof Date && right instanceof Date && left.getTime() === right.getTime()
}

function verifyCompleteState(
  inspection: Inspection,
  artifacts: readonly BundledBaselineArtifact[],
): void {
  const principal = LOSPOR_BUNDLED_BASELINE_RELEASE.technicalPrincipal
  if (inspection.accountCount !== 0 || inspection.sessionCount !== 0) {
    throw new BundledBaselineProvisionError(
      "BUNDLED_BASELINE_COLLISION",
      "The LOSPOR release principal collides with a login-capable account or session",
    )
  }

  for (const artifact of artifacts) {
    const selection = inspection.selections.find(item => (
      item.clinicalMode === artifact.identity.clinicalMode
    ))
    if (selection && selection.presetId !== artifact.identity.presetId) {
      throw new BundledBaselineProvisionError(
        "BUNDLED_BASELINE_SELECTION_CONFLICT",
        `Refusing to replace the governed ${artifact.identity.clinicalMode} platform selection`,
      )
    }
  }

  if (inspection.principals.length !== 1
    || inspection.presets.length !== artifacts.length
    || inspection.selections.length !== artifacts.length
    || inspection.audits.length !== artifacts.length) {
    throw new BundledBaselineProvisionError(
      "BUNDLED_BASELINE_PARTIAL_STATE",
      "Bundled baseline state is partial; no rows were repaired or overwritten",
    )
  }
  const storedPrincipal = inspection.principals[0]
  if (storedPrincipal?.id !== principal.id
    || storedPrincipal.kind !== principal.kind
    || storedPrincipal.displayName !== principal.displayName
    || storedPrincipal.releaseVersion !== LOSPOR_BUNDLED_BASELINE_RELEASE.releaseVersion
    || !(storedPrincipal.createdAt instanceof Date)) {
    throw new BundledBaselineProvisionError(
      "BUNDLED_BASELINE_COLLISION",
      "LOSPOR 1.2.0 technical principal identity collision",
    )
  }

  for (const artifact of artifacts) {
    const matching = inspection.presets.filter(preset => (
      preset.id === artifact.identity.presetId
      || (
        preset.key === artifact.identity.presetKey
        && preset.clinicalMode === artifact.identity.clinicalMode
        && preset.scope === "PLATFORM"
        && preset.ownerInstitutionId === null
        && preset.ownerUserId === null
        && preset.version === artifact.identity.presetVersion
      )
    ))
    if (matching.length !== 1 || matching[0]?.id !== artifact.identity.presetId) {
      throw new BundledBaselineProvisionError(
        "BUNDLED_BASELINE_COLLISION",
        `Bundled ${artifact.identity.clinicalMode} baseline identity collision`,
      )
    }
    const preset = matching[0]
    if (preset.key !== artifact.identity.presetKey
      || preset.name !== artifact.name
      || preset.description !== artifact.description
      || preset.clinicalMode !== artifact.identity.clinicalMode
      || preset.scope !== "PLATFORM"
      || preset.ownerInstitutionId !== null
      || preset.ownerUserId !== null
      || preset.copiedFromPresetId !== null
      || preset.copiedFromVersion !== null
      || preset.version !== artifact.identity.presetVersion
      || preset.status !== "PUBLISHED"
      || preset.createdById !== null
      || preset.publishedById !== null
      || preset.createdByTechnicalPrincipalId !== principal.id
      || preset.publishedByTechnicalPrincipalId !== principal.id
      || !(preset.publishedAt instanceof Date)
      || !sameInstant(preset.createdAt, storedPrincipal.createdAt)
      || !sameInstant(preset.updatedAt, storedPrincipal.createdAt)
      || preset.rules.length !== artifact.rules.length) {
      throw new BundledBaselineProvisionError(
        "BUNDLED_BASELINE_VERIFICATION_FAILED",
        `Stored ${artifact.identity.clinicalMode} baseline metadata is not the exact release`,
      )
    }
    const storedRulesByKey = new Map(preset.rules.map(rule => [rule.ruleKey, rule]))
    if (storedRulesByKey.size !== preset.rules.length) {
      throw new BundledBaselineProvisionError(
        "BUNDLED_BASELINE_VERIFICATION_FAILED",
        `Stored ${artifact.identity.clinicalMode} baseline has duplicate rule keys`,
      )
    }
    for (const expectedRule of artifact.rules) {
      const storedRule = storedRulesByKey.get(expectedRule.ruleKey)
      if (!storedRule || !exactStoredRule(storedRule, expectedRule)) {
        throw new BundledBaselineProvisionError(
          "BUNDLED_BASELINE_VERIFICATION_FAILED",
          `Stored ${artifact.identity.clinicalMode} rule content or source references differ`,
        )
      }
    }

    const evidence = preset.publicationEvidence
    if (!evidence
      || evidence.id !== publicationEvidenceId(artifact)
      || evidence.baselinePresetId !== null
      || evidence.baselinePresetVersion !== null
      || evidence.reason !== PUBLICATION_REASON
      || evidence.contentSha256 !== artifact.contentSha256
      || evidence.diffSha256 !== artifact.diffSha256
      || evidence.confirmedById !== null
      || evidence.confirmedByTechnicalPrincipalId !== principal.id
      || !sameInstant(evidence.confirmedAt, preset.publishedAt)
      || canonicalBundledBaselineJson(evidence.exactDiff)
        !== canonicalBundledBaselineJson(artifact.exactDiff)) {
      throw new BundledBaselineProvisionError(
        "BUNDLED_BASELINE_VERIFICATION_FAILED",
        `Stored ${artifact.identity.clinicalMode} publication evidence differs`,
      )
    }

    const selection = inspection.selections.find(item => (
      item.clinicalMode === artifact.identity.clinicalMode
    ))
    if (!selection
      || selection.presetId !== artifact.identity.presetId
      || selection.selectedById !== null
      || selection.selectedByTechnicalPrincipalId !== principal.id
      || !sameInstant(selection.selectedAt, preset.publishedAt)
      || !sameInstant(selection.selectedAt, storedPrincipal.createdAt)
      || !sameInstant(selection.updatedAt, storedPrincipal.createdAt)) {
      throw new BundledBaselineProvisionError(
        "BUNDLED_BASELINE_VERIFICATION_FAILED",
        `Stored ${artifact.identity.clinicalMode} platform selection differs`,
      )
    }

    const matchingAudits = inspection.audits.filter(audit => (
      audit.id === auditEvidenceId(artifact)
      && audit.entityId === artifact.identity.presetId
      && audit.userId === principal.id
      && audit.action === AUDIT_ACTION
      && sameInstant(audit.createdAt, storedPrincipal.createdAt)
    ))
    if (matchingAudits.length !== 1) {
      throw new BundledBaselineProvisionError(
        "BUNDLED_BASELINE_VERIFICATION_FAILED",
        `Stored ${artifact.identity.clinicalMode} audit evidence is missing or ambiguous`,
      )
    }
    try {
      assertBundledBaselineAuditDetail(
        matchingAudits[0]?.detail,
        bundledBaselineAuditDetail(artifact),
      )
    } catch (error) {
      throw new BundledBaselineProvisionError(
        "BUNDLED_BASELINE_VERIFICATION_FAILED",
        error instanceof Error ? error.message : "Invalid bundled baseline audit evidence",
      )
    }
  }
}

async function installPristineState(
  tx: Prisma.TransactionClient,
  artifacts: readonly BundledBaselineArtifact[],
  installedAt: Date,
): Promise<void> {
  const principal = LOSPOR_BUNDLED_BASELINE_RELEASE.technicalPrincipal
  await tx.technicalPrincipal.create({
    data: {
      id: principal.id,
      kind: principal.kind,
      displayName: principal.displayName,
      releaseVersion: LOSPOR_BUNDLED_BASELINE_RELEASE.releaseVersion,
      createdAt: installedAt,
    },
  })
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
        baselinePresetId: null,
        baselinePresetVersion: null,
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
    await tx.platformClinicalPresetSelection.create({
      data: {
        clinicalMode: artifact.identity.clinicalMode,
        presetId: artifact.identity.presetId,
        selectedByTechnicalPrincipalId: principal.id,
        selectedAt: installedAt,
        updatedAt: installedAt,
      },
    })
    await tx.auditLog.create({
      data: {
        id: auditEvidenceId(artifact),
        userId: principal.id,
        action: AUDIT_ACTION,
        entityId: artifact.identity.presetId,
        detail: bundledBaselineAuditDetail(artifact) as unknown as Prisma.InputJsonValue,
        createdAt: installedAt,
      },
    })
  }
}

function retryableSerialization(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const code = "code" in error ? String(error.code) : ""
  return code === "P2034" || code === "P2002"
}

function prismaErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return ""
  return String(error.code)
}

async function provisionInTransaction(
  tx: Prisma.TransactionClient,
  artifacts: readonly BundledBaselineArtifact[],
  installedAt: Date,
): Promise<BundledBaselineProvisionResult> {
  const inspection = await inspectState(tx, artifacts)
  if (isPristine(inspection)) {
    await installPristineState(tx, artifacts, installedAt)
    verifyCompleteState(await inspectState(tx, artifacts), artifacts)
    return result("installed", artifacts)
  }
  verifyCompleteState(inspection, artifacts)
  return result("verified", artifacts)
}

/**
 * Transaction-level composition point for migration and integration tooling.
 * The caller must provide a real SERIALIZABLE Prisma transaction. Ordinary
 * callers should use provisionBundledClinicalBaselines, which enforces that.
 */
export async function provisionBundledClinicalBaselinesInSerializableTransaction(
  tx: Prisma.TransactionClient,
  options: { installedAt?: Date } = {},
): Promise<BundledBaselineProvisionResult> {
  const artifacts = computeBundledBaselineArtifacts()
  assertExactBundledBaselineArtifacts(artifacts)
  const installedAt = options.installedAt ?? new Date()
  if (!Number.isFinite(installedAt.getTime())) throw new Error("installedAt must be a valid instant")
  return provisionInTransaction(tx, artifacts, installedAt)
}

export async function provisionBundledClinicalBaselines(
  db: PrismaClient | TransactionRunner,
  options: { installedAt?: Date } = {},
): Promise<BundledBaselineProvisionResult> {
  const artifacts = computeBundledBaselineArtifacts()
  assertExactBundledBaselineArtifacts(artifacts)
  const installedAt = options.installedAt ?? new Date()
  if (!Number.isFinite(installedAt.getTime())) throw new Error("installedAt must be a valid instant")

  for (let attempt = 1; attempt <= MAX_SERIALIZABLE_ATTEMPTS; attempt += 1) {
    try {
      return await (db as TransactionRunner).$transaction(async tx => {
        return provisionInTransaction(tx, artifacts, installedAt)
      }, {
        isolationLevel: PrismaNamespace.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 120_000,
      })
    } catch (error) {
      if (attempt < MAX_SERIALIZABLE_ATTEMPTS && retryableSerialization(error)) continue
      if (prismaErrorCode(error) === "P2002") {
        throw new BundledBaselineProvisionError(
          "BUNDLED_BASELINE_COLLISION",
          "A bundled release identity was claimed concurrently; no rows were overwritten",
        )
      }
      throw error
    }
  }
  throw new Error("Unreachable bundled baseline retry state")
}
