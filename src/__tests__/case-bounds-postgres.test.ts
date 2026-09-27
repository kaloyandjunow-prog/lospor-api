import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"

const { afterMock, getAuthUserMock } = vi.hoisted(() => ({
  afterMock: vi.fn(),
  getAuthUserMock: vi.fn(),
}))

vi.mock("server-only", () => ({}))
vi.mock("next/server", async importOriginal => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: afterMock }
})
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: getAuthUserMock }))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

/**
 * Moving a case's end earlier or its start later (1.4.9; coverage review
 * 9.13.0): refused while charted entries would fall outside the case, and it
 * names them; allowed once nothing would.
 */
describe.skipIf(!runPostgres)("case start and end bounds, PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let addEvent: typeof import("@/lib/case-events").addEvent
  let rebuildProjection: typeof import("@/lib/case-events").rebuildProjection
  let withLockedCaseTransaction: typeof import("@/lib/clinical-transaction").withLockedCaseTransaction
  let disconnectClinicalPrismaForTests: typeof import("@/lib/clinical-transaction").disconnectClinicalPrismaForTests
  let patchCase: typeof import("@/app/v1/cases/[id]/route").PATCH

  const suffix = randomUUID()
  const userId = `case-bounds-user-${suffix}`
  const caseId = `case-bounds-${suffix}`
  const start = Date.parse("2026-09-27T08:00:00.000Z")
  const at = (minutes: number) => new Date(start + minutes * 60_000).toISOString()

  const patch = async (intraop: Record<string, unknown>) => {
    const { syncRevision } = await prisma.intraoperativeRecord.findUniqueOrThrow({ where: { caseId }, select: { syncRevision: true } })
    return patchCase(new Request(`http://localhost/v1/cases/${caseId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-lospor-intraop-revision": String(syncRevision) },
      body: JSON.stringify({ intraop }),
    }) as never, { params: Promise.resolve({ id: caseId }) })
  }
  const bounds = () => prisma.intraoperativeRecord.findUniqueOrThrow({ where: { caseId }, select: { startedAt: true, endedAt: true } })

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ addEvent, rebuildProjection } = await import("@/lib/case-events"))
    ;({ withLockedCaseTransaction, disconnectClinicalPrismaForTests } = await import("@/lib/clinical-transaction"))
    ;({ PATCH: patchCase } = await import("@/app/v1/cases/[id]/route"))
    getAuthUserMock.mockResolvedValue({
      id: userId, role: "MEMBER", institutionId: null, institutionName: null,
      firstName: null, lastName: null, title: null, jti: null,
    })
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, name: "Case bounds test", passwordHash: "not-a-real-password" } })
    await prisma.case.create({ data: { id: caseId, userId, createdById: userId, status: "IN_PROGRESS" } })
    await withLockedCaseTransaction(caseId, async tx => {
      await tx.intraoperativeRecord.create({
        data: { caseId, startedAt: new Date(at(0)), endedAt: new Date(at(60)), timezone: "UTC", techniques: [], keyEvents: {}, syncRevision: 1 },
      })
      await addEvent(tx, caseId, userId, { id: "early", type: "drug", name: "Midazolam", dose: "2", unit: "mg", ts: at(10) } as never, "test")
      await addEvent(tx, caseId, userId, { id: "late", type: "drug", name: "Ondansetron", dose: "4", unit: "mg", ts: at(50) } as never, "test")
      await rebuildProjection(tx, caseId, { revisionAlreadyReserved: true })
    }, { timeout: 20_000 })
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.case.deleteMany({ where: { id: caseId } })
    await prisma.auditLog.deleteMany({ where: { entityId: caseId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await disconnectClinicalPrismaForTests()
    await prisma.$disconnect()
  })

  it("refuses an end moved before a charted entry, names it, and keeps the end", async () => {
    const refused = await patch({ endedAt: at(40) })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: "case_bounds", eventIds: ["late"] })
    expect((await bounds()).endedAt?.toISOString()).toBe(at(60))
  }, 30_000)

  it("refuses a start moved after a charted entry", async () => {
    const refused = await patch({ startedAt: at(20) })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: "case_bounds", eventIds: ["early"] })
    expect((await bounds()).startedAt?.toISOString()).toBe(at(0))
  }, 30_000)

  it("allows either move while every entry stays inside the case", async () => {
    expect((await patch({ endedAt: at(55) })).status).toBe(200)
    expect((await patch({ startedAt: at(5) })).status).toBe(200)
    const saved = await bounds()
    expect([saved.startedAt?.toISOString(), saved.endedAt?.toISOString()]).toEqual([at(5), at(55)])
  }, 30_000)
})
