/**
 * Replaces DEV clinical rulesets with the canonical v8 adult platform baseline.
 *
 * The replacement and its audit row commit together. Against a protected
 * database the run must name the accountable administrator in
 * PUBLISHING_ADMIN_EMAIL; otherwise it is attributed to the LOSPOR release
 * principal, exactly as the bundled baselines are. A development database has
 * no administrator to name until someone bootstraps one.
 *
 * Usage:
 *   $env:RESET_DEV_CLINICAL_RULESETS="YES"
 *   npx tsx scripts/reset-dev-clinical-rulesets.ts
 */
import "dotenv/config"
import type { AuditActionCode } from "../src/lib/audit-actions"
import { randomUUID } from "node:crypto"
import {
  LOSPOR_ADULT_RULESET_KEY,
  LOSPOR_ADULT_RULESET_NAME,
  clinicalRuleKey,
  createLosporAdultRulePayloads,
} from "@lospor/core/clinical-rules"
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

if (process.env.RESET_DEV_CLINICAL_RULESETS !== "YES") {
  throw new Error(
    'Refusing to replace clinical rulesets. Set RESET_DEV_CLINICAL_RULESETS="YES" explicitly.',
  )
}
const database = assertDatabaseWritable("replace rulesets")
assertMaintenanceActorConfigured({ protectedDatabase: database.protected })
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required")
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
} satisfies Prisma.PrismaClientOptions)

async function main() {
  const payloads = createLosporAdultRulePayloads()
  await prisma.$transaction(async tx => {
    const actor = await resolveMaintenanceActor(tx, { protectedDatabase: database.protected })
    const baseline = await tx.platformClinicalPresetSelection.findUnique({
      where: { clinicalMode: "ADULT" },
      include: { preset: { include: { rules: { orderBy: { ruleKey: "asc" } } } } },
    })
    await tx.userClinicalPresetSelection.deleteMany()
    await tx.institutionClinicalPresetSelection.deleteMany()
    await tx.platformClinicalPresetSelection.deleteMany()
    await tx.institutionClinicalRuleOverride.deleteMany()
    // Published evidence is immutable. A development reset retires nothing and
    // deletes only abandoned drafts; the new baseline is a new version.
    await tx.clinicalPreset.deleteMany({ where: { status: "DRAFT" } })

    const latest = await tx.clinicalPreset.aggregate({
      where: { key: LOSPOR_ADULT_RULESET_KEY, clinicalMode: "ADULT", scope: "PLATFORM" },
      _max: { version: true },
    })
    const version = (latest._max.version ?? 0) + 1
    const id = `lospor-adults-dev-${randomUUID()}`
    const publishedAt = new Date()
    const ruleVersion = `${LOSPOR_ADULT_RULESET_KEY}.v${version}`
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
      nextRules: payloads.map(rule => ({
        ruleKey: clinicalRuleKey(rule),
        ruleVersion,
        payload: rule,
        sourceRefs: [],
      })),
    })

    await tx.clinicalPreset.create({
      data: {
        id,
        key: LOSPOR_ADULT_RULESET_KEY,
        name: LOSPOR_ADULT_RULESET_NAME,
        description: "Platform adult anesthesia drug, infusion and fluid rules.",
        clinicalMode: "ADULT",
        scope: "PLATFORM",
        version,
        status: "DRAFT",
        createdById: actorUserId(actor),
        createdByTechnicalPrincipalId: actorTechnicalPrincipalId(actor),
        rules: {
          create: payloads.map(rule => ({
            ruleKey: clinicalRuleKey(rule),
            ruleVersion,
            payload: rule as Prisma.InputJsonValue,
            sourceRefs: [],
          })),
        },
      },
    })
    await tx.clinicalRulesetPublicationEvidence.create({
      data: {
        presetId: id,
        baselinePresetId: baseline?.preset.id ?? null,
        baselinePresetVersion: baseline?.preset.version ?? null,
        contentSha256: evidence.contentSha256,
        diffSha256: evidence.diffSha256,
        exactDiff: evidence.exactDiff as unknown as Prisma.InputJsonValue,
        confirmedById: actorUserId(actor),
        confirmedByTechnicalPrincipalId: actorTechnicalPrincipalId(actor),
        confirmedAt: publishedAt,
      },
    })
    await tx.clinicalPreset.update({
      where: { id },
      data: {
        status: "PUBLISHED",
        publishedAt,
        publishedById: actorUserId(actor),
        publishedByTechnicalPrincipalId: actorTechnicalPrincipalId(actor),
      },
    })
    await tx.platformClinicalPresetSelection.create({
      data: {
        clinicalMode: "ADULT",
        presetId: id,
        selectedById: actorUserId(actor),
        selectedByTechnicalPrincipalId: actorTechnicalPrincipalId(actor),
      },
    })
    await writeMaintenanceAuditRow(tx, actor, {
      action: "CLINICAL_RULESET_DEV_RESET" satisfies AuditActionCode,
      entityId: id,
      source: "scripts/reset-dev-clinical-rulesets.ts",
      detail: {
        clinicalMode: "ADULT",
        version,
        previousPresetId: baseline?.preset.id ?? null,
        contentSha256: evidence.contentSha256,
        diffSha256: evidence.diffSha256,
      },
    })
  }, { timeout: 120_000 })

  console.log(
    `Created ${LOSPOR_ADULT_RULESET_NAME} with ${payloads.length} rules and selected it as the adult platform default.`,
  )
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
