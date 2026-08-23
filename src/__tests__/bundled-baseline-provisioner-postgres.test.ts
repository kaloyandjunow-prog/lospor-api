import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"

vi.mock("server-only", () => ({}))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
  && process.env.LOSPOR_BUNDLED_BASELINE_POSTGRES === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

const principalId = "lospor-release:1.2.0"
const presetIds = ["lospor-adults-v2", "lospor-pediatrics-v2"]

describe.skipIf(!runPostgres)("bundled baseline PostgreSQL transaction", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let provisionInTransaction:
    typeof import("@/lib/clinical-rules/bundled-baseline-provisioner")
      .provisionBundledClinicalBaselinesInSerializableTransaction
  let Prisma: typeof import("@/generated/prisma/client").Prisma

  async function expectPristine(): Promise<void> {
    const [principals, presets, audits] = await Promise.all([
      prisma.technicalPrincipal.count({ where: { id: principalId } }),
      prisma.clinicalPreset.count({ where: { id: { in: presetIds } } }),
      prisma.auditLog.count({ where: { userId: principalId } }),
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
