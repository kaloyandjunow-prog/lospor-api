import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"

vi.mock("server-only", () => ({}))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

// The bundle seed exists so a deployment with no imported vocabulary can still
// code a diagnosis. The database and offline clients are seeded from one
// authoritative bundle, so rerunning the seed must also reconcile stale labels.
describe.skipIf(!runPostgres)("ICD-10 bundle seed", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let seedIcd10FromBundle: typeof import("../../scripts/seed-icd10-from-bundle").seedIcd10FromBundle

  const bundledCode = "K80"
  const staleLabelEn = "Stale label"
  const staleLabelBg = "Остаряло наименование"

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ seedIcd10FromBundle } = await import("../../scripts/seed-icd10-from-bundle"))
  })

  afterAll(async () => {
    await seedIcd10FromBundle(prisma)
  })

  it("restores authoritative labels for a bundled code", async () => {
    await prisma.icd10Code.upsert({
      where: { code: bundledCode },
      create: { code: bundledCode, labelEn: staleLabelEn, labelBg: staleLabelBg },
      update: { labelEn: staleLabelEn, labelBg: staleLabelBg },
    })

    const result = await seedIcd10FromBundle(prisma)

    const after = await prisma.icd10Code.findUnique({ where: { code: bundledCode } })
    expect(result.updated).toBeGreaterThan(0)
    expect(after?.labelEn).not.toBe(staleLabelEn)
    expect(after?.labelBg).not.toBe(staleLabelBg)
  })

  it("is idempotent: a second run inserts nothing", async () => {
    await seedIcd10FromBundle(prisma)
    const second = await seedIcd10FromBundle(prisma)
    expect(second.inserted).toBe(0)
    expect(second.updated).toBe(0)
  })

  it("reports the bundle version it seeded from", async () => {
    const result = await seedIcd10FromBundle(prisma)
    expect(result.version).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(result.bundled).toBe(39_613)
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
