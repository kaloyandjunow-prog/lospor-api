import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"

describe.skipIf(!runPostgres)("case lock PostgreSQL compare-and-set", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let acquireCaseLockAtomic: typeof import("@/lib/case-lock-repository").acquireCaseLockAtomic
  const userId = `lock-test-user-${randomUUID()}`
  const caseId = `lock-test-case-${randomUUID()}`

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ acquireCaseLockAtomic } = await import("@/lib/case-lock-repository"))
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        name: "Lock test user",
        passwordHash: "not-a-real-password",
      },
    })
    await prisma.case.create({ data: { id: caseId, userId } })
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.case.deleteMany({ where: { id: caseId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.$disconnect()
  })

  it("allows exactly one of two devices to acquire an unowned case", async () => {
    const attempts = await Promise.all([
      acquireCaseLockAtomic({ caseId, userId, deviceId: "device-a", ttlMs: 30_000 }),
      acquireCaseLockAtomic({ caseId, userId, deviceId: "device-b", ttlMs: 30_000 }),
    ])

    expect(attempts.filter(Boolean)).toHaveLength(1)
    const stored = await prisma.caseLock.findUniqueOrThrow({ where: { caseId } })
    expect(stored.deviceId).toBe(attempts.find(Boolean)?.deviceId)
  })

  it("refreshes the owner but refuses another device until expiry", async () => {
    const stored = await prisma.caseLock.findUniqueOrThrow({ where: { caseId } })
    await expect(acquireCaseLockAtomic({
      caseId,
      userId,
      deviceId: stored.deviceId,
      ttlMs: 30_000,
    })).resolves.toMatchObject({ deviceId: stored.deviceId })
    await expect(acquireCaseLockAtomic({
      caseId,
      userId,
      deviceId: "device-c",
      ttlMs: 30_000,
    })).resolves.toBeNull()

    await prisma.caseLock.update({
      where: { caseId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await expect(acquireCaseLockAtomic({
      caseId,
      userId,
      deviceId: "device-c",
      ttlMs: 30_000,
    })).resolves.toMatchObject({ deviceId: "device-c" })
  })
})
