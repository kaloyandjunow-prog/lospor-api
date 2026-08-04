/**
 * Replaces DEV clinical rulesets with the canonical v8 adult platform baseline.
 *
 * Usage:
 *   $env:RESET_DEV_CLINICAL_RULESETS="YES"
 *   npx tsx scripts/reset-dev-clinical-rulesets.ts
 */
import "dotenv/config"
import {
  LOSPOR_ADULT_RULESET_KEY,
  LOSPOR_ADULT_RULESET_NAME,
  clinicalRuleKey,
  createLosporAdultRulePayloads,
} from "@lospor/core/clinical-rules"
import { Prisma, PrismaClient } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

if (process.env.RESET_DEV_CLINICAL_RULESETS !== "YES") {
  throw new Error(
    'Refusing to replace clinical rulesets. Set RESET_DEV_CLINICAL_RULESETS="YES" explicitly.',
  )
}
if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") {
  throw new Error("Refusing to replace rulesets in a production-like environment.")
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required")
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
} satisfies Prisma.PrismaClientOptions)

async function main() {
  const payloads = createLosporAdultRulePayloads()
  await prisma.$transaction(async tx => {
    await tx.userClinicalPresetSelection.deleteMany()
    await tx.institutionClinicalPresetSelection.deleteMany()
    await tx.platformClinicalPresetSelection.deleteMany()
    await tx.institutionClinicalRuleOverride.deleteMany()
    await tx.clinicalPreset.deleteMany()

    await tx.clinicalPreset.create({
      data: {
        id: "lospor-adults-v1",
        key: LOSPOR_ADULT_RULESET_KEY,
        name: LOSPOR_ADULT_RULESET_NAME,
        description: "Platform adult anesthesia drug, infusion and fluid rules.",
        clinicalMode: "ADULT",
        scope: "PLATFORM",
        version: 1,
        status: "PUBLISHED",
        publishedAt: new Date(),
        rules: {
          create: payloads.map(rule => ({
            ruleKey: clinicalRuleKey(rule),
            ruleVersion: `${LOSPOR_ADULT_RULESET_KEY}.v1`,
            payload: rule as Prisma.InputJsonValue,
            sourceRefs: [],
          })),
        },
      },
    })
    await tx.platformClinicalPresetSelection.create({
      data: {
        clinicalMode: "ADULT",
        presetId: "lospor-adults-v1",
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
