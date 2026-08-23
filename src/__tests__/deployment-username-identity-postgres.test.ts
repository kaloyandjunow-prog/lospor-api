import { afterAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"

vi.mock("server-only", () => ({}))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
  && process.env.LOSPOR_USERNAME_IDENTITY_POSTGRES === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

const prefix = `username-identity-test-${process.pid}-`
const raceCanonical = `race.clinician.${process.pid}`

describe.skipIf(!runPostgres)("Hospital username PostgreSQL constraints", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let Prisma: typeof import("@/generated/prisma/client").Prisma

  afterAll(async () => {
    if (!prisma) return
    await prisma.user.deleteMany({ where: { id: { startsWith: prefix } } })
    await prisma.$disconnect()
  })

  it("preserves display case while accepting a case-only rename", async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ Prisma } = await import("@/generated/prisma/client"))
    await expect(prisma.$transaction(async transaction => {
      const created = await transaction.user.create({
        data: {
          id: `${prefix}case`,
          email: null,
          username: "Clinician.One",
          usernameCanonical: "clinician.one",
          name: "Test clinician",
          passwordHash: "not-a-login-secret",
          activatedAt: new Date(),
        },
      })
      expect(created.username).toBe("Clinician.One")
      const renamed = await transaction.user.update({
        where: { id: created.id },
        data: { username: "CLINICIAN.One", usernameCanonical: "clinician.one" },
      })
      expect(renamed.username).toBe("CLINICIAN.One")
      throw new Error("ROLL_BACK_USERNAME_CASE_TEST")
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    })).rejects.toThrow("ROLL_BACK_USERNAME_CASE_TEST")
  })

  it("lets the unique canonical index resolve a differently-cased creation race", async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    const create = (id: string, username: string) => prisma.user.create({
      data: {
        id,
        email: null,
        username,
        usernameCanonical: raceCanonical,
        name: "Race clinician",
        passwordHash: "not-a-login-secret",
        activatedAt: new Date(),
      },
    })
    const outcomes = await Promise.allSettled([
      create(`${prefix}race-a`, `Race.Clinician.${process.pid}`),
      create(`${prefix}race-b`, `RACE.CLINICIAN.${process.pid}`),
    ])
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1)
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1)
    await expect(prisma.user.count({
      where: { usernameCanonical: raceCanonical },
    })).resolves.toBe(1)
  })
})
