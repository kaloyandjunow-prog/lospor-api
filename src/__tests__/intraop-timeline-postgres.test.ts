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
 * The 1.4.9 timeline on a real database: the event routes apply the Core rules,
 * a deleted start takes its stop with it, and a forgotten case ends itself.
 */
describe.skipIf(!runPostgres)("intraop timeline PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let disconnectClinicalPrismaForTests: typeof import("@/lib/clinical-transaction").disconnectClinicalPrismaForTests
  let postEvent: typeof import("@/app/v1/cases/[id]/events/route").POST
  let deleteEvent: typeof import("@/app/v1/cases/[id]/events/[eventId]/route").DELETE
  let autoEndStaleIntraopCases: typeof import("@/lib/intraop-auto-end").autoEndStaleIntraopCases

  const suffix = randomUUID()
  const userId = `timeline-user-${suffix}`
  const caseId = `timeline-case-${suffix}`
  const staleCaseId = `timeline-stale-${suffix}`
  const startedAt = new Date(Date.now() - 60 * 60_000)
  const at = (minutes: number) => new Date(startedAt.getTime() + minutes * 60_000).toISOString()

  const send = (event: Record<string, unknown>) => postEvent(
    new Request(`http://localhost/v1/cases/${caseId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    }) as never,
    { params: Promise.resolve({ id: caseId }) },
  )

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ disconnectClinicalPrismaForTests } = await import("@/lib/clinical-transaction"))
    ;({ POST: postEvent } = await import("@/app/v1/cases/[id]/events/route"))
    ;({ DELETE: deleteEvent } = await import("@/app/v1/cases/[id]/events/[eventId]/route"))
    ;({ autoEndStaleIntraopCases } = await import("@/lib/intraop-auto-end"))
    getAuthUserMock.mockResolvedValue({
      id: userId, role: "MEMBER", institutionId: null, institutionName: null,
      firstName: null, lastName: null, title: null, jti: null,
    })
    await prisma.user.create({
      data: { id: userId, email: `${userId}@example.test`, name: "Timeline test", passwordHash: "not-a-real-password" },
    })
    for (const [id, start] of [[caseId, startedAt], [staleCaseId, new Date(Date.now() - 50 * 60 * 60_000)]] as const) {
      await prisma.case.create({ data: { id, userId, createdById: userId, status: "IN_PROGRESS" } })
      await prisma.intraoperativeRecord.create({ data: { caseId: id, startedAt: start, timezone: "UTC", techniques: [], syncRevision: 1 } })
    }
    // Nothing saved to the stale case for 50 hours either (it was abandoned).
    await prisma.$executeRaw`UPDATE "IntraoperativeRecord" SET "updatedAt" = ${new Date(Date.now() - 50 * 60 * 60_000)} WHERE "caseId" = ${staleCaseId}`
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.case.deleteMany({ where: { id: { in: [caseId, staleCaseId] } } })
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [caseId, staleCaseId] } } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await disconnectClinicalPrismaForTests()
    await prisma.$disconnect()
  })

  it("refuses a stop before its start, accepts it after, and deletes the stop with the start", async () => {
    expect((await send({ id: "start", type: "infusion_start", infId: "i1", name: "Propofol", rate: "6", unit: "mg/hr", ts: at(10) })).status).toBe(200)

    const early = await send({ id: "stop-early", type: "infusion_stop", infId: "i1", ts: at(5) })
    expect(early.status).toBe(400)
    expect(await early.json()).toMatchObject({ error: "timeline_rule", code: "STOP_BEFORE_START" })

    const futureVital = await send({ id: "vital-future", type: "vital", heartRate: 70, ts: new Date(Date.now() + 30 * 60_000).toISOString() })
    expect(futureVital.status).toBe(400)

    expect((await send({ id: "stop", type: "infusion_stop", infId: "i1", ts: at(30) })).status).toBe(200)

    const removed = await deleteEvent(
      new Request(`http://localhost/v1/cases/${caseId}/events/start`, { method: "DELETE" }) as never,
      { params: Promise.resolve({ id: caseId, eventId: "start" }) },
    )
    expect(removed.status).toBe(200)
    const active = await prisma.caseEvent.findMany({ where: { caseId, status: "active" }, select: { logicalId: true } })
    expect(active).toEqual([])
  }, 30_000)

  it("ends a case 48 hours after its start at its last entry, and marks it", async () => {
    const sweep = await autoEndStaleIntraopCases()
    expect(sweep.ended).toBeGreaterThanOrEqual(1)
    const stale = await prisma.intraoperativeRecord.findUniqueOrThrow({
      where: { caseId: staleCaseId },
      select: { startedAt: true, endedAt: true, autoEndedAt: true },
    })
    // No entries: the end is the start.
    expect(stale.endedAt?.toISOString()).toBe(stale.startedAt?.toISOString())
    expect(stale.autoEndedAt).not.toBeNull()
    const fresh = await prisma.intraoperativeRecord.findUniqueOrThrow({ where: { caseId }, select: { endedAt: true } })
    expect(fresh.endedAt).toBeNull()
  }, 30_000)
})
