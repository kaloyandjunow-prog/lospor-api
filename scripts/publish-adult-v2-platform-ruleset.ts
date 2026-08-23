/**
 * Refreshes the adult v2 platform draft from source control and publishes it.
 *
 * The stored draft was generated before the neuraxial local-anaesthetic decision
 * (baricity is compounded at the bedside, so every local anaesthetic offers
 * hypobaric/isobaric/hyperbaric with isobaric preselected, and intrathecal quick
 * concentrations mirror the epidural route). Publishing the stored rows as-is
 * would publish the superseded surface, so the rules are re-synced first.
 *
 * Deliberately narrow:
 *   - only touches the ADULT PLATFORM preset named by the source-controlled draft
 *   - refuses to run against a production-like environment
 *   - aborts if the target is not an unpublished DRAFT
 *   - validates the whole collection before writing anything
 *   - publishes only; it never selects the ruleset, so nothing becomes active
 *     for clinicians until someone explicitly chooses to use it
 *
 * Dry-run (all checks, no write):
 *   $env:PUBLISH_ADULT_V2_RULESET="YES"
 *   npm run clinical-rules:publish-adult-v2
 *
 * Apply after the dry-run succeeds:
 *   npm run clinical-rules:publish-adult-v2 -- --apply
 */
import "dotenv/config"
import type { AuditActionCode } from "../src/lib/audit-actions"
import {
  clinicalRuleKey,
  validateClinicalRuleCollection,
} from "@lospor/core/clinical-rules"
import { createLosporAdultV2Draft } from "@lospor/core/platform-clinical-drafts"
import { Prisma, PrismaClient } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { assertDatabaseWritable } from "./lib/protected-database"
import { buildClinicalRulesetExactDiff } from "../src/lib/clinical-rules/publication-evidence"
import type { ClinicalRulePayload } from "@lospor/core/clinical-rules"

if (process.env.PUBLISH_ADULT_V2_RULESET !== "YES") {
  throw new Error('Refusing to run. Set PUBLISH_ADULT_V2_RULESET="YES" explicitly.')
}
assertDatabaseWritable("publish rulesets")
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
if (!process.env.PUBLISHING_ADMIN_EMAIL) throw new Error("PUBLISHING_ADMIN_EMAIL is required")

const apply = process.argv.includes("--apply")

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
} satisfies Prisma.PrismaClientOptions)

async function main() {
  const draft = createLosporAdultV2Draft()
  if (draft.blockers.length) {
    throw new Error(`Draft still declares blockers:\n- ${draft.blockers.join("\n- ")}`)
  }

  const keys = draft.rules.map(rule => clinicalRuleKey(rule.payload))
  if (new Set(keys).size !== keys.length) {
    throw new Error("Source draft contains duplicate clinical rule keys")
  }
  const validation = validateClinicalRuleCollection(
    draft.rules.map(rule => ({ ruleKey: clinicalRuleKey(rule.payload), payload: rule.payload })),
  )
  if (!validation.valid) {
    throw new Error(
      `Source draft is invalid: ${validation.issues
        .map(issue => `${issue.ruleKey ?? "ruleset"}.${issue.field}: ${issue.message}`)
        .join("; ")}`,
    )
  }

  const target = await prisma.clinicalPreset.findFirst({
    where: {
      key: draft.key,
      clinicalMode: "ADULT",
      scope: "PLATFORM",
      ownerInstitutionId: null,
      ownerUserId: null,
      version: draft.version,
    },
    select: { id: true, key: true, status: true, version: true, _count: { select: { rules: true } } },
  })
  if (!target) throw new Error(`No adult platform preset found for ${draft.key} v${draft.version}`)
  if (target.status !== "DRAFT") {
    throw new Error(`Refusing to touch ${target.key}: expected DRAFT, found ${target.status}`)
  }

  console.log(`Target   : ${target.key} v${target.version} (${target.status}, ${target._count.rules} stored rules)`)
  console.log(`Source   : ${draft.rules.length} rules, 0 blockers`)
  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to refresh and publish.")
    return
  }

  await prisma.$transaction(async tx => {
    const admin = await tx.user.findUnique({
      where: { email: process.env.PUBLISHING_ADMIN_EMAIL },
      select: { id: true, role: true, deletedAt: true },
    })
    if (!admin || admin.role !== "ADMIN" || admin.deletedAt) {
      throw new Error("PUBLISHING_ADMIN_EMAIL must identify an active platform administrator")
    }
    const baseline = await tx.platformClinicalPresetSelection.findUnique({
      where: { clinicalMode: "ADULT" },
      include: { preset: { include: { rules: { orderBy: { ruleKey: "asc" } } } } },
    })
    await tx.clinicalPresetRule.deleteMany({ where: { presetId: target.id } })
    await tx.clinicalPreset.update({
      where: { id: target.id },
      data: {
        name: draft.name,
        description: draft.description,
        rules: {
          create: draft.rules.map(rule => ({
            ruleKey: clinicalRuleKey(rule.payload),
            ruleVersion: `${draft.key}.v${draft.version}.published1`,
            payload: rule.payload as Prisma.InputJsonValue,
            sourceRefs: rule.sourceRefs as Prisma.InputJsonValue,
          })),
        },
      },
    })
    const publishedAt = new Date()
    const evidence = buildClinicalRulesetExactDiff({
      baselinePresetId: baseline?.preset.id ?? null,
      baselinePresetVersion: baseline?.preset.version ?? null,
      baselineRules: (baseline?.preset.rules ?? []).map(rule => ({
        ruleKey: rule.ruleKey,
        ruleVersion: rule.ruleVersion,
        payload: rule.payload as unknown as ClinicalRulePayload,
        sourceRefs: Array.isArray(rule.sourceRefs)
          ? rule.sourceRefs.filter((item): item is string => typeof item === "string")
          : [],
      })),
      nextRules: draft.rules.map(rule => ({
        ruleKey: clinicalRuleKey(rule.payload),
        ruleVersion: `${draft.key}.v${draft.version}.published1`,
        payload: rule.payload,
        sourceRefs: [...rule.sourceRefs],
      })),
    })
    await tx.clinicalRulesetPublicationEvidence.create({
      data: {
        presetId: target.id,
        baselinePresetId: baseline?.preset.id ?? null,
        baselinePresetVersion: baseline?.preset.version ?? null,
        contentSha256: evidence.contentSha256,
        diffSha256: evidence.diffSha256,
        exactDiff: evidence.exactDiff as unknown as Prisma.InputJsonValue,
        confirmedById: admin.id,
        confirmedAt: publishedAt,
      },
    })
    await tx.clinicalPreset.update({
      where: { id: target.id },
      data: {
        status: "PUBLISHED",
        publishedById: admin.id,
        publishedAt,
      },
    })
    await tx.auditLog.create({
      data: {
        userId: admin.id,
        action: "CLINICAL_RULESET_PUBLISH" satisfies AuditActionCode,
        entityId: target.id,
        detail: {
          scope: "PLATFORM",
          clinicalMode: "ADULT",
          contentSha256: evidence.contentSha256,
          diffSha256: evidence.diffSha256,
        },
      },
    })
  })

  const after = await prisma.clinicalPreset.findUnique({
    where: { id: target.id },
    select: { key: true, status: true, version: true, _count: { select: { rules: true } } },
  })
  console.log(`\nPublished: ${after?.key} v${after?.version} (${after?.status}, ${after?._count.rules} rules)`)
  console.log("Not selected. Choose \"Use this ruleset\" to make it active for clinicians.")
}

main()
  .catch(error => { console.error(error); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
