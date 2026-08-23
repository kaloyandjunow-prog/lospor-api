import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"

vi.mock("server-only", () => ({}))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })
const pause = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe.skipIf(!runPostgres)("clinical write PostgreSQL serialization", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let addEvent: typeof import("@/lib/case-events").addEvent
  let rebuildProjection: typeof import("@/lib/case-events").rebuildProjection
  let syncCaseRelational: typeof import("@/lib/relational-sync").syncCaseRelational
  let writeSnapshotAsync: typeof import("@/lib/case-audit").writeSnapshotAsync
  let withLockedCaseTransaction: typeof import("@/lib/clinical-transaction").withLockedCaseTransaction
  let disconnectClinicalPrismaForTests: typeof import("@/lib/clinical-transaction").disconnectClinicalPrismaForTests

  const suffix = randomUUID()
  const userId = `clinical-serialization-user-${suffix}`
  const caseIds: string[] = []

  async function createCase() {
    const caseId = `clinical-serialization-case-${randomUUID()}`
    caseIds.push(caseId)
    await prisma.case.create({ data: { id: caseId, userId, createdById: userId, status: "IN_PROGRESS" } })
    return caseId
  }

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ addEvent, rebuildProjection } = await import("@/lib/case-events"))
    ;({ syncCaseRelational } = await import("@/lib/relational-sync"))
    ;({ writeSnapshotAsync } = await import("@/lib/case-audit"))
    ;({
      withLockedCaseTransaction,
      disconnectClinicalPrismaForTests,
    } = await import("@/lib/clinical-transaction"))
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        name: "Clinical serialization test",
        passwordHash: "not-a-real-password",
      },
    })
  })

  afterEach(async () => {
    await prisma.case.deleteMany({ where: { id: { in: caseIds.splice(0) } } })
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.user.deleteMany({ where: { id: userId } })
    await disconnectClinicalPrismaForTests()
    await prisma.$disconnect()
  })

  it("waits for an in-flight event and snapshots the committed projection", async () => {
    const caseId = await createCase()
    const eventWritten = deferred()
    const releaseEvent = deferred()
    let finalizationSettled = false

    const eventWrite = withLockedCaseTransaction(caseId, async tx => {
      const record = await tx.case.findUniqueOrThrow({ where: { id: caseId }, select: { status: true } })
      expect(record.status).toBe("IN_PROGRESS")
      await addEvent(tx, caseId, userId, {
        id: "concurrent-event",
        type: "clinical_event",
        ts: "2026-07-28T08:00:00.000Z",
        label: "Concurrency marker",
      }, "test")
      await rebuildProjection(tx, caseId)
      eventWritten.resolve()
      await releaseEvent.promise
    }, { timeout: 20_000 })

    await eventWritten.promise
    const finalization = withLockedCaseTransaction(caseId, async tx => {
      await syncCaseRelational(tx, caseId)
      await tx.case.update({
        where: { id: caseId },
        data: { status: "COMPLETE", finalizedAt: new Date() },
      })
      await writeSnapshotAsync(tx, caseId)
    }, { timeout: 20_000 }).finally(() => { finalizationSettled = true })

    await pause(75)
    expect(finalizationSettled).toBe(false)
    releaseEvent.resolve()
    await eventWrite
    await finalization

    const [live, snapshot] = await Promise.all([
      prisma.case.findUniqueOrThrow({
        where: { id: caseId },
        select: {
          status: true,
          clinicalRevision: true,
          eventRevision: true,
          relationalRevision: true,
          intraop: { select: { keyEvents: true } },
        },
      }),
      prisma.caseFinalization.findFirstOrThrow({
        where: { caseId },
        orderBy: { sequence: "desc" },
      }),
    ])
    const frozen = JSON.parse(snapshot.snapshotDocument) as {
      status: string
      clinicalRevision: number
      eventRevision: number
      relationalRevision: number
      intraop?: { keyEvents?: { log?: Array<{ id?: string }> } }
    }

    expect(live.status).toBe("COMPLETE")
    expect(live.eventRevision).toBeGreaterThanOrEqual(1)
    expect(live.relationalRevision).toBe(1)
    expect(live.intraop?.keyEvents).toMatchObject({
      log: expect.arrayContaining([expect.objectContaining({ id: "concurrent-event" })]),
    })
    expect(frozen.status).toBe("COMPLETE")
    expect(frozen.clinicalRevision).toBe(live.clinicalRevision)
    expect(frozen.eventRevision).toBe(live.eventRevision)
    expect(frozen.relationalRevision).toBe(live.relationalRevision)
    expect(frozen.intraop?.keyEvents?.log).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "concurrent-event" })]),
    )
  })

  it("blocks a child write that was waiting when finalization committed", async () => {
    const caseId = await createCase()
    const finalizationLocked = deferred()
    const releaseFinalization = deferred()
    let eventSettled = false

    const finalization = withLockedCaseTransaction(caseId, async tx => {
      await tx.case.update({
        where: { id: caseId },
        data: { status: "COMPLETE", finalizedAt: new Date() },
      })
      finalizationLocked.resolve()
      await releaseFinalization.promise
    }, { timeout: 20_000 })

    await finalizationLocked.promise
    const eventWrite = prisma.caseEvent.create({
      data: {
        caseId,
        userId,
        logicalId: "too-late",
        type: "clinical_event",
        timestamp: new Date("2026-07-28T08:05:00.000Z"),
        label: "Must not persist",
        metadataJson: { id: "too-late", type: "clinical_event" },
        source: "test",
        idempotencyKey: `${caseId}:too-late`,
      },
    }).finally(() => { eventSettled = true })
    void eventWrite.catch(() => undefined)

    await pause(75)
    expect(eventSettled).toBe(false)
    releaseFinalization.resolve()
    await finalization
    await expect(eventWrite).rejects.toThrow(/CASE_FINALIZED/)
    await expect(prisma.caseEvent.count({ where: { caseId } })).resolves.toBe(0)
  })

  it("advances parent revisions for direct section and event writes", async () => {
    const caseId = await createCase()
    const before = await prisma.case.findUniqueOrThrow({ where: { id: caseId } })

    await prisma.intraoperativeRecord.create({
      data: { caseId, keyEvents: {}, syncRevision: 1 },
    })
    await prisma.caseEvent.create({
      data: {
        caseId,
        userId,
        logicalId: "revision-event",
        type: "clinical_event",
        timestamp: new Date("2026-07-28T08:10:00.000Z"),
        metadataJson: { id: "revision-event", type: "clinical_event" },
        source: "test",
        idempotencyKey: `${caseId}:revision-event`,
      },
    })

    const after = await prisma.case.findUniqueOrThrow({ where: { id: caseId } })
    expect(after.clinicalRevision).toBeGreaterThanOrEqual(before.clinicalRevision + 2)
    expect(after.eventRevision).toBe(before.eventRevision + 1)
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime())
  })
})
