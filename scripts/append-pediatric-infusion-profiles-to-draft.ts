/**
 * Appends only the source-controlled PEDIATRIC_INFUSION_PROFILE rows to the
 * already-imported, inactive pediatric v1 platform draft.
 *
 * This is deliberately append-only: it never updates, deletes, publishes or
 * selects a ruleset, and aborts unless the database still contains the exact
 * reviewed 206-rule pre-infusion baseline.
 *
 * Dry-run:
 *   $env:APPEND_PEDIATRIC_INFUSION_PROFILES_TO_DRAFT="YES"
 *   $env:TARGET_CLINICAL_PRESET_ID="lospor-pediatrics-v1"
 *   npm run clinical-rules:append-pediatric-infusion-profiles
 *
 * Apply after reviewing the dry-run:
 *   npm run clinical-rules:append-pediatric-infusion-profiles -- --apply
 */
import "dotenv/config"
import {
  clinicalRuleKey,
  validateClinicalRuleCollection,
} from "@lospor/core/clinical-rules"
import { createLosporPediatricPlatformDraft } from "@lospor/core/platform-clinical-drafts"
import { PEDIATRIC_INFUSION_PROFILE_RULE_COUNT } from "@lospor/core"
import { Prisma, PrismaClient } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

const AUTHORIZATION_VARIABLE = "APPEND_PEDIATRIC_INFUSION_PROFILES_TO_DRAFT"
const TARGET_PRESET_ID = "lospor-pediatrics-v1"
const REVIEWED_BASELINE_COUNT = 206
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
if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") {
  throw new Error("Refusing to append rules in a production-like environment.")
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")

const draft = createLosporPediatricPlatformDraft()
const infusionRules = draft.rules.filter(rule => rule.payload.kind === "PEDIATRIC_INFUSION_PROFILE")
const baselineRules = draft.rules.filter(rule => rule.payload.kind !== "PEDIATRIC_INFUSION_PROFILE")
if (draft.id !== TARGET_PRESET_ID
  || draft.clinicalMode !== "PEDIATRIC"
  || draft.version !== 1
  || infusionRules.length !== PEDIATRIC_INFUSION_PROFILE_RULE_COUNT
  || baselineRules.length !== REVIEWED_BASELINE_COUNT) {
  throw new Error(
    `Source draft no longer matches the reviewed ${REVIEWED_BASELINE_COUNT} + ${PEDIATRIC_INFUSION_PROFILE_RULE_COUNT} append plan.`,
  )
}

const infusionRuleKeys = infusionRules.map(rule => clinicalRuleKey(rule.payload))
const baselineRuleKeys = new Set(baselineRules.map(rule => clinicalRuleKey(rule.payload)))
if (new Set(infusionRuleKeys).size !== infusionRuleKeys.length) {
  throw new Error("The source pediatric infusion profiles contain duplicate rule keys.")
}
const validation = validateClinicalRuleCollection(
  infusionRules.map(rule => ({ ruleKey: clinicalRuleKey(rule.payload), payload: rule.payload })),
)
if (!validation.valid) {
  throw new Error(`Source infusion profiles are invalid: ${validation.issues
    .map(issue => `${issue.ruleKey ?? "ruleset"}.${issue.field}: ${issue.message}`)
    .join("; ")}`)
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
} satisfies Prisma.PrismaClientOptions)

async function main() {
  await prisma.$transaction(async tx => {
    const preset = await tx.clinicalPreset.findUnique({
      where: { id: TARGET_PRESET_ID },
      select: {
        id: true,
        key: true,
        clinicalMode: true,
        scope: true,
        ownerInstitutionId: true,
        ownerUserId: true,
        version: true,
        status: true,
        publishedAt: true,
        rules: { select: { ruleKey: true } },
      },
    })
    if (!preset) throw new Error(`Target draft ${TARGET_PRESET_ID} does not exist.`)
    if (preset.id !== draft.id
      || preset.key !== draft.key
      || preset.clinicalMode !== "PEDIATRIC"
      || preset.scope !== "PLATFORM"
      || preset.ownerInstitutionId !== null
      || preset.ownerUserId !== null
      || preset.version !== draft.version
      || preset.status !== "DRAFT"
      || preset.publishedAt !== null) {
      throw new Error("Target is not the exact inactive pediatric v1 platform draft.")
    }

    const [platformSelections, institutionSelections, userSelections] = await Promise.all([
      tx.platformClinicalPresetSelection.count({ where: { presetId: TARGET_PRESET_ID } }),
      tx.institutionClinicalPresetSelection.count({ where: { presetId: TARGET_PRESET_ID } }),
      tx.userClinicalPresetSelection.count({ where: { presetId: TARGET_PRESET_ID } }),
    ])
    if (platformSelections !== 0 || institutionSelections !== 0 || userSelections !== 0) {
      throw new Error("Refusing to append to a selected pediatric ruleset.")
    }

    const existingKeys = new Set(preset.rules.map(rule => rule.ruleKey))
    const collisions = infusionRuleKeys.filter(ruleKey => existingKeys.has(ruleKey))
    if (collisions.length) {
      throw new Error(`Refusing to overwrite existing infusion rules: ${collisions.join(", ")}`)
    }
    const missingBaseline = [...baselineRuleKeys].filter(ruleKey => !existingKeys.has(ruleKey))
    const unexpectedBaseline = [...existingKeys].filter(ruleKey => !baselineRuleKeys.has(ruleKey))
    if (preset.rules.length !== baselineRules.length
      || missingBaseline.length
      || unexpectedBaseline.length) {
      throw new Error(
        `Target does not have the reviewed ${REVIEWED_BASELINE_COUNT}-rule baseline: missing=${missingBaseline.length}, unexpected=${unexpectedBaseline.length}.`,
      )
    }

    if (!apply) {
      console.log(
        `Dry-run passed: ${TARGET_PRESET_ID} is inactive, unselected and ready for ${infusionRules.length} append-only infusion rules.`,
      )
      return
    }

    for (const rule of infusionRules) {
      await tx.clinicalPresetRule.create({
        data: {
          presetId: TARGET_PRESET_ID,
          ruleKey: clinicalRuleKey(rule.payload),
          ruleVersion: `${draft.key}.v${draft.version}.draft1`,
          payload: rule.payload as Prisma.InputJsonValue,
          sourceRefs: rule.sourceRefs as Prisma.InputJsonValue,
        },
      })
    }
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 120_000,
  })

  console.log(apply
    ? `Appended ${infusionRules.length} pediatric infusion profiles to inactive ${TARGET_PRESET_ID}; it remains unpublished and unselected.`
    : "No database rows were changed. Re-run with --apply only after reviewing the dry-run.")
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
