import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { config as loadDotenv } from "dotenv"

const { getAuthUserMock } = vi.hoisted(() => ({ getAuthUserMock: vi.fn() }))

vi.mock("server-only", () => ({}))
vi.mock("next/server", async importOriginal => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: vi.fn() }
})
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: getAuthUserMock }))

const runPostgres = process.env.LOSPOR_POSTGRES_INTEGRATION === "true"
if (runPostgres && !process.env.DATABASE_URL) loadDotenv({ quiet: true })

/**
 * A cancelled procedure (10.0.0), through its route: cancelled with a reason
 * until anaesthesia starts, by those who can edit the case; closed to editing
 * while cancelled; undone back to the status it had; each step audited.
 */
describe.skipIf(!runPostgres)("cancelling a procedure, PostgreSQL", () => {
  let prisma: typeof import("@/lib/prisma").prisma
  let disconnectClinicalPrismaForTests: typeof import("@/lib/clinical-transaction").disconnectClinicalPrismaForTests
  let cancel: typeof import("@/app/v1/cases/[id]/cancel/route").POST
  let undo: typeof import("@/app/v1/cases/[id]/cancel/route").DELETE
  let patchCase: typeof import("@/app/v1/cases/[id]/route").PATCH

  const suffix = randomUUID()
  const ownerId = `cancel-owner-${suffix}`
  const strangerId = `cancel-stranger-${suffix}`
  const caseId = `cancel-case-${suffix}`
  const startedId = `cancel-started-${suffix}`
  const asUser = (id: string) => getAuthUserMock.mockResolvedValue({
    id, role: "MEMBER", institutionId: null, institutionName: null, firstName: null, lastName: null, title: null, jti: null,
  })
  type Handler = (request: never, context: { params: Promise<{ id: string }> }) => Promise<Response>
  const call = async (handler: Handler, id: string, body?: unknown) => {
    const response = await handler(new Request(`http://localhost/v1/cases/${id}/cancel`, {
      method: body === undefined ? "DELETE" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }) as never, { params: Promise.resolve({ id }) })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const stored = (id = caseId) => prisma.case.findUniqueOrThrow({
    where: { id },
    select: { status: true, statusBeforeCancel: true, cancelledAt: true, cancelledById: true, cancellationReason: true, cancellationNote: true },
  })
  const audits = () => prisma.auditLog.findMany({ where: { entityId: caseId }, orderBy: { createdAt: "asc" }, select: { action: true, userId: true, detail: true } })

  beforeAll(async () => {
    ;({ prisma } = await import("@/lib/prisma"))
    ;({ disconnectClinicalPrismaForTests } = await import("@/lib/clinical-transaction"))
    ;({ POST: cancel, DELETE: undo } = await import("@/app/v1/cases/[id]/cancel/route"))
    ;({ PATCH: patchCase } = await import("@/app/v1/cases/[id]/route"))
    for (const id of [ownerId, strangerId]) {
      await prisma.user.create({ data: { id, email: `${id}@example.test`, username: id, usernameCanonical: id.toLowerCase(), name: "Cancel test", passwordHash: "not-a-real-password" } })
    }
    await prisma.case.create({ data: { id: caseId, userId: ownerId, createdById: ownerId, status: "IN_PROGRESS" } })
    await prisma.case.create({ data: { id: startedId, userId: ownerId, createdById: ownerId, status: "IN_PROGRESS" } })
    await prisma.intraoperativeRecord.create({ data: { caseId: startedId, startedAt: new Date(), timezone: "UTC", techniques: [], keyEvents: {}, syncRevision: 1 } })
  })

  afterAll(async () => {
    if (!prisma) return
    await prisma.case.deleteMany({ where: { id: { in: [caseId, startedId] } } })
    await prisma.auditLog.deleteMany({ where: { entityId: { in: [caseId, startedId] } } })
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } })
    await disconnectClinicalPrismaForTests()
    await prisma.$disconnect()
  })

  it("needs a known reason, and a note for Other", async () => {
    asUser(ownerId)
    expect(await call(cancel, caseId, { reason: "BECAUSE" })).toMatchObject({ status: 400, body: { code: "CANCELLATION_REASON_REQUIRED" } })
    expect(await call(cancel, caseId, {})).toMatchObject({ status: 400, body: { code: "CANCELLATION_REASON_REQUIRED" } })
    expect(await call(cancel, caseId, { reason: "OTHER", note: "   " })).toMatchObject({ status: 400, body: { code: "CANCELLATION_NOTE_REQUIRED" } })
    expect(await call(cancel, caseId, { reason: "PATIENT_CONDITION", extra: 1 })).toMatchObject({ status: 400 })
    expect((await stored()).status).toBe("IN_PROGRESS")
  })

  it("is not open to someone who cannot edit the case", async () => {
    asUser(strangerId)
    expect(await call(cancel, caseId, { reason: "PATIENT_CONDITION" })).toMatchObject({ status: 404, body: { code: "CASE_NOT_FOUND" } })
    expect((await stored()).status).toBe("IN_PROGRESS")
  })

  it("is refused once anaesthesia has started", async () => {
    asUser(ownerId)
    expect(await call(cancel, startedId, { reason: "PATIENT_CONDITION" })).toMatchObject({ status: 409, body: { code: "CANCELLATION_TOO_LATE" } })
    expect((await stored(startedId)).status).toBe("IN_PROGRESS")
  })

  it("closes the case with its reason and note, keeping the status it had, and audits it", async () => {
    asUser(ownerId)
    const response = await call(cancel, caseId, { reason: "OTHER", note: "  Surgeon unwell  " })
    expect(response).toMatchObject({ status: 200, body: { status: "CANCELLED", cancellationReason: "OTHER" } })
    expect(await stored()).toMatchObject({
      status: "CANCELLED", statusBeforeCancel: "IN_PROGRESS", cancelledById: ownerId, cancellationReason: "OTHER", cancellationNote: "Surgeon unwell",
    })
    expect((await stored()).cancelledAt).toBeInstanceOf(Date)
    expect(await audits()).toEqual([expect.objectContaining({ action: "CASE_CANCEL", userId: ownerId, detail: { reason: "OTHER", from: "IN_PROGRESS" } })])
  })

  it("cannot be cancelled twice, and refuses edits while cancelled", async () => {
    asUser(ownerId)
    expect(await call(cancel, caseId, { reason: "PATIENT_CONDITION" })).toMatchObject({ status: 409, body: { code: "CASE_ALREADY_CANCELLED" } })
    const edit = await patchCase(new Request(`http://localhost/v1/cases/${caseId}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ preop: { weightKg: 81 } }),
    }) as never, { params: Promise.resolve({ id: caseId }) })
    expect(edit.status).toBe(409)
    expect(await edit.json()).toMatchObject({ code: "CASE_CANCELLED" })
    expect(await prisma.preoperativeAssessment.findUnique({ where: { caseId } })).toBeNull()
  })

  it("is undone back to the status it had, clearing the cancellation, and audits that too", async () => {
    asUser(strangerId)
    expect(await call(undo, caseId)).toMatchObject({ status: 404 })
    asUser(ownerId)
    expect(await call(undo, caseId)).toMatchObject({ status: 200, body: { status: "IN_PROGRESS" } })
    expect(await stored()).toEqual({
      status: "IN_PROGRESS", statusBeforeCancel: null, cancelledAt: null, cancelledById: null, cancellationReason: null, cancellationNote: null,
    })
    expect((await audits()).map(entry => entry.action)).toEqual(["CASE_CANCEL", "CASE_CANCEL_UNDO"])
    expect((await audits())[1].detail).toEqual({ reason: "OTHER", to: "IN_PROGRESS" })
    expect(await call(undo, caseId)).toMatchObject({ status: 409, body: { code: "CASE_NOT_CANCELLED" } })
  })
})
