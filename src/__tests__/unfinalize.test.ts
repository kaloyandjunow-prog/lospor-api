import { beforeEach, describe, expect, it, vi } from "vitest"
import { FINALIZE_UNDO_WINDOW_MS } from "@/lib/constants"

const getAuthUserMock = vi.fn()
const findUniqueMock  = vi.fn()
const updateMock      = vi.fn()
const logAuditMock    = vi.fn()

vi.mock("next/server", async importOriginal => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: vi.fn() }
})
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: getAuthUserMock }))
vi.mock("@/lib/prisma", () => ({
  prisma: { case: { findUnique: findUniqueMock, update: updateMock } },
}))
vi.mock("@/lib/audit", () => ({ logAudit: logAuditMock }))

function makeRequest(caseId = "case-1") {
  return new Request(`http://localhost/api/cases/${caseId}/unfinalize`, { method: "POST" }) as Parameters<typeof POST>[0]
}

let POST: (req: never, ctx: { params: Promise<{ id: string }> }) => Promise<Response>

describe("POST /api/cases/:id/unfinalize", () => {
  const recentFinalizedAt = new Date(Date.now() - 5 * 60 * 1000) // 5 min ago — within window

  beforeEach(async () => {
    vi.clearAllMocks()
    getAuthUserMock.mockResolvedValue({ id: "user-1", role: "MEMBER", institutionId: "inst-1" })
    findUniqueMock.mockResolvedValue({
      userId: "user-1",
      status: "COMPLETE",
      finalizedAt: recentFinalizedAt,
      user: { institutionId: "inst-1" },
    })
    updateMock.mockResolvedValue({ id: "case-1", status: "IN_PROGRESS" })
    const mod = await import("@/app/v1/cases/[id]/unfinalize/route")
    POST = mod.POST
  })

  it("succeeds within the undo window", async () => {
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(200)
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "IN_PROGRESS", finalizedAt: null }),
    }))
  })

  it("returns 403 after the undo window expires", async () => {
    findUniqueMock.mockResolvedValue({
      userId: "user-1",
      status: "COMPLETE",
      finalizedAt: new Date(Date.now() - FINALIZE_UNDO_WINDOW_MS - 1000),
      user: { institutionId: "inst-1" },
    })
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(403)
    expect(updateMock).not.toHaveBeenCalled()
  })

  it("returns 403 when user does not own the case and is not HOD or ADMIN", async () => {
    findUniqueMock.mockResolvedValue({
      userId: "other-user",
      status: "COMPLETE",
      finalizedAt: recentFinalizedAt,
      user: { institutionId: "inst-1" },
    })
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(403)
    expect(updateMock).not.toHaveBeenCalled()
  })

  it("allows HOD of same institution to unfinalize within window", async () => {
    getAuthUserMock.mockResolvedValue({ id: "hod-1", role: "HEAD_OF_DEPT", institutionId: "inst-1" })
    findUniqueMock.mockResolvedValue({
      userId: "other-user",
      status: "COMPLETE",
      finalizedAt: recentFinalizedAt,
      user: { institutionId: "inst-1" },
    })
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(200)
  })

  it("allows ADMIN to unfinalize within window", async () => {
    getAuthUserMock.mockResolvedValue({ id: "admin-1", role: "ADMIN", institutionId: "inst-2" })
    findUniqueMock.mockResolvedValue({
      userId: "other-user",
      status: "COMPLETE",
      finalizedAt: recentFinalizedAt,
      user: { institutionId: "inst-1" },
    })
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(200)
  })
})
