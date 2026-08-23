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

  it("commits a web timetable PATCH and its event projection in one locked transaction", async () => {
    const baselineEvent = {
      id: "baseline-event",
      type: "clinical_event",
      ts: "2026-07-28T08:00:00.000Z",
      label: "Anaesthesia started",
      sequence: 1,
    }
    const addedClinicalEvent = {
      colIdx: 1,
      label: "Incision",
      color: "#ef4444",
    }
    const addedEventId = `web-${addedClinicalEvent.colIdx}-${addedClinicalEvent.label}`

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

    const before = await prisma.case.findUniqueOrThrow({
      where: { id: caseId },
      select: {
        clinicalRevision: true,
        eventRevision: true,
        relationalRevision: true,
      },
    })
    const request = new Request(`http://localhost/v1/cases/${caseId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-lospor-intraop-revision": "1",
      },
      body: JSON.stringify({
        intraop: {
          techniques: ["GENERAL_BALANCED"],
          timetableData: { clinicalEvents: [addedClinicalEvent] },
        },
      }),
    })

    const response = await within(
      patchCase(request as never, { params: Promise.resolve({ id: caseId }) }),
      5_000,
    )
    expect(response.status).toBe(200)
    const body = await response.json() as {
      clinicalRevision: number
      eventRevision: number
      relationalRevision: number
      intraopRevision: number
    }

    const [updatedCase, intraop, events] = await Promise.all([
      prisma.case.findUniqueOrThrow({
        where: { id: caseId },
        select: {
          clinicalRevision: true,
          eventRevision: true,
          relationalRevision: true,
        },
      }),
      prisma.intraoperativeRecord.findUniqueOrThrow({
        where: { caseId },
        select: {
          techniques: true,
          keyEvents: true,
          syncRevision: true,
        },
      }),
      prisma.caseEvent.findMany({
        where: { caseId, status: "active" },
        orderBy: { timestamp: "asc" },
        select: {
          logicalId: true,
          source: true,
          userId: true,
          metadataJson: true,
        },
      }),
    ])

    expect(intraop.techniques).toEqual(["GENERAL_BALANCED"])
    expect(intraop.syncRevision).toBe(2)
    expect(intraop.keyEvents).toMatchObject({
      log: expect.arrayContaining([
        expect.objectContaining({ id: baselineEvent.id }),
        expect.objectContaining({ id: addedEventId }),
      ]),
    })
    expect(events).toHaveLength(2)
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        logicalId: addedEventId,
        source: "web",
        userId,
        metadataJson: expect.objectContaining({ id: addedEventId }),
      }),
    ]))
    expect(updatedCase.eventRevision).toBe(before.eventRevision + 1)
    expect(updatedCase.clinicalRevision).toBeGreaterThan(before.clinicalRevision)
    expect(updatedCase.relationalRevision).toBe(before.relationalRevision)
    expect(body).toMatchObject({
      clinicalRevision: updatedCase.clinicalRevision,
      eventRevision: updatedCase.eventRevision,
      relationalRevision: updatedCase.relationalRevision,
      intraopRevision: intraop.syncRevision,
    })
  }, 15_000)
})
