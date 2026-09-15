import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@lospor/core/vocabulary", () => ({
  VOCABULARY_VERSION: "2026-09-13",
  icd10Rows: () => [
    { code: "A00", labelEn: "Cholera", labelBg: "Холера" },
    { code: "A01", labelEn: "Typhoid", labelBg: "Тиф" },
  ],
}))

import { seedIcd10FromBundle } from "../../scripts/seed-icd10-from-bundle"

describe("ICD-10 bundle synchronization", () => {
  const findMany = vi.fn()
  const createMany = vi.fn()
  const executeRaw = vi.fn()
  const prisma = {
    icd10Code: { findMany, createMany },
    $executeRaw: executeRaw,
  } as never

  beforeEach(() => {
    vi.clearAllMocks()
    createMany.mockResolvedValue({ count: 0 })
    executeRaw.mockResolvedValue(0)
  })

  it("inserts missing rows and reconciles stale bundled labels", async () => {
    findMany.mockResolvedValue([
      { code: "A00", labelEn: "Old cholera", labelBg: "Старо име" },
      { code: "LOCAL", labelEn: "Local code", labelBg: null },
    ])
    createMany.mockResolvedValue({ count: 1 })
    executeRaw.mockResolvedValue(1)

    const result = await seedIcd10FromBundle(prisma)

    expect(createMany).toHaveBeenCalledWith({
      data: [{ code: "A01", labelEn: "Typhoid", labelBg: "Тиф" }],
      skipDuplicates: true,
    })
    expect(executeRaw).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      bundled: 2,
      alreadyPresent: 2,
      inserted: 1,
      updated: 1,
      version: "2026-09-13",
    })
  })

  it("does no writes when bundled rows already match", async () => {
    findMany.mockResolvedValue([
      { code: "A00", labelEn: "Cholera", labelBg: "Холера" },
      { code: "A01", labelEn: "Typhoid", labelBg: "Тиф" },
    ])

    const result = await seedIcd10FromBundle(prisma)

    expect(createMany).not.toHaveBeenCalled()
    expect(executeRaw).not.toHaveBeenCalled()
    expect(result.inserted).toBe(0)
    expect(result.updated).toBe(0)
  })
})
