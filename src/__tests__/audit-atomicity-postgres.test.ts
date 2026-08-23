import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"

vi.mock("server-only", () => ({}))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

/**
 * An audit entry and the act it records commit together, or neither does.
 *
 * The acts that most need evidence -- transfer, finalization, unfinalization --
 * wrote theirs through `after(() => logAudit(...))`, which by definition runs
 * once the response has been sent, using a helper that swallows its own
 * failures. A process interruption between the commit and that callback left
 * the change in place with nothing recording it, and no error anywhere.
 *
 * This is a database property, so it is tested against a database rather than
 * against a mocked transaction that cannot roll anything back.
 */
describe.skipIf(!runPostgres)("audit entries commit with what they describe", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let logAuditInTransaction: typeof import("@/lib/audit").logAuditInTransaction

  const suffix = randomUUID()
  const userId = `audit-atomicity-user-${suffix}`
  let caseId: string

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ logAuditInTransaction } = await import("@/lib/audit"))
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        name: "Audit atomicity test",
        passwordHash: "not-a-real-password",
      },
    })
    caseId = `audit-atomicity-case-${randomUUID()}`
    await prisma.case.create({ data: { id: caseId, userId, createdById: userId, status: "IN_PROGRESS" } })
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.case.deleteMany({ where: { id: caseId } })
    await prisma.auditLog.deleteMany({ where: { userId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.$disconnect()
  })

  it("keeps both when the transaction commits", async () => {
    await prisma.$transaction(async tx => {
      await tx.case.update({ where: { id: caseId }, data: { notes: "committed" } })
      await logAuditInTransaction(tx, userId, "CASE_UPDATE", caseId, { changedFields: ["notes"] })
    })

    const stored = await prisma.case.findUniqueOrThrow({ where: { id: caseId } })
    expect(stored.notes).toBe("committed")
    expect(await prisma.auditLog.count({
      where: { userId, action: "CASE_UPDATE" },
    })).toBe(1)
  })

  it("keeps neither when the transaction does not", async () => {
    // The failure the old arrangement could not survive: the change committed
    // and the record of it did not.
    await expect(prisma.$transaction(async tx => {
      await tx.case.update({ where: { id: caseId }, data: { notes: "rolled back" } })
      await logAuditInTransaction(tx, userId, "CASE_DELETE", caseId)
      throw new Error("interrupted after the write")
    })).rejects.toThrow("interrupted after the write")

    const stored = await prisma.case.findUniqueOrThrow({ where: { id: caseId } })
    expect(stored.notes).toBe("committed")
    expect(await prisma.auditLog.count({
      where: { userId, action: "CASE_DELETE" },
    })).toBe(0)
  })

  it("aborts the act when the audit entry itself cannot be written", async () => {
    // logAuditInTransaction throws rather than swallowing, so a failure to
    // record takes the change down with it. That is the intended trade: if the
    // evidence cannot be written, the act it describes should not stand.
    await expect(prisma.$transaction(async tx => {
      await tx.case.update({ where: { id: caseId }, data: { notes: "should not survive" } })
      // entityId is NOT NULL; passing null fails the insert the way a genuine
      // audit failure would.
      await logAuditInTransaction(
        tx, userId, "CASE_CREATE", null as unknown as string,
      )
    })).rejects.toThrow()

    const stored = await prisma.case.findUniqueOrThrow({ where: { id: caseId } })
    expect(stored.notes).toBe("committed")
  })

  it("rolls an account lifecycle mutation back when its evidence insert fails", async () => {
    await expect(prisma.$transaction(async tx => {
      await tx.user.update({
        where: { id: userId },
        data: { suspendedAt: new Date("2026-08-23T12:00:00.000Z") },
      })
      await logAuditInTransaction(
        tx,
        userId,
        "ADMIN_ACCOUNT_SUSPEND",
        null as unknown as string,
        { reason: "Atomicity test" },
      )
    })).rejects.toThrow()

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    expect(stored.suspendedAt).toBeNull()
  })
})
