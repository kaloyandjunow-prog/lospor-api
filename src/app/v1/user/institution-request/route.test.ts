import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  userFindUnique: vi.fn(),
  institutionFindUnique: vi.fn(),
  requestFindFirst: vi.fn(),
  requestCreate: vi.fn(),
  userUpdate: vi.fn(),
  transaction: vi.fn(),
  audit: vi.fn(),
  invalidate: vi.fn(),
  lockMembership: vi.fn(),
  releaseLocks: vi.fn(),
}))

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: mocks.getAuthUser }))
vi.mock("@/lib/institutions", () => ({ NO_INSTITUTION_ID: "no-institution" }))
vi.mock("@/lib/audit", () => ({ logAuditInTransaction: mocks.audit }))
vi.mock("@/lib/password-epoch", () => ({ invalidateAccountState: mocks.invalidate }))
vi.mock("@/lib/membership-change", () => ({
  lockMembership: mocks.lockMembership,
  membershipChangeData: (current: { role: string }, institutionId: string) => ({
    institutionId,
    ...(current.role === "HEAD_OF_DEPT" ? { role: "MEMBER" } : {}),
  }),
  isHodDemotion: (current: { role: string }, nextRole?: string) => (
    current.role === "HEAD_OF_DEPT" && nextRole === "MEMBER"
  ),
  releaseUnrelatedHodLocks: mocks.releaseLocks,
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    institution: { findUnique: mocks.institutionFindUnique },
    institutionChangeRequest: { findFirst: mocks.requestFindFirst },
    $transaction: (run: (transaction: unknown) => unknown) => mocks.transaction(run),
  },
}))

function request(institutionId: string) {
  return new NextRequest("https://api.lospor.org/v1/user/institution-request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ institutionId }),
  })
}

describe("institution membership request audit rollback", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAuthUser.mockResolvedValue({ id: "user-1", role: "MEMBER" })
    mocks.userFindUnique.mockResolvedValue({ institutionId: "institution-1" })
    mocks.requestFindFirst.mockResolvedValue(null)
    mocks.requestCreate.mockResolvedValue({
      id: "request-1",
      userId: "user-1",
      requestedInstitutionId: "institution-2",
      previousInstitutionId: "institution-1",
    })
    mocks.userUpdate.mockResolvedValue({})
    mocks.lockMembership.mockResolvedValue({
      id: "user-1",
      role: "MEMBER",
      institutionId: "institution-1",
    })
    mocks.audit.mockRejectedValue(new Error("audit unavailable"))
    mocks.transaction.mockImplementation((run: (transaction: unknown) => unknown) => run({
      institutionChangeRequest: { create: mocks.requestCreate },
      user: { update: mocks.userUpdate },
      auditLog: { create: vi.fn() },
    }))
  })

  // HAUD_ROLLBACK:institution-request-and-self-leave
  it("does not report a move request when its durable audit row fails", async () => {
    mocks.institutionFindUnique.mockResolvedValue({
      id: "institution-2",
      name: "Hospital Two",
      city: "Sofia",
    })

    const { POST } = await import("./route")
    await expect(POST(request("institution-2"))).rejects.toThrow("audit unavailable")
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it("does not publish a self-leave transition when its audit row fails", async () => {
    mocks.institutionFindUnique.mockResolvedValue({
      id: "no-institution",
      name: "No institution",
      city: null,
    })

    const { POST } = await import("./route")
    await expect(POST(request("no-institution"))).rejects.toThrow("audit unavailable")
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })
})
