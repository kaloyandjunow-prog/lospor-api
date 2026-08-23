/**
 * Publishes the exact source-controlled pediatric v2 snapshot and changes the
 * PEDIATRIC platform selection to v2. Pediatric v1 remains immutable and
 * available for rollback.
 *
 * The promotion and its audit row commit together. Against a protected database
 * the run must name the accountable administrator in PUBLISHING_ADMIN_EMAIL;
 * otherwise it is attributed to the LOSPOR release principal, exactly as the
 * bundled baselines are.
 *
 * Dry-run:
 *   $env:PROMOTE_PEDIATRIC_V2_RULESET="YES"
 *   $env:TARGET_CLINICAL_PRESET_ID="lospor-pediatrics-v2"
 *   $env:PUBLISHING_ADMIN_EMAIL="admin@example.com"   # required for production
 *   npm run clinical-rules:promote-pediatric-v2
 *
 * Apply:
 *   npm run clinical-rules:promote-pediatric-v2 -- --apply
 */
import "dotenv/config"
import type { AuditActionCode } from "../src/lib/audit-actions"
import { isDeepStrictEqual } from "node:util"
import {
  clinicalRuleKey,
  validateClinicalRuleCollectionForPublication,
} from "@lospor/core/clinical-rules"
import { createLosporPediatricV2Draft } from "@lospor/core/platform-clinical-drafts"
import { Prisma, PrismaClient } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { assertDatabaseWritable } from "./lib/protected-database"
import {
  actorTechnicalPrincipalId,
  actorUserId,
  assertMaintenanceActorConfigured,
  resolveMaintenanceActor,
  writeMaintenanceAuditRow,
} from "../src/lib/clinical-rules/maintenance-actor"
import { buildClinicalRulesetExactDiff } from "../src/lib/clinical-rules/publication-evidence"
import type { ClinicalRulePayload } from "@lospor/core/clinical-rules"

const TARGET_PRESET_ID = "lospor-pediatrics-v2"
const APPLY_ARGUMENT = "--apply"
const apply = process.argv.slice(2).includes(APPLY_ARGUMENT)
const unknownArguments = process.argv.slice(2).filter(argument => argument !== APPLY_ARGUMENT)

if (unknownArguments.length) throw new Error(`Unknown arguments: ${unknownArguments.join(", ")}`)
if (process.env.PROMOTE_PEDIATRIC_V2_RULESET !== "YES") {
  throw new Error('Set PROMOTE_PEDIATRIC_V2_RULESET="YES" explicitly.')
}
if (process.env.TARGET_CLINICAL_PRESET_ID !== TARGET_PRESET_ID) {
  throw new Error(`TARGET_CLINICAL_PRESET_ID must be exactly "${TARGET_PRESET_ID}".`)
}
const database = assertDatabaseWritable("promote a ruleset")
assertMaintenanceActorConfigured({ protectedDatabase: database.protected })
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")

const canonical = createLosporPediatricV2Draft()
const canonicalByKey = new Map(canonical.rules.map(rule => [clinicalRuleKey(rule.payload), rule]))
if (canonical.id !== TARGET_PRESET_ID
  || canonical.version !== 2
  || canonical.clinicalMode !== "PEDIATRIC"
  || !canonical.publishable
  || canonical.blockers.length
  || canonicalByKey.size !== canonical.rules.length) {
  throw new Error("The source pediatric v2 ruleset is not in its approved publishable state.")
}
const publication = validateClinicalRuleCollectionForPublication(
  canonical.rules.map(rule => ({ ruleKey: clinicalRuleKey(rule.payload), payload: rule.payload })),
)
if (!publication.valid) {
  throw new Error(`The source pediatric v2 ruleset is not publishable: ${publication.issues
    .map(issue => `${issue.ruleKey ?? "ruleset"}.${issue.field}: ${issue.message}`)
    .join("; ")}`)
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
} satisfies Prisma.PrismaClientOptions)

function comparable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown
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
      throw new Error("Target is not the exact unpublished pediatric v2 platform draft.")
    }

    const actor = await resolveMaintenanceActor(tx, {
      protectedDatabase: database.protected,
      dryRun: !apply,
    })

    const [institutionSelections, userSelections, overrides] = await Promise.all([
      tx.institutionClinicalPresetSelection.count({ where: { presetId: TARGET_PRESET_ID } }),
      tx.userClinicalPresetSelection.count({ where: { presetId: TARGET_PRESET_ID } }),
      tx.institutionClinicalRuleOverride.count({ where: { presetId: TARGET_PRESET_ID } }),
    ])
    if (institutionSelections || userSelections || overrides) {
      throw new Error("Target v2 draft must remain unselected and without overrides before publication.")
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
      if (!isDeepStrictEqual(comparable(existing.payload), comparable(expected.payload))
        || !isDeepStrictEqual(comparable(existing.sourceRefs), comparable(expected.sourceRefs))) {
        throw new Error(`Database rule ${ruleKey} differs from the approved source snapshot.`)
      }
    }

    const currentSelection = await tx.platformClinicalPresetSelection.findUnique({
      where: { clinicalMode: "PEDIATRIC" },
      include: { preset: { include: { rules: { orderBy: { ruleKey: "asc" } } } } },
    })
    if (currentSelection && (
      currentSelection.preset.clinicalMode !== "PEDIATRIC"
      || currentSelection.preset.scope !== "PLATFORM"
      || currentSelection.preset.status !== "PUBLISHED"
    )) {
      throw new Error("The current pediatric platform selection is not a published platform ruleset.")
    }

    if (!apply) {
      console.log(
        `Dry-run passed: ${TARGET_PRESET_ID} has ${preset.rules.length} exact rules; current selection is ${currentSelection?.presetId ?? "none"}.`,
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
      baselinePresetId: currentSelection?.preset.id ?? null,
      baselinePresetVersion: currentSelection?.preset.version ?? null,
      baselineRules: (currentSelection?.preset.rules ?? []).map(rule => ({
        ruleKey: rule.ruleKey,
        ruleVersion: rule.ruleVersion,
        payload: rule.payload as unknown as ClinicalRulePayload,
        sourceRefs: Array.isArray(rule.sourceRefs)
          ? rule.sourceRefs.filter((item): item is string => typeof item === "string")
          : [],
      })),
      nextRules: canonical.rules.map(rule => ({
        ruleKey: clinicalRuleKey(rule.payload),
        ruleVersion: `${canonical.key}.v${canonical.version}`,
        payload: rule.payload,
        sourceRefs: [...rule.sourceRefs],
      })),
    })
    await tx.clinicalRulesetPublicationEvidence.create({
      data: {
        presetId: TARGET_PRESET_ID,
        baselinePresetId: currentSelection?.preset.id ?? null,
        baselinePresetVersion: currentSelection?.preset.version ?? null,
        contentSha256: evidence.contentSha256,
        diffSha256: evidence.diffSha256,
        exactDiff: evidence.exactDiff as unknown as Prisma.InputJsonValue,
        confirmedById: actorUserId(actor),
        confirmedByTechnicalPrincipalId: actorTechnicalPrincipalId(actor),
        confirmedAt: publishedAt,
      },
    })
    await tx.clinicalPreset.update({
      where: { id: TARGET_PRESET_ID },
      data: {
        name: canonical.name,
        description: canonical.description,
        status: "PUBLISHED",
        publishedById: actorUserId(actor),
        publishedByTechnicalPrincipalId: actorTechnicalPrincipalId(actor),
        publishedAt,
      },
    })
    await tx.platformClinicalPresetSelection.upsert({
      where: { clinicalMode: "PEDIATRIC" },
      create: {
        clinicalMode: "PEDIATRIC",
        presetId: TARGET_PRESET_ID,
        selectedById: actorUserId(actor),
        selectedByTechnicalPrincipalId: actorTechnicalPrincipalId(actor),
        selectedAt: publishedAt,
      },
      update: {
        presetId: TARGET_PRESET_ID,
        selectedById: actorUserId(actor),
        selectedByTechnicalPrincipalId: actorTechnicalPrincipalId(actor),
        selectedAt: publishedAt,
      },
    })
    await writeMaintenanceAuditRow(tx, actor, {
      action: "CLINICAL_RULESET_PUBLISH_AND_SELECT" satisfies AuditActionCode,
      entityId: TARGET_PRESET_ID,
      source: "scripts/promote-pediatric-v2-platform-ruleset.ts",
      detail: {
        scope: "PLATFORM",
        clinicalMode: "PEDIATRIC",
        previousPresetId: currentSelection?.presetId ?? null,
        contentSha256: evidence.contentSha256,
        diffSha256: evidence.diffSha256,
      },
    })
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 120_000,
  })

  console.log(apply
    ? `Published and selected ${TARGET_PRESET_ID}; pediatric v1 was not modified.`
    : "No database rows were changed. Re-run with --apply after reviewing the dry-run.")
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
