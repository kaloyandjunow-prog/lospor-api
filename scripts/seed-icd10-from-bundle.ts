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
// The appliance seeds its searchable ICD-10 table from the same complete Core
// bundle used by the phone offline. Both surfaces must expose the same codes
// and labels, including the active NHIS CL011 additions.
//
// Seeding rather than teaching the route a fallback keeps one code path. A
// fallback branch would execute only where the database is empty, which is
// exactly the deployment that gets exercised least.
//
// Usage: npx tsx scripts/seed-icd10-from-bundle.ts
//
// The bundle is authoritative for codes it contains. Re-running this seed
// inserts missing codes and reconciles differing labels; unrelated local codes
// remain untouched. Historical case labels are stored in case data, not read
// through this lookup table.

import "dotenv/config"
import { icd10Rows, VOCABULARY_VERSION } from "@lospor/core/vocabulary"
import { Prisma, type PrismaClient } from "../src/generated/prisma/client"

const BATCH = 1000

export async function seedIcd10FromBundle(
  prisma: PrismaClient,
): Promise<{ bundled: number; alreadyPresent: number; inserted: number; updated: number; version: string }> {
  const rows = icd10Rows()
  const existing = new Map(
    (await prisma.icd10Code.findMany({ select: { code: true, labelEn: true, labelBg: true } }))
      .map(row => [row.code, row]),
  )

  const normalized = rows.map(row => ({
    code: row.code,
    labelEn: row.labelEn,
    // Navigation rows without a Bulgarian rubric use SQL NULL, not "".
    labelBg: row.labelBg || null,
  }))
  const missing = normalized.filter(row => !existing.has(row.code))
  const changed = normalized.filter(row => {
    const current = existing.get(row.code)
    return current && (current.labelEn !== row.labelEn || current.labelBg !== row.labelBg)
  })

  let inserted = 0
  for (let i = 0; i < missing.length; i += BATCH) {
    const { count } = await prisma.icd10Code.createMany({
      data: missing.slice(i, i + BATCH),
      skipDuplicates: true,
    })
    inserted += count
  }

  let updated = 0
  for (let i = 0; i < changed.length; i += BATCH) {
    const batch = changed.slice(i, i + BATCH)
    updated += await prisma.$executeRaw`
      UPDATE "Icd10Code" AS target
      SET "labelEn" = source."labelEn", "labelBg" = source."labelBg"
      FROM (VALUES ${Prisma.join(batch.map(row => Prisma.sql`(
        ${row.code}, ${row.labelEn}, ${row.labelBg}
      )`))}) AS source("code", "labelEn", "labelBg")
      WHERE target."code" = source."code"
        AND (target."labelEn", target."labelBg")
          IS DISTINCT FROM (source."labelEn", source."labelBg")
    `
  }

  return {
    bundled: rows.length,
    alreadyPresent: existing.size,
    inserted,
    updated,
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
    console.log(
      `ICD-10 synchronized from bundle ${result.version}: ${result.bundled} bundled, `
      + `${result.inserted} inserted, ${result.updated} labels updated, `
      + `${result.alreadyPresent} previously present.`,
    )
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
