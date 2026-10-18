import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"

vi.mock("server-only", () => ({}))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
  && process.env.LOSPOR_BUNDLED_BASELINE_POSTGRES === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

const principalId = "lospor-release:1.2.0"
const presetIds = ["lospor-adults-v2", "lospor-pediatrics-v2"]
const v3PrincipalId = "lospor-release:9.15.0"
const v3PresetIds = ["lospor-adults-v3", "lospor-pediatrics-v3"]

describe.skipIf(!runPostgres)("bundled baseline PostgreSQL transaction", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let provisionInTransaction:
    typeof import("@/lib/clinical-rules/bundled-baseline-provisioner")
      .provisionBundledClinicalBaselinesInSerializableTransaction
  let Prisma: typeof import("@/generated/prisma/client").Prisma

  async function expectPristine(): Promise<void> {
    const [principals, presets, audits] = await Promise.all([
      prisma.technicalPrincipal.count({ where: { id: { in: [principalId, v3PrincipalId] } } }),
      prisma.clinicalPreset.count({ where: { id: { in: [...presetIds, ...v3PresetIds] } } }),
      prisma.auditLog.count({ where: { userId: { in: [principalId, v3PrincipalId] } } }),
    ])
    expect({ principals, presets, audits }).toEqual({ principals: 0, presets: 0, audits: 0 })
  }

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ Prisma } = await import("@/generated/prisma/client"))
    ;({
      provisionBundledClinicalBaselinesInSerializableTransaction: provisionInTransaction,
    } = await import("@/lib/clinical-rules/bundled-baseline-provisioner"))
    await expectPristine()
  })

  afterAll(async () => {
    if (!prisma) return
    await expectPristine()
    await prisma.$disconnect()
  })

  it("passes the real DRAFT/evidence/PUBLISHED triggers, exact retry, and outer rollback", async () => {
    await expect(prisma.$transaction(async tx => {
      const installed = await provisionInTransaction(tx, {
        installedAt: new Date("2026-08-23T12:00:00.000Z"),
      })
      const retry = await provisionInTransaction(tx, {
        installedAt: new Date("2030-01-01T00:00:00.000Z"),
      })
      expect(installed.outcome).toBe("installed")
      expect(retry.outcome).toBe("verified")
      expect([installed.v3.outcome, retry.v3.outcome]).toEqual(["installed", "verified"])
      // v3 beside v2, published through the same triggers, and selected.
      await expect(tx.clinicalPreset.count({
        where: { id: { in: v3PresetIds }, status: "PUBLISHED", publishedByTechnicalPrincipalId: v3PrincipalId },
      })).resolves.toBe(2)
      await expect(tx.clinicalPresetRule.count({
        where: { presetId: { in: v3PresetIds } },
      })).resolves.toBe(634)
      await expect(tx.platformClinicalPresetSelection.findMany({
        orderBy: { clinicalMode: "asc" },
        select: { presetId: true, selectedByTechnicalPrincipalId: true },
      })).resolves.toEqual([
        { presetId: "lospor-adults-v3", selectedByTechnicalPrincipalId: v3PrincipalId },
        { presetId: "lospor-pediatrics-v3", selectedByTechnicalPrincipalId: v3PrincipalId },
      ])
      await expect(tx.clinicalPreset.count({
        where: { id: { in: presetIds }, status: "PUBLISHED" },
      })).resolves.toBe(2)
      await expect(tx.clinicalRulesetPublicationEvidence.count({
        where: { presetId: { in: presetIds } },
      })).resolves.toBe(2)
      await expect(tx.clinicalPresetRule.count({
        where: { presetId: { in: presetIds } },
      })).resolves.toBe(586)
      throw new Error("ROLL_BACK_BUNDLED_BASELINE_TEST")
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 120_000,
    })).rejects.toThrow("ROLL_BACK_BUNDLED_BASELINE_TEST")

    await expectPristine()
  })

  it("rejects mutation of published technical authorship and rolls the install back", async () => {
    await expect(prisma.$transaction(async tx => {
      await provisionInTransaction(tx)
      await tx.clinicalPreset.update({
        where: { id: "lospor-adults-v2" },
        data: { publishedByTechnicalPrincipalId: null },
      })
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 120_000,
    })).rejects.toThrow(/published clinical ruleset metadata is immutable/i)

    await expectPristine()
  })

  it("rejects mutation of the release identity and rolls the install back", async () => {
    await expect(prisma.$transaction(async tx => {
      await provisionInTransaction(tx)
      await tx.technicalPrincipal.update({
        where: { id: principalId },
        data: { displayName: "Changed" },
      })
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 120_000,
    })).rejects.toThrow(/technical principals are immutable/i)

    await expectPristine()
  })
})
