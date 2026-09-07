import { beforeEach, describe, expect, it, vi } from "vitest"

const getAuthUserMock  = vi.fn()
const findUniqueMock   = vi.fn()
const findPostopMock   = vi.fn()
const updateMock       = vi.fn()
const canAccessCaseMock = vi.fn()
const logAuditMock     = vi.fn()

vi.mock("next/server", async importOriginal => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: vi.fn() }
})
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: getAuthUserMock }))
vi.mock("@/lib/clinical-transaction", () => ({
  CaseWriteError: class CaseWriteError extends Error {
    constructor(readonly code: string, readonly status: number, message: string) {
      super(message)
    }
  },
  withLockedCaseTransaction: vi.fn((_caseId: string, operation: (tx: unknown) => Promise<unknown>) =>
    operation({
      case: { findUnique: findUniqueMock, update: updateMock },
      postoperativeRecord: { findUnique: findPostopMock },
    })),
}))
vi.mock("@/lib/access-control", () => ({ canWriteCaseWithOwnerFallback: canAccessCaseMock }))
vi.mock("@/lib/audit", () => ({ logAuditInTransaction: logAuditMock }))

const COMPLETE_POSTOP = {
  aldreteActivity: 2, aldreteRespiration: 2, aldreteCirculation: 2,
  aldreteConsciousness: 2, aldreteSpO2: 2, disposition: "WARD",
}

function makeRequest(caseId = "case-1") {
  return new Request(`http://localhost/api/cases/${caseId}/submit-for-review`, { method: "POST" }) as Parameters<typeof POST>[0]
}

let POST: (req: never, ctx: { params: Promise<{ id: string }> }) => Promise<Response>

describe("POST /api/cases/:id/submit-for-review", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    getAuthUserMock.mockResolvedValue({ id: "user-1", role: "MEMBER", institutionId: "inst-1" })
    canAccessCaseMock.mockResolvedValue(true)
    findUniqueMock.mockResolvedValue({
      userId: "user-1", status: "IN_PROGRESS", institutionId: "inst-1", clinicalMode: "ADULT", awaitingReviewAt: null,
    })
    findPostopMock.mockResolvedValue(COMPLETE_POSTOP)
    updateMock.mockResolvedValue({})
    const mod = await import("@/app/v1/cases/[id]/submit-for-review/route")
    POST = mod.POST
  })

  it("promotes an in-progress case with complete postop to AWAITING_REVIEW", async () => {
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("AWAITING_REVIEW")
    expect(body.awaitingReviewAt).toBeDefined()
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "case-1" },
      data: expect.objectContaining({ status: "AWAITING_REVIEW" }),
    }))
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.anything(), "user-1", "CASE_SUBMITTED_FOR_REVIEW", "case-1",
      expect.objectContaining({ from: "IN_PROGRESS", to: "AWAITING_REVIEW" }),
    )
  })

  // The whole point of this endpoint: the same readiness check finalize()
  // applies, run before the case is allowed into the closure countdown.
  it("refuses an incomplete postop and does not change status", async () => {
    findPostopMock.mockResolvedValue({ aldreteActivity: 2 }) // one of five, no disposition
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.blockers).toBeDefined()
    expect(updateMock).not.toHaveBeenCalled()
  })

  it("refuses a case that has not started intraop (still DRAFT)", async () => {
    findUniqueMock.mockResolvedValue({ userId: "user-1", status: "DRAFT", institutionId: "inst-1", awaitingReviewAt: null })
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(409)
    expect(updateMock).not.toHaveBeenCalled()
  })

  it("refuses an already-finalised case", async () => {
    findUniqueMock.mockResolvedValue({ userId: "user-1", status: "COMPLETE", institutionId: "inst-1", awaitingReviewAt: null })
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(409)
    expect(updateMock).not.toHaveBeenCalled()
  })

  // Revisiting the summary (or a retried request) must not restart the
  // countdown -- the same rule shouldStampAwaitingReview enforces for PATCH.
  it("is idempotent for a case already awaiting review, without re-stamping the timestamp", async () => {
    const existingStamp = new Date("2026-09-01T10:00:00.000Z")
    findUniqueMock.mockResolvedValue({
      userId: "user-1", status: "AWAITING_REVIEW", institutionId: "inst-1", awaitingReviewAt: existingStamp,
    })
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(new Date(body.awaitingReviewAt).getTime()).toBe(existingStamp.getTime())
    expect(updateMock).not.toHaveBeenCalled()
  })

  it("refuses a case this user cannot write to", async () => {
    canAccessCaseMock.mockResolvedValue(false)
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(403)
    expect(updateMock).not.toHaveBeenCalled()
  })

  it("returns 404 for a case that does not exist", async () => {
    findUniqueMock.mockResolvedValue(null)
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "missing" }) })
    expect(res.status).toBe(404)
  })

  it("requires authentication", async () => {
    getAuthUserMock.mockResolvedValue(null)
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(401)
  })
})
