// Mirror the framework-free Core catalog into the deployed OptionLibrary.
// Core owns authored option identities and metadata. This adapter enriches
// drug-shaped options with database IDs and resolves tree parent IDs.
//
// Usage: npx tsx scripts/seed-option-library.ts
// Idempotent: upserts on (category, value), then soft-deactivates stale rows.

import "dotenv/config"
import { CLINICAL_CATALOG, type CatalogOption } from "@lospor/core/catalog"
import type { PrismaClient, Prisma } from "../src/generated/prisma/client"
import type { LibraryCategory } from "../src/generated/prisma/enums"

export async function seedOptionLibrary(prisma: PrismaClient): Promise<{ totalRows: number }> {
  const touchedKeys = new Set<string>()
  const touchedCategories = new Set<LibraryCategory>()

  async function upsert(row: {
    category: LibraryCategory
    value: string
    labelEn: string
    labelBg?: string | null
    group?: string | null
    parentId?: string | null
    drugId?: string | null
    color?: string | null
    description?: string | null
    sortOrder: number
    metadata?: Prisma.InputJsonValue
  }) {
    touchedKeys.add(`${row.category}::${row.value}`)
    touchedCategories.add(row.category)
    return prisma.optionLibrary.upsert({
      where: { category_value: { category: row.category, value: row.value } },
      update: {
        labelEn: row.labelEn,
        labelBg: row.labelBg ?? null,
        group: row.group ?? null,
        parentId: row.parentId ?? null,
        drugId: row.drugId ?? null,
        color: row.color ?? null,
        description: row.description ?? null,
        sortOrder: row.sortOrder,
        metadata: row.metadata ?? undefined,
        active: true,
      },
      create: {
        category: row.category,
        value: row.value,
        labelEn: row.labelEn,
        labelBg: row.labelBg ?? null,
        group: row.group ?? null,
        parentId: row.parentId ?? null,
        drugId: row.drugId ?? null,
        color: row.color ?? null,
        description: row.description ?? null,
        sortOrder: row.sortOrder,
        metadata: row.metadata ?? undefined,
      },
    })
  }

  const drugIdCache = new Map<string, string | null>()
  async function findDrugId(name: string): Promise<string | null> {
    if (drugIdCache.has(name)) return drugIdCache.get(name)!
    const byInn = await prisma.drug.findFirst({
      where: { inn: { equals: name, mode: "insensitive" } },
      select: { id: true },
    })
    const found = byInn ?? await prisma.drug.findFirst({
      where: { name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    })
    drugIdCache.set(name, found?.id ?? null)
    return found?.id ?? null
  }

  const drugCategories = new Set<CatalogOption["category"]>([
    "PREMED_DRUG",
    "INTRAOP_DRUG",
    "INTRAOP_INFUSION",
  ])
  const databaseIds = new Map<string, string>()

  for (const option of CLINICAL_CATALOG) {
    const category = option.category as LibraryCategory
    const parentId = option.parentValue
      ? databaseIds.get(`${category}::${option.parentValue}`) ?? null
      : null
    if (option.parentValue && !parentId) {
      throw new Error(`Catalog parent missing for ${category}:${option.value}`)
    }
    const drugId = drugCategories.has(option.category)
      ? await findDrugId(option.label)
      : null
    const saved = await upsert({
      category,
      value: option.value,
      labelEn: option.label,
      labelBg: option.labelBg,
      group: option.group,
      parentId,
      drugId,
      color: option.color,
      description: option.description,
      sortOrder: option.sortOrder,
      metadata: option.metadata as Prisma.InputJsonValue | undefined,
    })
    databaseIds.set(`${category}::${option.value}`, saved.id)
  }

  let deactivated = 0
  for (const category of touchedCategories) {
    const existing = await prisma.optionLibrary.findMany({
      where: { category, active: true },
      select: { id: true, value: true },
    })
    const stale = existing.filter(option =>
      !touchedKeys.has(`${category}::${option.value}`),
    )
    if (stale.length) {
      await prisma.optionLibrary.updateMany({
        where: { id: { in: stale.map(option => option.id) } },
        data: { active: false },
      })
      deactivated += stale.length
    }
  }
  if (deactivated) {
    console.log(`Deactivated ${deactivated} stale OptionLibrary row(s).`)
  }

  const totalRows = await prisma.optionLibrary.count()
  return { totalRows }
}

async function main() {
  const { PrismaClient } = await import("../src/generated/prisma/client")
  const { PrismaPg } = await import("@prisma/adapter-pg")
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
  const prisma = new PrismaClient({
    adapter,
  } satisfies import("../src/generated/prisma/client").Prisma.PrismaClientOptions)
  try {
    const { totalRows } = await seedOptionLibrary(prisma)
    console.log(`OptionLibrary seeded. Total rows: ${totalRows}`)
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
