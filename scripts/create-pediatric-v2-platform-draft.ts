/**
 * Append-only import of the source-controlled pediatric v2 platform draft.
 * The script never updates, publishes, selects or deletes a ruleset.
 *
 * Usage:
 *   $env:CREATE_PEDIATRIC_V2_DRAFT="YES"
 *   $env:TARGET_CLINICAL_PRESET_ID="lospor-pediatrics-v2"
 *   npm run clinical-rules:create-pediatric-v2
 */
import "dotenv/config"
import {
  clinicalRuleKey,
  validateClinicalRuleCollectionForPublication,
} from "@lospor/core/clinical-rules"
import { createLosporPediatricV2Draft } from "@lospor/core/platform-clinical-drafts"
import { Prisma, PrismaClient } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

const TARGET_PRESET_ID = "lospor-pediatrics-v2"

if (process.env.CREATE_PEDIATRIC_V2_DRAFT !== "YES") {
  throw new Error('Set CREATE_PEDIATRIC_V2_DRAFT="YES" explicitly.')
}
if (process.env.TARGET_CLINICAL_PRESET_ID !== TARGET_PRESET_ID) {
  throw new Error(`TARGET_CLINICAL_PRESET_ID must be exactly "${TARGET_PRESET_ID}".`)
}
if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") {
  throw new Error("Refusing to create the pediatric v2 draft in a production-like environment.")
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")

const canonical = createLosporPediatricV2Draft()
if (canonical.id !== TARGET_PRESET_ID
  || canonical.clinicalMode !== "PEDIATRIC"
  || canonical.version !== 2
  || !canonical.publishable
  || canonical.blockers.length !== 0) {
  throw new Error("The source pediatric v2 ruleset is not in its approved publishable state.")
}
const ruleKeys = canonical.rules.map(rule => clinicalRuleKey(rule.payload))
if (new Set(ruleKeys).size !== ruleKeys.length) {
  throw new Error("The source pediatric v2 ruleset contains duplicate rule keys.")
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

async function main() {
  const collision = await prisma.clinicalPreset.findFirst({
    where: {
      OR: [
        { id: TARGET_PRESET_ID },
        {
          key: canonical.key,
          clinicalMode: "PEDIATRIC",
          scope: "PLATFORM",
          ownerInstitutionId: null,
          ownerUserId: null,
          version: canonical.version,
        },
      ],
    },
    select: { id: true, key: true, version: true, status: true },
  })
  if (collision) {
    throw new Error(
      `Refusing to overwrite ${collision.id} (${collision.key}/v${collision.version}/${collision.status}).`,
    )
  }

  await prisma.clinicalPreset.create({
    data: {
      id: canonical.id,
      key: canonical.key,
      name: canonical.name,
      description: canonical.description,
      clinicalMode: canonical.clinicalMode,
      scope: "PLATFORM",
      version: canonical.version,
      status: "DRAFT",
      publishedAt: null,
      rules: {
        create: canonical.rules.map(rule => ({
          ruleKey: clinicalRuleKey(rule.payload),
          ruleVersion: `${canonical.key}.v${canonical.version}.draft1`,
          payload: rule.payload as Prisma.InputJsonValue,
          sourceRefs: rule.sourceRefs as Prisma.InputJsonValue,
        })),
      },
    },
  })
  console.log(
    `Created inactive ${TARGET_PRESET_ID} with ${canonical.rules.length} rules. It was not published or selected.`,
  )
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
