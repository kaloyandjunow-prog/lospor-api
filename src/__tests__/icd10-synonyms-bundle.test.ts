import fs from "node:fs"
import { describe, expect, it } from "vitest"
import { icd10Rows } from "@lospor/core/vocabulary"
import { BUNDLED_SYNONYM_ID_PREFIX, seedIcd10SynonymsFromBundle } from "../../scripts/seed-icd10-from-bundle"

type Row = { id: string; icd10Code: string; synonym: string }

const pack = JSON.parse(fs.readFileSync("src/data/icd10-synonyms.json", "utf8")) as {
  source: string
  synonyms: Record<string, string[]>
}

// Just enough of Prisma for the seed: an Icd10Code list and an Icd10Synonym table.
function fakePrisma(codes: string[], rows: Row[]) {
  const table = new Map(rows.map(row => [row.id, row]))
  const matches = (row: Row, where?: { id?: { startsWith?: string; in?: string[] }; NOT?: { id: { startsWith: string } } }) =>
    (!where?.id?.startsWith || row.id.startsWith(where.id.startsWith))
    && (!where?.id?.in || where.id.in.includes(row.id))
    && (!where?.NOT || !row.id.startsWith(where.NOT.id.startsWith))
  const prisma = {
    icd10Code: { findMany: async () => codes.map(code => ({ code })) },
    icd10Synonym: {
      findFirst: async ({ where }: { where: Parameters<typeof matches>[1] }) => [...table.values()].find(row => matches(row, where)) ?? null,
      findMany: async () => [...table.values()].map(row => ({ id: row.id })),
      createMany: async ({ data }: { data: Row[] }) => {
        let count = 0
        for (const row of data) if (!table.has(row.id)) { table.set(row.id, row); count++ }
        return { count }
      },
      deleteMany: async ({ where }: { where: Parameters<typeof matches>[1] }) => {
        let count = 0
        for (const row of [...table.values()]) if (matches(row, where)) { table.delete(row.id); count++ }
        return { count }
      },
    },
  }
  return { prisma: prisma as never, table }
}

describe("the bundled English diagnosis synonyms", () => {
  it("are ICD-10-CM words filed under LOSPOR's own ICD-10 codes", () => {
    expect(pack.source).toMatch(/^OHDSI Athena, ICD10CM /)
    const codes = new Set(icd10Rows().map(row => row.code))
    expect(Object.keys(pack.synonyms).every(code => codes.has(code))).toBe(true)
    expect(pack.synonyms["K80.2"]).toContain("Calculus of gallbladder without cholecystitis without obstruction")
    expect(Object.values(pack.synonyms).reduce((sum, words) => sum + words.length, 0)).toBeGreaterThan(100_000)
  })

  it("load into an empty table once, and a second run changes nothing", async () => {
    const { prisma, table } = fakePrisma(["K80.2", "J18.9"], [])
    const first = await seedIcd10SynonymsFromBundle(prisma)
    const expected = pack.synonyms["K80.2"].length + (pack.synonyms["J18.9"]?.length ?? 0)
    expect(first).toMatchObject({ imported: false, inserted: expected, removed: 0 })
    expect([...table.values()].every(row => row.id.startsWith(BUNDLED_SYNONYM_ID_PREFIX))).toBe(true)
    const second = await seedIcd10SynonymsFromBundle(prisma)
    expect(second).toMatchObject({ inserted: 0, removed: 0 })
    expect(table.size).toBe(expected)
  })

  it("remove a bundled word the bundle no longer carries", async () => {
    const stale = { id: `${BUNDLED_SYNONYM_ID_PREFIX}gone`, icd10Code: "K80.2", synonym: "Retired wording" }
    const { prisma, table } = fakePrisma(["K80.2"], [stale])
    const result = await seedIcd10SynonymsFromBundle(prisma)
    expect(result.removed).toBe(1)
    expect(table.has(stale.id)).toBe(false)
  })

  it("never touch synonyms from a terminology import, and step aside for them", async () => {
    const importedRow = { id: "45552208-name", icd10Code: "K80.2", synonym: "Imported wording" }
    const bundledRow = { id: `${BUNDLED_SYNONYM_ID_PREFIX}old`, icd10Code: "K80.2", synonym: "Bundled wording" }
    const { prisma, table } = fakePrisma(["K80.2"], [importedRow, bundledRow])
    const result = await seedIcd10SynonymsFromBundle(prisma)
    expect(result).toMatchObject({ imported: true, inserted: 0, removed: 1 })
    expect([...table.values()]).toEqual([importedRow])
  })
})
