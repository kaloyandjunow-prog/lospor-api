import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
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
// What finalisation needs from the preoperative and postoperative records has
// its own tests; here the case is ready, so only the 10.1.0 step is in play.
vi.mock("@lospor/core/clinical-validation", async importOriginal => {
  const actual = await importOriginal<typeof import("@lospor/core/clinical-validation")>()
  return { ...actual, evaluateCaseFinalization: () => ({ valid: true, issues: [] }) }
})

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

/**
 * The 10.1.0 entries through the real routes and the real database: a timed
 * complication reaches the export's complication rows as it is added, ended
 * and deleted; a replayed answer stays one entry; a shock keeps its energy;
 * an episode still open ends with the case, whether the case is ended by the
 * clock or finalised; and ending or resuming a case asks for no reason.
 */
describe.skipIf(!runPostgres)("intraoperative automation through the routes, PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let addEvent: typeof import("@/lib/case-events").addEvent
  let withLockedCaseTransaction: typeof import("@/lib/clinical-transaction").withLockedCaseTransaction
  let disconnectClinicalPrismaForTests: typeof import("@/lib/clinical-transaction").disconnectClinicalPrismaForTests
  let autoEndCaseIfStale: typeof import("@/lib/intraop-auto-end").autoEndCaseIfStale
  let finalizeCaseWithinTransaction: typeof import("@/lib/case-finalization").finalizeCaseWithinTransaction
  let postEvent: typeof import("@/app/v1/cases/[id]/events/route").POST
  let putEvent: typeof import("@/app/v1/cases/[id]/events/[eventId]/route").PUT
  let deleteEvent: typeof import("@/app/v1/cases/[id]/events/[eventId]/route").DELETE
  let patchCase: typeof import("@/app/v1/cases/[id]/route").PATCH

  const suffix = randomUUID()
  const userId = `automation-routes-user-${suffix}`
  const liveCase = `automation-routes-live-${suffix}`
  const staleCase = `automation-routes-stale-${suffix}`
  const finalCase = `automation-routes-final-${suffix}`
  const endCase = `automation-routes-end-${suffix}`
  const allCases = [liveCase, staleCase, finalCase, endCase]

  const startedAt = new Date(Date.now() - 60 * 60_000)
  const at = (minutes: number, from = startedAt) => new Date(from.getTime() + minutes * 60_000).toISOString()
  const madeAt = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

  const post = (event: Record<string, unknown>, made = madeAt(30)) => postEvent(
    new Request(`http://localhost/v1/cases/${liveCase}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lospor-made-at": made },
      body: JSON.stringify(event),
    }) as never,
    { params: Promise.resolve({ id: liveCase }) },
  )
  const put = (eventId: string, event: Record<string, unknown>, made: string) => putEvent(
    new Request(`http://localhost/v1/cases/${liveCase}/events/${eventId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-lospor-made-at": made },
      body: JSON.stringify(event),
    }) as never,
    { params: Promise.resolve({ id: liveCase, eventId }) },
  )
  const remove = (eventId: string, made: string) => deleteEvent(
    new Request(`http://localhost/v1/cases/${liveCase}/events/${eventId}`, {
      method: "DELETE",
      headers: { "x-lospor-made-at": made },
    }) as never,
    { params: Promise.resolve({ id: liveCase, eventId }) },
  )
  const patchIntraop = async (caseId: string, intraop: Record<string, unknown>) => {
    const { syncRevision } = await prisma.intraoperativeRecord.findUniqueOrThrow({ where: { caseId }, select: { syncRevision: true } })
    return patchCase(new Request(`http://localhost/v1/cases/${caseId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-lospor-intraop-revision": String(syncRevision) },
      body: JSON.stringify({ intraop }),
    }) as never, { params: Promise.resolve({ id: caseId }) })
  }

  /** Runs what the routes left for after the response, as Next.js would. */
  const runAfter = async () => {
    const tasks = afterMock.mock.calls.map(call => call[0] as () => unknown)
    afterMock.mockClear()
    for (const task of tasks) await task()
  }
  const complicationRows = (caseId: string) => prisma.caseComplication.findMany({
    where: { caseId, section: "intraop", eventId: { not: null } },
    orderBy: { timestamp: "asc" },
  })
  const activeEvents = (caseId: string, type?: string) => prisma.caseEvent.findMany({
    where: { caseId, status: "active", ...(type ? { type } : {}) },
    orderBy: [{ logicalId: "asc" }, { version: "desc" }],
  })
  /** The latest active version of one entry, as the apps read it. */
  const latest = async (caseId: string, logicalId: string) => (await activeEvents(caseId))
    .find(row => row.logicalId === logicalId)?.metadataJson as Record<string, unknown> | undefined

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ addEvent } = await import("@/lib/case-events"))
    ;({ withLockedCaseTransaction, disconnectClinicalPrismaForTests } = await import("@/lib/clinical-transaction"))
    ;({ autoEndCaseIfStale } = await import("@/lib/intraop-auto-end"))
    ;({ finalizeCaseWithinTransaction } = await import("@/lib/case-finalization"))
    ;({ POST: postEvent } = await import("@/app/v1/cases/[id]/events/route"))
    ;({ PUT: putEvent, DELETE: deleteEvent } = await import("@/app/v1/cases/[id]/events/[eventId]/route"))
    ;({ PATCH: patchCase } = await import("@/app/v1/cases/[id]/route"))
    getAuthUserMock.mockResolvedValue({
      id: userId, role: "MEMBER", institutionId: null, institutionName: null,
      firstName: null, lastName: null, title: null, jti: null,
    })
    await prisma.user.create({
      data: { id: userId, email: `${userId}@example.test`, username: userId, usernameCanonical: userId.toLowerCase(), name: "Automation routes test", passwordHash: "not-a-real-password" },
    })
    for (const id of allCases) {
      await prisma.case.create({ data: { id, userId, createdById: userId, status: "IN_PROGRESS" } })
    }
    await prisma.intraoperativeRecord.create({ data: { caseId: liveCase, startedAt, timezone: "UTC", techniques: [], syncRevision: 1 } })
    await prisma.intraoperativeRecord.create({ data: { caseId: endCase, startedAt, timezone: "UTC", techniques: [], syncRevision: 1 } })
  })

  beforeEach(() => { afterMock.mockClear() })

  afterAll(async () => {
    if (!prisma) return
    await prisma.$executeRaw`UPDATE "Case" SET "status" = 'IN_PROGRESS' WHERE "id" = ${finalCase}`.catch(() => {})
    await prisma.case.deleteMany({ where: { id: { in: allCases } } })
    await prisma.auditLog.deleteMany({ where: { entityId: { in: allCases } } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await disconnectClinicalPrismaForTests()
    await prisma.$disconnect()
  })

  it("a complication added on the timeline becomes an export row at its own time", async () => {
    const added = await post({ id: "lary", type: "complication", ts: at(10), label: "Laryngospasm", color: "#ef4444", complicationSource: "timeline" })
    expect(added.status).toBe(200)
    await runAfter()
    const rows = await complicationRows(liveCase)
    expect(rows.map(row => [row.eventId, row.label, row.timestamp?.toISOString(), row.endTimestamp])).toEqual([
      ["lary", "Laryngospasm", at(10), null],
    ])
    expect(rows[0]).toMatchObject({ sourceVocabulary: "LOSPOR_COMPLICATION", sourceCode: "Laryngospasm" })
  }, 30_000)

  it("an answer replayed from an offline queue stays one complication", async () => {
    const episode = {
      id: "vq-hypotension-r1", type: "complication", ts: at(20), label: "Hypotension", color: "#ef4444",
      complicationSource: "vitals", triggerReadingId: "r1",
    }
    expect((await post({ id: "r1", type: "vital", ts: at(20), systolic: 60, diastolic: 30, heartRate: 80 })).status).toBe(200)
    expect((await post(episode, madeAt(29))).status).toBe(200)
    expect((await post(episode, madeAt(29))).status).toBe(200)
    await runAfter()
    expect((await activeEvents(liveCase, "complication")).filter(row => row.logicalId === episode.id)).toHaveLength(1)
    expect((await complicationRows(liveCase)).map(row => row.eventId)).toEqual(["lary", "vq-hypotension-r1"])
  }, 30_000)

  it("an episode's end reaches its export row when it closes", async () => {
    const closed = await put("vq-hypotension-r1", {
      type: "complication", ts: at(20), endTs: at(35), label: "Hypotension", color: "#ef4444",
      complicationSource: "vitals", triggerReadingId: "r1",
    }, madeAt(20))
    expect(closed.status).toBe(200)
    await runAfter()
    const row = (await complicationRows(liveCase)).find(item => item.eventId === "vq-hypotension-r1")
    expect(row?.endTimestamp?.toISOString()).toBe(at(35))
  }, 30_000)

  it("a complication deleted from the chart leaves the export, the others stay", async () => {
    expect((await remove("lary", madeAt(15))).status).toBe(200)
    await runAfter()
    expect((await complicationRows(liveCase)).map(row => row.eventId)).toEqual(["vq-hypotension-r1"])
  }, 30_000)

  it("a complication that ends before it starts is refused and changes nothing", async () => {
    const refused = await post({ id: "bad", type: "complication", ts: at(30), endTs: at(25), label: "Bradycardia", complicationSource: "vitals" })
    expect(refused.status).toBe(400)
    expect(await latest(liveCase, "bad")).toBeUndefined()
  }, 30_000)

  it("a shock keeps its energy and whether it was synchronised, and is no complication", async () => {
    expect((await post({ id: "shock", type: "defibrillation", ts: at(40), energyJ: 150, synchronized: true, label: "Cardioversion", color: "#f59e0b" })).status).toBe(200)
    expect((await post({ id: "too-much", type: "defibrillation", ts: at(41), energyJ: 400, synchronized: false })).status).toBe(400)
    await runAfter()
    const [row] = await activeEvents(liveCase, "defibrillation")
    expect(row).toMatchObject({ logicalId: "shock", label: "Cardioversion", value: "150", unit: "J" })
    expect((await complicationRows(liveCase)).map(item => item.eventId)).toEqual(["vq-hypotension-r1"])
  }, 30_000)

  it("a Not now is kept, but never becomes a complication", async () => {
    expect((await post({ id: "r2", type: "vital", ts: at(45), heartRate: 170 })).status).toBe(200)
    const answered = await post({ id: "pa-tachycardia-r2", type: "prompt_answer", ts: at(45), answerFor: "r2", answerKind: "tachycardia", answer: "not_now" })
    expect(answered.status).toBe(200)
    await runAfter()
    expect(await latest(liveCase, "pa-tachycardia-r2")).toMatchObject({ answer: "not_now", answerFor: "r2" })
    expect((await complicationRows(liveCase)).map(item => item.eventId)).toEqual(["vq-hypotension-r1"])
  }, 30_000)

  it("an episode still open ends with a case the clock ended", async () => {
    const started = new Date(Date.now() - 5 * 24 * 60 * 60_000)
    await prisma.intraoperativeRecord.create({ data: { caseId: staleCase, startedAt: started, timezone: "UTC", techniques: [], syncRevision: 1 } })
    await withLockedCaseTransaction(staleCase, async tx => {
      await addEvent(tx, staleCase, userId, { id: "s1", type: "vital", ts: at(10, started), heartRate: 170 } as never, "test")
      await addEvent(tx, staleCase, userId, { id: "open", type: "complication", ts: at(10, started), label: "Tachycardia", complicationSource: "vitals", triggerReadingId: "s1" } as never, "test")
      await addEvent(tx, staleCase, userId, { id: "s2", type: "vital", ts: at(30, started), heartRate: 168 } as never, "test")
    }, { timeout: 20_000 })
    // Three days on, nobody has touched it.
    const endedAt = await autoEndCaseIfStale(staleCase, new Date(Date.now() + 3 * 24 * 60 * 60_000))
    expect(endedAt?.toISOString()).toBe(at(30, started))
    expect(await latest(staleCase, "open")).toMatchObject({ endTs: at(30, started) })
  }, 30_000)

  it("an episode still open ends with the case when it is finalised, and the export carries the end", async () => {
    const started = new Date(Date.now() - 3 * 60 * 60_000)
    const ended = new Date(started.getTime() + 90 * 60_000)
    await prisma.intraoperativeRecord.create({ data: { caseId: finalCase, startedAt: started, endedAt: ended, timezone: "UTC", techniques: [], syncRevision: 1 } })
    await withLockedCaseTransaction(finalCase, async tx => {
      await addEvent(tx, finalCase, userId, { id: "f1", type: "vital", ts: at(20, started), systolic: 60, diastolic: 30 } as never, "test")
      await addEvent(tx, finalCase, userId, { id: "open", type: "complication", ts: at(20, started), label: "Hypotension", complicationSource: "vitals", triggerReadingId: "f1" } as never, "test")
      // One that opened after the end is left as it is: the case cannot end it.
      await addEvent(tx, finalCase, userId, { id: "late", type: "complication", ts: at(100, started), label: "Bradycardia", complicationSource: "vitals" } as never, "test")
    }, { timeout: 20_000 })
    const outcome = await withLockedCaseTransaction(finalCase, tx => finalizeCaseWithinTransaction(tx, finalCase, userId, {
      currentStatus: "IN_PROGRESS", clinicalMode: "ADULT",
    }), { timeout: 20_000 })
    expect(outcome.ok).toBe(true)
    expect(await latest(finalCase, "open")).toMatchObject({ endTs: ended.toISOString() })
    expect(await latest(finalCase, "late")).not.toHaveProperty("endTs")
    const row = (await complicationRows(finalCase)).find(item => item.eventId === "open")
    expect(row?.endTimestamp?.toISOString()).toBe(ended.toISOString())
  }, 30_000)

  it("ending a case and resuming it ask for no reason; only a change of end does", async () => {
    expect((await patchIntraop(endCase, { endedAt: at(50) })).status).toBe(200)
    expect((await patchIntraop(endCase, { endedAt: null })).status).toBe(200)
    expect((await patchIntraop(endCase, { endedAt: at(55) })).status).toBe(200)
    const corrections = await prisma.auditLog.count({ where: { entityId: endCase, action: "CASE_INTRAOP_END_CORRECTED" } })
    expect(corrections).toBe(0)
    const refused = await patchIntraop(endCase, { endedAt: at(52) })
    expect(refused.status).toBe(400)
    expect(await refused.json()).toMatchObject({ error: "end_correction_reason" })
    expect((await patchIntraop(endCase, { endedAt: at(52), endCorrectionReason: "DEVICE_CLOCK" })).status).toBe(200)
    expect(await prisma.auditLog.count({ where: { entityId: endCase, action: "CASE_INTRAOP_END_CORRECTED" } })).toBe(1)
  }, 30_000)
})
