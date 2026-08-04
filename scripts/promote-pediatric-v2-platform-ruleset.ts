/**
 * Publishes the exact source-controlled pediatric v2 snapshot and changes the
 * PEDIATRIC platform selection to v2. Pediatric v1 remains immutable and
 * available for rollback.
 *
 * Dry-run:
 *   $env:PROMOTE_PEDIATRIC_V2_RULESET="YES"
 *   $env:TARGET_CLINICAL_PRESET_ID="lospor-pediatrics-v2"
 *   $env:PUBLISHING_ADMIN_EMAIL="admin@example.com"
 *   npm run clinical-rules:promote-pediatric-v2
 *
 * Apply:
 *   npm run clinical-rules:promote-pediatric-v2 -- --apply
 */
import "dotenv/config"
import { isDeepStrictEqual } from "node:util"
import {
  clinicalRuleKey,
  validateClinicalRuleCollectionForPublication,
} from "@lospor/core/clinical-rules"
import { createLosporPediatricV2Draft } from "@lospor/core/platform-clinical-drafts"
import { Prisma, PrismaClient } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

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
if (!process.env.PUBLISHING_ADMIN_EMAIL) throw new Error("PUBLISHING_ADMIN_EMAIL is required")
if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") {
  throw new Error("Refusing to promote a ruleset in a production-like environment.")
}
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

    const admin = await tx.user.findUnique({
      where: { email: process.env.PUBLISHING_ADMIN_EMAIL },
      select: { id: true, role: true, deletedAt: true },
    })
    if (!admin || admin.role !== "ADMIN" || admin.deletedAt !== null) {
      throw new Error("PUBLISHING_ADMIN_EMAIL must identify an active platform administrator.")
    }

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
      include: { preset: { select: { id: true, status: true, clinicalMode: true, scope: true } } },
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
    await tx.platformClinicalPresetSelection.upsert({
      where: { clinicalMode: "PEDIATRIC" },
      create: {
        clinicalMode: "PEDIATRIC",
        presetId: TARGET_PRESET_ID,
        selectedById: admin.id,
        selectedAt: publishedAt,
      },
      update: {
        presetId: TARGET_PRESET_ID,
        selectedById: admin.id,
        selectedAt: publishedAt,
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
