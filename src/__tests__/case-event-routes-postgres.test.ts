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

// The database refuses writes to a finalised case as well (its own tests
// cover that). Switched off where a test proves the route's own check: with
// it off, only the route can answer 403.
const databaseLayer = vi.hoisted(() => ({ translate: true }))
vi.mock("@/lib/clinical-transaction", async importOriginal => {
  const actual = await importOriginal<typeof import("@/lib/clinical-transaction")>()
  return { ...actual, isCaseFinalizedDatabaseError: (error: unknown) => databaseLayer.translate && actual.isCaseFinalizedDatabaseError(error) }
})

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

/**
 * Editing and deleting one chart entry through the routes (coverage review
 * 9.13.0): the timeline rules apply to an edit as to a new entry, the last
 * change made wins across devices whatever order they arrive in, and a
 * finalised case takes no edits.
 */
describe.skipIf(!runPostgres)("event edit and delete routes, PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let disconnectClinicalPrismaForTests: typeof import("@/lib/clinical-transaction").disconnectClinicalPrismaForTests
  let postEvent: typeof import("@/app/v1/cases/[id]/events/route").POST
  let putEvent: typeof import("@/app/v1/cases/[id]/events/[eventId]/route").PUT
  let deleteEvent: typeof import("@/app/v1/cases/[id]/events/[eventId]/route").DELETE

  const suffix = randomUUID()
  const userId = `event-routes-user-${suffix}`
  const caseId = `event-routes-case-${suffix}`
  const finalCaseId = `event-routes-final-${suffix}`
  const startedAt = new Date(Date.now() - 60 * 60_000)
  const at = (minutes: number) => new Date(startedAt.getTime() + minutes * 60_000).toISOString()
  const madeAt = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()

  // Entries are added as the apps add them: with when they were entered.
  const post = (id: string, event: Record<string, unknown>) => postEvent(
    new Request(`http://localhost/v1/cases/${id}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-lospor-made-at": madeAt(30) },
      body: JSON.stringify(event),
    }) as never,
    { params: Promise.resolve({ id }) },
  )
  const put = (id: string, eventId: string, event: Record<string, unknown>, made?: string) => putEvent(
    new Request(`http://localhost/v1/cases/${id}/events/${eventId}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(made ? { "x-lospor-made-at": made } : {}) },
      body: JSON.stringify(event),
    }) as never,
    { params: Promise.resolve({ id, eventId }) },
  )
  const remove = (id: string, eventId: string, made?: string) => deleteEvent(
    new Request(`http://localhost/v1/cases/${id}/events/${eventId}`, {
      method: "DELETE",
      headers: made ? { "x-lospor-made-at": made } : {},
    }) as never,
    { params: Promise.resolve({ id, eventId }) },
  )
  const active = async (id: string) => prisma.caseEvent.findMany({
    where: { caseId: id, status: "active" },
    select: { logicalId: true, timestamp: true },
    orderBy: { logicalId: "asc" },
  })

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ disconnectClinicalPrismaForTests } = await import("@/lib/clinical-transaction"))
    ;({ POST: postEvent } = await import("@/app/v1/cases/[id]/events/route"))
    ;({ PUT: putEvent, DELETE: deleteEvent } = await import("@/app/v1/cases/[id]/events/[eventId]/route"))
    getAuthUserMock.mockResolvedValue({
      id: userId, role: "MEMBER", institutionId: null, institutionName: null,
      firstName: null, lastName: null, title: null, jti: null,
    })
    await prisma.user.create({
      data: { id: userId, email: `${userId}@example.test`, username: userId, usernameCanonical: userId.toLowerCase(), name: "Event routes test", passwordHash: "not-a-real-password" },
    })
    for (const id of [caseId, finalCaseId]) {
      await prisma.case.create({ data: { id, userId, createdById: userId, status: "IN_PROGRESS" } })
      await prisma.intraoperativeRecord.create({ data: { caseId: id, startedAt, timezone: "UTC", techniques: [], syncRevision: 1 } })
    }
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.$executeRaw`UPDATE "Case" SET "status" = 'IN_PROGRESS' WHERE "id" = ${finalCaseId}`.catch(() => {})
    await prisma.case.deleteMany({ where: { id: { in: [caseId, finalCaseId] } } })
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [caseId, finalCaseId] } } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await disconnectClinicalPrismaForTests()
    await prisma.$disconnect()
  })

  it("an edit applies; an edit that breaks the timeline is refused and changes nothing", async () => {
    expect((await post(caseId, { id: "start", type: "infusion_start", infId: "i1", name: "Propofol", rate: "6", unit: "mg/hr", ts: at(10) })).status).toBe(200)
    expect((await post(caseId, { id: "stop", type: "infusion_stop", infId: "i1", ts: at(40) })).status).toBe(200)

    const moved = await put(caseId, "stop", { type: "infusion_stop", infId: "i1", ts: at(45) }, madeAt(10))
    expect(moved.status).toBe(200)

    const broken = await put(caseId, "stop", { type: "infusion_stop", infId: "i1", ts: at(5) }, madeAt(9))
    expect(broken.status).toBe(400)
    expect(await broken.json()).toMatchObject({ error: "timeline_rule", code: "STOP_BEFORE_START" })
    const stop = (await active(caseId)).find(row => row.logicalId === "stop")
    expect(stop?.timestamp.toISOString()).toBe(at(45))
  }, 30_000)

  it("an edit made before the latest one arrives late and is refused; the newer one stands", async () => {
    const newer = await put(caseId, "stop", { type: "infusion_stop", infId: "i1", ts: at(50) }, madeAt(2))
    expect(newer.status).toBe(200)
    const older = await put(caseId, "stop", { type: "infusion_stop", infId: "i1", ts: at(42) }, madeAt(5))
    expect(older.status).toBe(412)
    expect(await older.json()).toMatchObject({ code: "SUPERSEDED" })
    const stop = (await active(caseId)).find(row => row.logicalId === "stop")
    expect(stop?.timestamp.toISOString()).toBe(at(50))
  }, 30_000)

  it("a deletion made before the latest edit does not undo it; a later one does", async () => {
    expect((await remove(caseId, "stop", madeAt(4))).status).toBe(412)
    expect((await active(caseId)).some(row => row.logicalId === "stop")).toBe(true)
    expect((await remove(caseId, "stop", madeAt(1))).status).toBe(200)
    expect((await active(caseId)).some(row => row.logicalId === "stop")).toBe(false)
  }, 30_000)

  it("an edit made before the deletion cannot bring the entry back", async () => {
    const late = await put(caseId, "stop", { type: "infusion_stop", infId: "i1", ts: at(48) }, madeAt(3))
    expect(late.status).toBe(412)
    expect((await active(caseId)).some(row => row.logicalId === "stop")).toBe(false)
  }, 30_000)

  it("an add sent again after its reply was lost cannot undo a later deletion or edit", async () => {
    const add = (event: Record<string, unknown>, made: string) => postEvent(
      new Request(`http://localhost/v1/cases/${caseId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-lospor-made-at": made },
        body: JSON.stringify(event),
      }) as never,
      { params: Promise.resolve({ id: caseId }) },
    )
    const deleted = { id: "resent-deleted", type: "drug", name: "Ondansetron", dose: "4", unit: "mg", ts: at(15) }
    expect((await add(deleted, madeAt(30))).status).toBe(200)
    // A retry of the very same add is harmless.
    expect((await add(deleted, madeAt(30))).status).toBe(200)
    expect((await remove(caseId, "resent-deleted", madeAt(5))).status).toBe(200)
    const resurrect = await add(deleted, madeAt(30))
    expect(resurrect.status).toBe(412)
    expect(await resurrect.json()).toMatchObject({ code: "SUPERSEDED" })
    expect((await active(caseId)).some(row => row.logicalId === "resent-deleted")).toBe(false)

    const edited = { id: "resent-edited", type: "drug", name: "Fentanyl", dose: "50", unit: "mcg", ts: at(20) }
    expect((await add(edited, madeAt(30))).status).toBe(200)
    expect((await put(caseId, "resent-edited", { ...edited, id: undefined, dose: "100" }, madeAt(5))).status).toBe(200)
    expect((await add(edited, madeAt(30))).status).toBe(412)
    const row = await prisma.caseEvent.findFirst({ where: { caseId, logicalId: "resent-edited", status: "active" }, select: { value: true, metadataJson: true } })
    expect(JSON.stringify(row)).toContain("100")
  }, 30_000)

  it("a finalised case takes no edit and no deletion -- refused by the route itself", async () => {
    expect((await post(finalCaseId, { id: "dose", type: "drug", name: "Ondansetron", dose: "4", unit: "mg", ts: at(20) })).status).toBe(200)
    await prisma.case.update({ where: { id: finalCaseId }, data: { status: "COMPLETE" } })
    databaseLayer.translate = false
    try {
      expect((await put(finalCaseId, "dose", { type: "drug", name: "Ondansetron", dose: "8", unit: "mg", ts: at(20) })).status).toBe(403)
      expect((await remove(finalCaseId, "dose")).status).toBe(403)
    } finally {
      databaseLayer.translate = true
    }
  }, 30_000)
})
