// Put the offline ICD-10 bundle into the database, so a deployment with no
// imported vocabulary can still code a diagnosis.
//
// Why this exists: `/v1/search/icd10` reads `Icd10Code` and nothing else. Its
// two sibling routes do not — `search/procedures` serves a bundled pcs.json and
// never touches the database, and `search/drugs` queries the database and falls
// back to a bundled drugs.json "for development databases before the Drug seed
// has run". ICD-10 was the one route with no floor beneath it, so on any
// deployment where the table is empty the dropdown returns nothing, and an
// empty dropdown reads as "no such code" rather than "nothing is loaded".
//
// A hospital appliance is the first deployment where that is the day-one state:
// it seeds the Core option catalog at install and nothing else, because ICD, ATC
// and the OMOP concept tables come from a licensed package the operator imports
// separately. Meanwhile the appliance already ships all 16,175 of these codes
// inside vendored Core, for the phone's offline search. The data was in the box;
// only the database could not see it.
//
// Seeding rather than teaching the route a fallback keeps one code path. A
// fallback branch would execute only where the database is empty, which is
// exactly the deployment that gets exercised least.
//
// Usage: npx tsx scripts/seed-icd10-from-bundle.ts
//
// Insert-only, deliberately. If an institution has imported its approved
// vocabulary, those rows carry labels this bundle does not have, and a reseed on
// the next update must not overwrite them. Existing codes are left exactly as
// they are; only codes absent from the table are added. The bundle is a floor,
// never a correction.

import "dotenv/config"
import { icd10Rows, VOCABULARY_VERSION } from "@lospor/core/vocabulary"
import type { PrismaClient } from "../src/generated/prisma/client"

const BATCH = 1000

export async function seedIcd10FromBundle(
  prisma: PrismaClient,
): Promise<{ bundled: number; alreadyPresent: number; inserted: number; version: string }> {
  const rows = icd10Rows()
  const existing = new Set(
    (await prisma.icd10Code.findMany({ select: { code: true } })).map(r => r.code),
  )

  const missing = rows
    .filter(row => !existing.has(row.code))
    .map(row => ({
      code: row.code,
      labelEn: row.labelEn,
      // The bundle stores an empty string where a chapter or block has no
      // Bulgarian rubric; the column is nullable and should say so.
      labelBg: row.labelBg ? row.labelBg : null,
    }))

  let inserted = 0
  for (let i = 0; i < missing.length; i += BATCH) {
    const { count } = await prisma.icd10Code.createMany({
      data: missing.slice(i, i + BATCH),
      skipDuplicates: true,
    })
    inserted += count
  }

  return {
    bundled: rows.length,
    alreadyPresent: existing.size,
    inserted,
    version: VOCABULARY_VERSION,
  }
}

async function main() {
  const { PrismaClient } = await import("../src/generated/prisma/client")
  const { PrismaPg } = await import("@prisma/adapter-pg")
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
  const prisma = new PrismaClient({
    adapter,
  } satisfies import("../src/generated/prisma/client").Prisma.PrismaClientOptions)
  try {
    const result = await seedIcd10FromBundle(prisma)
    if (result.inserted === 0) {
      console.log(
        `ICD-10 already present: ${result.alreadyPresent} codes in the database, `
        + `${result.bundled} in bundle ${result.version}. Nothing inserted.`,
      )
    } else {
      console.log(
        `ICD-10 seeded from bundle ${result.version}: inserted ${result.inserted}, `
        + `left ${result.alreadyPresent} existing codes untouched.`,
      )
    }
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error)
    process.exit(1)
  })
}
