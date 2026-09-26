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

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Operation did not complete within ${milliseconds}ms`)),
      milliseconds,
    )
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe.skipIf(!runPostgres)("case PATCH PostgreSQL transaction", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let addEvent: typeof import("@/lib/case-events").addEvent
  let rebuildProjection: typeof import("@/lib/case-events").rebuildProjection
  let withLockedCaseTransaction: typeof import("@/lib/clinical-transaction").withLockedCaseTransaction
  let disconnectClinicalPrismaForTests: typeof import("@/lib/clinical-transaction").disconnectClinicalPrismaForTests
  let patchCase: typeof import("@/app/v1/cases/[id]/route").PATCH

  const suffix = randomUUID()
  const userId = `case-patch-user-${suffix}`
  const caseId = `case-patch-${suffix}`

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ addEvent, rebuildProjection } = await import("@/lib/case-events"))
    ;({
      withLockedCaseTransaction,
      disconnectClinicalPrismaForTests,
    } = await import("@/lib/clinical-transaction"))
    ;({ PATCH: patchCase } = await import("@/app/v1/cases/[id]/route"))

    getAuthUserMock.mockResolvedValue({
      id: userId,
      role: "MEMBER",
      institutionId: null,
      institutionName: null,
      firstName: null,
      lastName: null,
      title: null,
      jti: null,
    })
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        name: "Case PATCH test",
        passwordHash: "not-a-real-password",
      },
    })
    await prisma.case.create({
      data: { id: caseId, userId, createdById: userId, status: "IN_PROGRESS" },
    })
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.case.deleteMany({ where: { id: caseId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await disconnectClinicalPrismaForTests()
    await prisma.$disconnect()
  })

  it("refuses a whole-chart PATCH and commits the rest of the section without it (1.4.9)", async () => {
    const baselineEvent = {
      id: "baseline-event",
      type: "clinical_event",
      ts: "2026-07-28T08:00:00.000Z",
      label: "Anaesthesia started",
      sequence: 1,
    }

    await withLockedCaseTransaction(caseId, async tx => {
      await tx.intraoperativeRecord.create({
        data: {
          caseId,
          startedAt: new Date("2026-07-28T08:00:00.000Z"),
          timezone: "UTC",
          techniques: [],
          keyEvents: {},
          syncRevision: 1,
        },
      })
      await addEvent(tx, caseId, userId, baselineEvent, "test")
      await rebuildProjection(tx, caseId, { revisionAlreadyReserved: true })
    }, { timeout: 20_000 })

    const patch = (intraop: Record<string, unknown>) => within(
      patchCase(new Request(`http://localhost/v1/cases/${caseId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-lospor-intraop-revision": "1" },
        body: JSON.stringify({ intraop }),
      }) as never, { params: Promise.resolve({ id: caseId }) }),
      5_000,
    )

    // The chart is written as single events; a whole chart is refused, and
    // nothing in the section changes.
    const refused = await patch({
      techniques: ["GENERAL_BALANCED"],
      timetableData: { clinicalEvents: [{ colIdx: 1, label: "Incision", color: "#ef4444" }] },
    })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: "timetable_data_retired" })
    const untouched = await prisma.intraoperativeRecord.findUniqueOrThrow({
      where: { caseId },
      select: { techniques: true, syncRevision: true },
    })
    expect(untouched).toEqual({ techniques: [], syncRevision: 1 })

    const response = await patch({ techniques: ["GENERAL_BALANCED"] })
    expect(response.status).toBe(200)
    const body = await response.json() as { intraopRevision: number }
    const [intraop, events] = await Promise.all([
      prisma.intraoperativeRecord.findUniqueOrThrow({
        where: { caseId },
        select: { techniques: true, syncRevision: true },
      }),
      prisma.caseEvent.findMany({ where: { caseId, status: "active" }, select: { logicalId: true } }),
    ])
    expect(intraop).toEqual({ techniques: ["GENERAL_BALANCED"], syncRevision: 2 })
    expect(events).toEqual([{ logicalId: baselineEvent.id }])
    expect(body.intraopRevision).toBe(intraop.syncRevision)
  }, 15_000)
})
