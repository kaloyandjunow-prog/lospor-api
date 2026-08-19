import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"

vi.mock("server-only", () => ({}))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

// The bundle seed exists so a deployment with no imported vocabulary can still
// code a diagnosis. The property that matters most is not that it inserts —
// it is that it refuses to overwrite. An institution that has imported its
// approved package holds labels this bundle does not have, and an update that
// reseeded over them would quietly replace curated terminology with generic
// terminology, in a table nothing else validates against.
describe.skipIf(!runPostgres)("ICD-10 bundle seed", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let seedIcd10FromBundle: typeof import("../../scripts/seed-icd10-from-bundle").seedIcd10FromBundle

  // A code no ICD-10 vocabulary contains, so this test never collides with real
  // rows and can be removed again without touching seeded data.
  const importedCode = "ZZ99.7"
  const importedLabelEn = "Institution-approved label that must survive"
  const importedLabelBg = "Одобрено от институцията"

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ seedIcd10FromBundle } = await import("../../scripts/seed-icd10-from-bundle"))
    await prisma.icd10Code.deleteMany({ where: { code: importedCode } })
  })

  afterAll(async () => {
    await prisma.icd10Code.deleteMany({ where: { code: importedCode } })
  })

  it("leaves an already-imported code exactly as the institution imported it", async () => {
    await prisma.icd10Code.create({
      data: { code: importedCode, labelEn: importedLabelEn, labelBg: importedLabelBg },
    })

    await seedIcd10FromBundle(prisma)

    const after = await prisma.icd10Code.findUnique({ where: { code: importedCode } })
    expect(after?.labelEn).toBe(importedLabelEn)
    expect(after?.labelBg).toBe(importedLabelBg)
  })

  it("is idempotent: a second run inserts nothing", async () => {
    await seedIcd10FromBundle(prisma)
    const second = await seedIcd10FromBundle(prisma)
    expect(second.inserted).toBe(0)
  })

  it("reports the bundle version it seeded from", async () => {
    const result = await seedIcd10FromBundle(prisma)
    expect(result.version).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(result.bundled).toBeGreaterThan(10000)
  })

  it("makes the codes the search route reads actually present", async () => {
    await seedIcd10FromBundle(prisma)
    // K80* is the worked example that could not be coded on a fresh appliance.
    const found = await prisma.icd10Code.findMany({
      where: { code: { startsWith: "K80" } },
      orderBy: { code: "asc" },
      take: 3,
    })
    expect(found.length).toBeGreaterThan(0)
    expect(found[0].labelEn.length).toBeGreaterThan(0)
  })
})
