/**
 * Creates the source-controlled pediatric v1 and adult v2 platform drafts.
 *
 * This importer is intentionally append-only: it never publishes, selects,
 * updates, replaces or deletes a ruleset. Any identity collision aborts the
 * whole transaction.
 *
 * Usage:
 *   $env:CREATE_PLATFORM_CLINICAL_DRAFTS="YES"
 *   npm run clinical-rules:create-platform-drafts
 */
import "dotenv/config"
import {
  clinicalRuleKey,
  validateClinicalRuleCollection,
} from "@lospor/core/clinical-rules"
import {
  createLosporAdultV2Draft,
  createLosporPediatricPlatformDraft,
} from "@lospor/core/platform-clinical-drafts"
import { Prisma, PrismaClient } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

if (process.env.CREATE_PLATFORM_CLINICAL_DRAFTS !== "YES") {
  throw new Error(
    'Refusing to create platform drafts. Set CREATE_PLATFORM_CLINICAL_DRAFTS="YES" explicitly.',
  )
}
if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") {
  throw new Error("Refusing to create rulesets in a production-like environment.")
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
} satisfies Prisma.PrismaClientOptions)

async function main() {
  const drafts = [
    createLosporPediatricPlatformDraft(),
    createLosporAdultV2Draft(),
  ]

  for (const draft of drafts) {
    const keys = draft.rules.map(rule => clinicalRuleKey(rule.payload))
    if (new Set(keys).size !== keys.length) {
      throw new Error(`${draft.id} contains duplicate clinical rule keys`)
    }
    const validation = validateClinicalRuleCollection(
      draft.rules.map(rule => ({
        ruleKey: clinicalRuleKey(rule.payload),
        payload: rule.payload,
      })),
    )
    if (!validation.valid) {
      throw new Error(
        `${draft.id} is invalid: ${validation.issues
          .map(issue => `${issue.ruleKey ?? "ruleset"}.${issue.field}: ${issue.message}`)
          .join("; ")}`,
      )
    }
  }

  const collisions = await prisma.clinicalPreset.findMany({
    where: {
      OR: drafts.flatMap(draft => [
        { id: draft.id },
        {
          key: draft.key,
          clinicalMode: draft.clinicalMode,
          scope: "PLATFORM" as const,
          ownerInstitutionId: null,
          ownerUserId: null,
          version: draft.version,
        },
      ]),
    },
    select: { id: true, key: true, clinicalMode: true, version: true, status: true },
  })
  if (collisions.length) {
    throw new Error(
      `Refusing to overwrite existing rulesets: ${collisions
        .map(item => `${item.id} (${item.key}/${item.clinicalMode}/v${item.version}/${item.status})`)
        .join(", ")}`,
    )
  }

  await prisma.$transaction(async tx => {
    for (const draft of drafts) {
      await tx.clinicalPreset.create({
        data: {
          id: draft.id,
          key: draft.key,
          name: draft.name,
          description: draft.blockers.length
            ? `${draft.description}\n\nDraft blockers:\n- ${draft.blockers.join("\n- ")}`
            : draft.description,
          clinicalMode: draft.clinicalMode,
          scope: "PLATFORM",
          version: draft.version,
          status: "DRAFT",
          publishedAt: null,
          rules: {
            create: draft.rules.map(rule => ({
              ruleKey: clinicalRuleKey(rule.payload),
              ruleVersion: `${draft.key}.v${draft.version}.draft1`,
              payload: rule.payload as Prisma.InputJsonValue,
              sourceRefs: rule.sourceRefs as Prisma.InputJsonValue,
            })),
          },
        },
      })
    }
  }, { timeout: 120_000 })

  for (const draft of drafts) {
    console.log(
      `Created inactive ${draft.id} with ${draft.rules.length} rules. It was not published or selected.`,
    )
  }
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
