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
import {
  clinicalRuleKey,
  validateClinicalRuleCollection,
} from "@lospor/core/clinical-rules"
import { createLosporAdultV2Draft } from "@lospor/core/platform-clinical-drafts"
import { Prisma, PrismaClient } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { assertDatabaseWritable } from "./lib/protected-database"

if (process.env.PUBLISH_ADULT_V2_RULESET !== "YES") {
  throw new Error('Refusing to run. Set PUBLISH_ADULT_V2_RULESET="YES" explicitly.')
}
assertDatabaseWritable("publish rulesets")
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")

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
    await tx.clinicalPresetRule.deleteMany({ where: { presetId: target.id } })
    await tx.clinicalPreset.update({
      where: { id: target.id },
      data: {
        name: draft.name,
        description: draft.description,
        status: "PUBLISHED",
        publishedAt: new Date(),
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
