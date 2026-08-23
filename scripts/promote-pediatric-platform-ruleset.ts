/**
 * Finalizes the reviewed pediatric v1 DEV draft and selects it as the
 * platform-wide pediatric ruleset.
 *
 * The script is deliberately narrow. It accepts only the exact source-backed
 * v1 draft, upgrades pediatric drug-policy governance metadata to its approved
 * state, publishes the immutable snapshot, and creates the PEDIATRIC platform
 * selection in one serializable transaction.
 *
 * Dry-run:
 *   $env:PROMOTE_PEDIATRIC_PLATFORM_RULESET="YES"
 *   $env:TARGET_CLINICAL_PRESET_ID="lospor-pediatrics-v1"
 *   $env:PUBLISHING_ADMIN_EMAIL="admin@example.com"
 *   npm run clinical-rules:promote-pediatric-platform
 *
 * Apply after reviewing the dry-run:
 *   npm run clinical-rules:promote-pediatric-platform -- --apply
 */
import "dotenv/config"
import type { AuditActionCode } from "../src/lib/audit-actions"
import { isDeepStrictEqual } from "node:util"
import {
  clinicalRuleKey,
  validateClinicalRuleCollectionForPublication,
  type PediatricDrugPolicyRulePayload,
  type ClinicalRulePayload,
} from "@lospor/core/clinical-rules"
import { createLosporPediatricPlatformDraft } from "@lospor/core/platform-clinical-drafts"
import { Prisma, PrismaClient } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { assertDatabaseWritable } from "./lib/protected-database"
import { buildClinicalRulesetExactDiff } from "../src/lib/clinical-rules/publication-evidence"

const AUTHORIZATION_VARIABLE = "PROMOTE_PEDIATRIC_PLATFORM_RULESET"
const TARGET_PRESET_ID = "lospor-pediatrics-v1"
const APPLY_ARGUMENT = "--apply"
const apply = process.argv.slice(2).includes(APPLY_ARGUMENT)
const unknownArguments = process.argv.slice(2).filter(argument => argument !== APPLY_ARGUMENT)

if (unknownArguments.length) throw new Error(`Unknown arguments: ${unknownArguments.join(", ")}`)
if (process.env[AUTHORIZATION_VARIABLE] !== "YES") {
  throw new Error(`Set ${AUTHORIZATION_VARIABLE}="YES" explicitly.`)
}
if (process.env.TARGET_CLINICAL_PRESET_ID !== TARGET_PRESET_ID) {
  throw new Error(`TARGET_CLINICAL_PRESET_ID must be exactly "${TARGET_PRESET_ID}".`)
}
if (!process.env.PUBLISHING_ADMIN_EMAIL) {
  throw new Error("PUBLISHING_ADMIN_EMAIL is required")
}
assertDatabaseWritable("promote a ruleset")
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")

const canonical = createLosporPediatricPlatformDraft()
if (canonical.id !== TARGET_PRESET_ID
  || canonical.clinicalMode !== "PEDIATRIC"
  || canonical.version !== 1
  || !canonical.publishable
  || canonical.blockers.length !== 0) {
  throw new Error("The source pediatric v1 ruleset is not in its approved publishable state.")
}

const canonicalByKey = new Map(canonical.rules.map(rule => [clinicalRuleKey(rule.payload), rule]))
if (canonicalByKey.size !== canonical.rules.length) {
  throw new Error("The source pediatric ruleset contains duplicate rule keys.")
}
const publication = validateClinicalRuleCollectionForPublication(
  canonical.rules.map(rule => ({ ruleKey: clinicalRuleKey(rule.payload), payload: rule.payload })),
)
if (!publication.valid) {
  throw new Error(`The source pediatric ruleset is not publishable: ${publication.issues
    .map(issue => `${issue.ruleKey ?? "ruleset"}.${issue.field}: ${issue.message}`)
    .join("; ")}`)
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
} satisfies Prisma.PrismaClientOptions)

function jsonComparable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
}

function normalizedExistingPolicy(
  payload: PediatricDrugPolicyRulePayload,
  canonicalPayload: PediatricDrugPolicyRulePayload,
): PediatricDrugPolicyRulePayload {
  return {
    ...payload,
    disposition: payload.disposition === "PENDING_RESEARCH"
      ? "MANUAL_NO_PROFILE"
      : payload.disposition,
    reviewStatus: "APPROVED",
    rationaleEn: payload.disposition === "PENDING_RESEARCH"
      || canonicalPayload.disposition === "AUTOFILL_PROFILE"
      ? canonicalPayload.rationaleEn
      : payload.rationaleEn,
  }
}

async function main() {
  await prisma.$transaction(async tx => {
    const preset = await tx.clinicalPreset.findUnique({
      where: { id: TARGET_PRESET_ID },
      include: { rules: true },
    })
    if (!preset) throw new Error(`Target draft ${TARGET_PRESET_ID} does not exist.`)
    if (preset.key !== canonical.key
      || preset.clinicalMode !== "PEDIATRIC"
      || preset.scope !== "PLATFORM"
      || preset.ownerInstitutionId !== null
      || preset.ownerUserId !== null
      || preset.version !== canonical.version
      || preset.status !== "DRAFT"
      || preset.publishedAt !== null) {
      throw new Error("Target is not the exact unpublished pediatric v1 platform draft.")
    }

    const admin = await tx.user.findUnique({
      where: { email: process.env.PUBLISHING_ADMIN_EMAIL },
      select: { id: true, role: true, deletedAt: true },
    })
    if (!admin || admin.role !== "ADMIN" || admin.deletedAt !== null) {
      throw new Error("PUBLISHING_ADMIN_EMAIL must identify an active platform administrator.")
    }

    const [platformSelection, institutionSelections, userSelections, overrides] = await Promise.all([
      tx.platformClinicalPresetSelection.findUnique({ where: { clinicalMode: "PEDIATRIC" } }),
      tx.institutionClinicalPresetSelection.count({ where: { presetId: TARGET_PRESET_ID } }),
      tx.userClinicalPresetSelection.count({ where: { presetId: TARGET_PRESET_ID } }),
      tx.institutionClinicalRuleOverride.count({ where: { presetId: TARGET_PRESET_ID } }),
    ])
    if (platformSelection || institutionSelections || userSelections || overrides) {
      throw new Error("Target must remain unselected and without overrides before first publication.")
    }

    const existingByKey = new Map(preset.rules.map(rule => [rule.ruleKey, rule]))
    const missing = [...canonicalByKey.keys()].filter(ruleKey => !existingByKey.has(ruleKey))
    const unexpected = [...existingByKey.keys()].filter(ruleKey => !canonicalByKey.has(ruleKey))
    if (preset.rules.length !== canonical.rules.length || missing.length || unexpected.length) {
      throw new Error(
        `Database draft differs from source: missing=${missing.length}, unexpected=${unexpected.length}.`,
      )
    }

    for (const [ruleKey, expected] of canonicalByKey) {
      const existing = existingByKey.get(ruleKey)
      if (!existing) throw new Error(`Missing ${ruleKey}`)
      const currentPayload = existing.payload as unknown
      const expectedPayload = expected.payload
      const comparablePayload = currentPayload
        && typeof currentPayload === "object"
        && "kind" in currentPayload
        && currentPayload.kind === "PEDIATRIC_DRUG_POLICY"
        && expectedPayload.kind === "PEDIATRIC_DRUG_POLICY"
        ? normalizedExistingPolicy(
            currentPayload as PediatricDrugPolicyRulePayload,
            expectedPayload,
          )
        : currentPayload
      if (!isDeepStrictEqual(jsonComparable(comparablePayload), jsonComparable(expectedPayload))
        || !isDeepStrictEqual(jsonComparable(existing.sourceRefs), jsonComparable(expected.sourceRefs))) {
        throw new Error(`Database rule ${ruleKey} differs from the approved source snapshot.`)
      }
    }

    if (!apply) {
      console.log(
        `Dry-run passed: ${TARGET_PRESET_ID} has ${preset.rules.length} exact rules and is ready for platform publication.`,
      )
      return
    }

    for (const [ruleKey, expected] of canonicalByKey) {
      await tx.clinicalPresetRule.update({
        where: { presetId_ruleKey: { presetId: TARGET_PRESET_ID, ruleKey } },
        data: {
          ruleVersion: `${canonical.key}.v${canonical.version}`,
          payload: expected.payload as Prisma.InputJsonValue,
          sourceRefs: expected.sourceRefs as Prisma.InputJsonValue,
        },
      })
    }

    const publishedAt = new Date()
    const evidence = buildClinicalRulesetExactDiff({
      baselinePresetId: null,
      baselinePresetVersion: null,
      baselineRules: [],
      nextRules: canonical.rules.map(rule => ({
        ruleKey: clinicalRuleKey(rule.payload),
        ruleVersion: `${canonical.key}.v${canonical.version}`,
        payload: rule.payload as ClinicalRulePayload,
        sourceRefs: [...rule.sourceRefs],
      })),
    })
    await tx.clinicalRulesetPublicationEvidence.create({
      data: {
        presetId: TARGET_PRESET_ID,
        contentSha256: evidence.contentSha256,
        diffSha256: evidence.diffSha256,
        exactDiff: evidence.exactDiff as unknown as Prisma.InputJsonValue,
        confirmedById: admin.id,
        confirmedAt: publishedAt,
      },
    })
    await tx.clinicalPreset.update({
      where: { id: TARGET_PRESET_ID },
      data: {
        name: canonical.name,
        description: canonical.description,
        status: "PUBLISHED",
        publishedById: admin.id,
        publishedAt,
      },
    })
    await tx.platformClinicalPresetSelection.create({
      data: {
        clinicalMode: "PEDIATRIC",
        presetId: TARGET_PRESET_ID,
        selectedById: admin.id,
        selectedAt: publishedAt,
      },
    })
    await tx.auditLog.create({
      data: {
        userId: admin.id,
        action: "CLINICAL_RULESET_PUBLISH_AND_SELECT" satisfies AuditActionCode,
        entityId: TARGET_PRESET_ID,
        detail: {
          scope: "PLATFORM",
          clinicalMode: "PEDIATRIC",
          previousPresetId: null,
          contentSha256: evidence.contentSha256,
          diffSha256: evidence.diffSha256,
        },
      },
    })
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 120_000,
  })

  console.log(apply
    ? `Published and selected ${TARGET_PRESET_ID} as the platform-wide pediatric ruleset.`
    : "No database rows were changed. Re-run with --apply after reviewing the dry-run.")
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
