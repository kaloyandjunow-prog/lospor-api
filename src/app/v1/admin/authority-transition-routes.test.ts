import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  institutionRequestScope: vi.fn(),
  transaction: vi.fn(),
  institutionFindFirst: vi.fn(),
  institutionUpdateMany: vi.fn(),
  roleFindUnique: vi.fn(),
  roleFindUniqueOrThrow: vi.fn(),
  roleUpdateMany: vi.fn(),
  userUpdate: vi.fn(),
  lockMembership: vi.fn(),
  releaseLocks: vi.fn(),
  revokeAll: vi.fn(),
  audit: vi.fn(),
  note: vi.fn(),
  invalidate: vi.fn(),
}))

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: mocks.getAuthUser }))
vi.mock("@/lib/institution-requests", () => ({
  institutionRequestScope: mocks.institutionRequestScope,
}))
vi.mock("@/lib/institutions", () => ({ canHaveHeadOfDepartment: () => true }))
vi.mock("@/lib/membership-change", () => ({
  lockMembership: mocks.lockMembership,
  membershipChangeData: (
    current: { role: string; institutionId: string | null },
    institutionId: string,
  ) => ({
    institutionId,
    ...(current.role === "HEAD_OF_DEPT" && current.institutionId !== institutionId
      ? { role: "MEMBER" }
      : {}),
  }),
  isHodDemotion: (current: { role: string }, nextRole?: string) => (
    current.role === "HEAD_OF_DEPT" && nextRole === "MEMBER"
  ),
  releaseUnrelatedHodLocks: mocks.releaseLocks,
}))
vi.mock("@/lib/auth-sessions", () => ({
  revokeAllSessionsInTransaction: mocks.revokeAll,
}))
vi.mock("@/lib/audit", () => ({ logAuditInTransaction: mocks.audit }))
vi.mock("@/lib/password-epoch", () => ({
  notePasswordChanged: mocks.note,
  invalidateAccountState: mocks.invalidate,
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (run: (transaction: unknown) => unknown) => mocks.transaction(run),
  },
}))

function tx() {
  return {
    institutionChangeRequest: {
      findFirst: mocks.institutionFindFirst,
      updateMany: mocks.institutionUpdateMany,
    },
    roleRequest: {
      findUnique: mocks.roleFindUnique,
      findUniqueOrThrow: mocks.roleFindUniqueOrThrow,
      updateMany: mocks.roleUpdateMany,
    },
    user: { update: mocks.userUpdate },
    auditLog: { create: vi.fn() },
  }
}

const activeMember = {
  id: "target-1",
  role: "MEMBER",
  accountKind: "CLINICAL",
  institutionId: "institution-1",
  activatedAt: new Date("2026-08-20T10:00:00Z"),
  emailVerifiedAt: new Date("2026-08-20T10:00:00Z"),
  suspendedAt: null,
  recoveryRequiredAt: null,
  deletedAt: null,
  anonymizedAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getAuthUser.mockResolvedValue({ id: "admin-1", role: "ADMIN" })
  mocks.institutionRequestScope.mockReturnValue({ requestedInstitutionId: "institution-2" })
  mocks.transaction.mockImplementation((run: (transaction: unknown) => unknown) => run(tx()))
  mocks.lockMembership.mockResolvedValue(activeMember)
  mocks.userUpdate.mockResolvedValue({})
  mocks.revokeAll.mockResolvedValue(3)
  mocks.audit.mockResolvedValue(undefined)
})

describe("approved role transitions", () => {
  it("revokes old sessions before an HOD promotion can take effect", async () => {
    mocks.roleFindUnique.mockResolvedValue({
      id: "request-1",
      userId: "target-1",
      status: "PENDING",
    })
    mocks.roleUpdateMany.mockResolvedValue({ count: 1 })
    mocks.roleFindUniqueOrThrow.mockResolvedValue({
      id: "request-1",
      userId: "target-1",
      status: "APPROVED",
    })
    const { PATCH } = await import("./role-requests/[id]/route")
    const response = await PATCH(new NextRequest(
      "https://api.lospor.org/v1/admin/role-requests/request-1",
      { method: "PATCH", body: JSON.stringify({ action: "approve" }) },
    ), { params: Promise.resolve({ id: "request-1" }) })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: "APPROVED",
      targetReauthenticationRequired: true,
    })
    expect(mocks.userUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { role: "HEAD_OF_DEPT", passwordChangedAt: expect.any(Date) },
    }))
    expect(mocks.revokeAll).toHaveBeenCalledWith(
      expect.anything(), "target-1", expect.any(Date), "HOD_ROLE_APPROVED",
    )
    expect(mocks.note).toHaveBeenCalledWith("target-1", expect.any(Date))
    expect(mocks.invalidate).toHaveBeenCalledWith("target-1")
  })

  // HAUD_ROLLBACK:role-request-resolution
  it("does not publish a role transition when its durable audit row fails", async () => {
    mocks.roleFindUnique.mockResolvedValue({
      id: "request-1",
      userId: "target-1",
      status: "PENDING",
    })
    mocks.roleUpdateMany.mockResolvedValue({ count: 1 })
    mocks.audit.mockRejectedValue(new Error("audit unavailable"))

    const { PATCH } = await import("./role-requests/[id]/route")
    await expect(PATCH(new NextRequest(
      "https://api.lospor.org/v1/admin/role-requests/request-1",
      { method: "PATCH", body: JSON.stringify({ action: "approve" }) },
    ), { params: Promise.resolve({ id: "request-1" }) })).rejects.toThrow("audit unavailable")
    expect(mocks.note).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it("does not report role-request rejection when its durable audit row fails", async () => {
    mocks.roleFindUnique.mockResolvedValue({
      id: "request-1",
      userId: "target-1",
      status: "PENDING",
    })
    mocks.roleUpdateMany.mockResolvedValue({ count: 1 })
    mocks.audit.mockRejectedValue(new Error("audit unavailable"))

    const { PATCH } = await import("./role-requests/[id]/route")
    await expect(PATCH(new NextRequest(
      "https://api.lospor.org/v1/admin/role-requests/request-1",
      { method: "PATCH", body: JSON.stringify({ action: "reject" }) },
    ), { params: Promise.resolve({ id: "request-1" }) })).rejects.toThrow("audit unavailable")
    expect(mocks.note).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })
})

describe("approved institution transitions", () => {
  it("demotes an HOD without changing case ownership and revokes old authority sessions", async () => {
    mocks.lockMembership.mockResolvedValue({ ...activeMember, role: "HEAD_OF_DEPT" })
    mocks.institutionFindFirst.mockResolvedValue({
      id: "request-2",
      userId: "target-1",
      status: "PENDING",
      requestedInstitutionId: "institution-2",
      previousInstitutionId: "institution-1",
    })
    mocks.institutionUpdateMany.mockResolvedValue({ count: 1 })
    const { POST } = await import("./institution-requests/[id]/route")
    const response = await POST(new NextRequest(
      "https://api.lospor.org/v1/admin/institution-requests/request-2",
      { method: "POST", body: JSON.stringify({ decision: "APPROVE" }) },
    ), { params: Promise.resolve({ id: "request-2" }) })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: "APPROVED",
      targetReauthenticationRequired: true,
    })
    expect(mocks.releaseLocks).toHaveBeenCalledWith(expect.anything(), "target-1")
    expect(mocks.userUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        institutionId: "institution-2",
        role: "MEMBER",
        passwordChangedAt: expect.any(Date),
      },
    }))
    expect(mocks.revokeAll).toHaveBeenCalledWith(
      expect.anything(), "target-1", expect.any(Date), "INSTITUTION_CHANGE_APPROVED",
    )
    expect(mocks.note).toHaveBeenCalledWith("target-1", expect.any(Date))
    expect(mocks.invalidate).toHaveBeenCalledWith("target-1")
  })

  // HAUD_ROLLBACK:institution-request-resolution
  it("does not publish an institution transition when its audit row fails", async () => {
    mocks.institutionFindFirst.mockResolvedValue({
      id: "request-2",
      userId: "target-1",
      status: "PENDING",
      requestedInstitutionId: "institution-2",
      previousInstitutionId: "institution-1",
    })
    mocks.institutionUpdateMany.mockResolvedValue({ count: 1 })
    mocks.audit.mockRejectedValue(new Error("audit unavailable"))

    const { POST } = await import("./institution-requests/[id]/route")
    const response = await POST(new NextRequest(
      "https://api.lospor.org/v1/admin/institution-requests/request-2",
      { method: "POST", body: JSON.stringify({ decision: "APPROVE" }) },
    ), { params: Promise.resolve({ id: "request-2" }) })

    expect(response.status).toBe(500)
    expect(mocks.note).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it("does not report institution-request rejection when its audit row fails", async () => {
    mocks.institutionFindFirst.mockResolvedValue({
      id: "request-2",
      userId: "target-1",
      status: "PENDING",
      requestedInstitutionId: "institution-2",
      previousInstitutionId: "institution-1",
    })
    mocks.institutionUpdateMany.mockResolvedValue({ count: 1 })
    mocks.audit.mockRejectedValue(new Error("audit unavailable"))

    const { POST } = await import("./institution-requests/[id]/route")
    const response = await POST(new NextRequest(
      "https://api.lospor.org/v1/admin/institution-requests/request-2",
      { method: "POST", body: JSON.stringify({ decision: "REJECT" }) },
    ), { params: Promise.resolve({ id: "request-2" }) })

    expect(response.status).toBe(500)
    expect(mocks.note).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })
})
