/**
 * Appends only the 22 source-controlled PEDIATRIC_FLUID_PROFILE rows to the
 * already-imported, inactive pediatric v1 platform draft.
 *
 * The command is deliberately narrow and append-only. It never updates,
 * deletes, publishes or selects a ruleset, and aborts if the target identity,
 * baseline rule keys or selection state differs from the reviewed DEV draft.
 *
 * Dry-run (all checks, no write):
 *   $env:APPEND_PEDIATRIC_FLUID_PROFILES_TO_DRAFT="YES"
 *   $env:TARGET_CLINICAL_PRESET_ID="lospor-pediatrics-v1"
 *   npm run clinical-rules:append-pediatric-fluid-profiles
 *
 * Apply after the dry-run succeeds:
 *   npm run clinical-rules:append-pediatric-fluid-profiles -- --apply
 */
import "dotenv/config"
import {
  clinicalRuleKey,
  validateClinicalRuleCollection,
} from "@lospor/core/clinical-rules"
import { createLosporPediatricPlatformDraft } from "@lospor/core/platform-clinical-drafts"
import { Prisma, PrismaClient } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { assertDatabaseWritable } from "./lib/protected-database"
import type { AuditActionCode } from "../src/lib/audit-actions"
import {
  ensureMaintenancePrincipal,
  recordMaintenanceAudit,
} from "../src/lib/maintenance-principal"

const AUTHORIZATION_VARIABLE = "APPEND_PEDIATRIC_FLUID_PROFILES_TO_DRAFT"
const TARGET_PRESET_ID = "lospor-pediatrics-v1"
const APPLY_ARGUMENT = "--apply"
const apply = process.argv.slice(2).includes(APPLY_ARGUMENT)
const unknownArguments = process.argv.slice(2).filter(argument => argument !== APPLY_ARGUMENT)

if (unknownArguments.length) {
  throw new Error(`Unknown arguments: ${unknownArguments.join(", ")}`)
}
if (process.env[AUTHORIZATION_VARIABLE] !== "YES") {
  throw new Error(
    `Refusing to inspect or append pediatric fluid profiles. Set ${AUTHORIZATION_VARIABLE}="YES" explicitly.`,
  )
}
if (process.env.TARGET_CLINICAL_PRESET_ID !== TARGET_PRESET_ID) {
  throw new Error(`TARGET_CLINICAL_PRESET_ID must be exactly "${TARGET_PRESET_ID}".`)
}
assertDatabaseWritable("append rules")
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")

const draft = createLosporPediatricPlatformDraft()
const fluidRules = draft.rules.filter(rule => rule.payload.kind === "PEDIATRIC_FLUID_PROFILE")
const baselineRules = draft.rules.filter(rule => rule.payload.kind !== "PEDIATRIC_FLUID_PROFILE")
if (draft.id !== TARGET_PRESET_ID
  || draft.clinicalMode !== "PEDIATRIC"
  || draft.version !== 1
  || fluidRules.length !== 22
  || baselineRules.length !== 184) {
  throw new Error("The source pediatric draft no longer matches the reviewed 184 + 22 append plan.")
}

const fluidRuleKeys = fluidRules.map(rule => clinicalRuleKey(rule.payload))
const baselineRuleKeys = new Set(baselineRules.map(rule => clinicalRuleKey(rule.payload)))
if (new Set(fluidRuleKeys).size !== fluidRuleKeys.length) {
  throw new Error("The source pediatric fluid profiles contain duplicate rule keys.")
}
const validation = validateClinicalRuleCollection(
  fluidRules.map(rule => ({ ruleKey: clinicalRuleKey(rule.payload), payload: rule.payload })),
)
if (!validation.valid) {
  throw new Error(
    `The source pediatric fluid profiles are invalid: ${validation.issues
      .map(issue => `${issue.ruleKey ?? "ruleset"}.${issue.field}: ${issue.message}`)
      .join("; ")}`,
  )
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
      throw new Error("Target ruleset is not the exact inactive pediatric v1 platform draft.")
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
    const collisions = fluidRuleKeys.filter(ruleKey => existingKeys.has(ruleKey))
    if (collisions.length) {
      throw new Error(`Refusing to overwrite existing pediatric fluid rules: ${collisions.join(", ")}`)
    }
    const missingBaseline = [...baselineRuleKeys].filter(ruleKey => !existingKeys.has(ruleKey))
    const unexpectedBaseline = [...existingKeys].filter(ruleKey => !baselineRuleKeys.has(ruleKey))
    if (preset.rules.length !== baselineRules.length
      || missingBaseline.length
      || unexpectedBaseline.length) {
      throw new Error(
        `Target pediatric draft does not have the reviewed 184-rule baseline: missing=${missingBaseline.length}, unexpected=${unexpectedBaseline.length}.`,
      )
    }

    if (!apply) {
      console.log(
        `Dry-run passed: ${TARGET_PRESET_ID} is inactive, unselected and ready for ${fluidRules.length} append-only fluid rules.`,
      )
      return
    }

    for (const rule of fluidRules) {
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
    // One row for the append, not one per rule: the operation is the unit a
    // reader cares about, and 51 identical rows would bury it.
    const appendAction = "CLINICAL_RULESET_RULE_UPSERT" satisfies AuditActionCode
    await recordMaintenanceAudit(tx, {
      actorId: await ensureMaintenancePrincipal(tx),
      action: appendAction,
      entityId: TARGET_PRESET_ID,
      script: "clinical-rules:append-pediatric-fluid-profiles",
      detail: {
        presetKey: draft.key,
        appendedRuleCount: fluidRules.length,
        appendedRuleKeys: fluidRuleKeys,
        baselineRuleCount: baselineRules.length,
      },
    })
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 120_000,
  })

  console.log(apply
    ? `Appended ${fluidRules.length} pediatric fluid profiles to inactive ${TARGET_PRESET_ID}; it remains unpublished and unselected.`
    : "No database rows were changed. Re-run with --apply only after reviewing the dry-run.")
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
