import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  verifyCurrentPassword: vi.fn(),
  userFindUnique: vi.fn(),
  userCount: vi.fn(),
  userUpdateMany: vi.fn(),
  releaseLocks: vi.fn(),
  revokeAll: vi.fn(),
  audit: vi.fn(),
  note: vi.fn(),
  invalidate: vi.fn(),
}))

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: mocks.getAuthUser }))
vi.mock("@/lib/credentials", () => ({ verifyCurrentPassword: mocks.verifyCurrentPassword }))
vi.mock("@/lib/membership-change", () => ({ releaseUnrelatedHodLocks: mocks.releaseLocks }))
vi.mock("@/lib/auth-sessions", () => ({ revokeAllSessionsInTransaction: mocks.revokeAll }))
vi.mock("@/lib/audit", () => ({ logAuditInTransaction: mocks.audit }))
vi.mock("@/lib/password-epoch", () => ({
  notePasswordChanged: mocks.note,
  invalidateAccountState: mocks.invalidate,
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (run: (transaction: unknown) => unknown) => run({
      user: {
        findUnique: mocks.userFindUnique,
        count: mocks.userCount,
        updateMany: mocks.userUpdateMany,
      },
      auditLog: { create: vi.fn() },
    }),
  },
}))

const context = { params: Promise.resolve({ id: "target-1" }) }
const originalDeploymentMode = process.env.LOSPOR_DEPLOYMENT_MODE
const originalAccountAdministration = process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED

afterAll(() => {
  if (originalDeploymentMode === undefined) delete process.env.LOSPOR_DEPLOYMENT_MODE
  else process.env.LOSPOR_DEPLOYMENT_MODE = originalDeploymentMode
  if (originalAccountAdministration === undefined) delete process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED
  else process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED = originalAccountAdministration
})

function request(body: Record<string, unknown>) {
  return new NextRequest("https://api.lospor.org/v1/admin/users/target-1/authority", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currentPassword: "Admin1!", reason: "Succession planning", ...body }),
  })
}

function target(overrides: Record<string, unknown> = {}) {
  return {
    id: "target-1",
    role: "MEMBER",
    accountKind: "CLINICAL",
    institutionId: "institution-1",
    activatedAt: new Date(),
    emailVerifiedAt: new Date(),
    suspendedAt: null,
    recoveryRequiredAt: null,
    deletedAt: null,
    anonymizedAt: null,
    ...overrides,
  }
}

describe("administrator authority succession", () => {
  beforeEach(() => {
    process.env.LOSPOR_DEPLOYMENT_MODE = "hospital"
    process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED = "true"
    vi.clearAllMocks()
    mocks.getAuthUser.mockResolvedValue({ id: "admin-1", role: "ADMIN" })
    mocks.verifyCurrentPassword.mockResolvedValue(true)
    mocks.userFindUnique.mockResolvedValue(target())
    mocks.userCount.mockResolvedValue(2)
    mocks.userUpdateMany.mockResolvedValue({ count: 1 })
    mocks.revokeAll.mockResolvedValue(1)
  })

  it("promotes an active clinical account with password re-entry, reason, audit, and forced reauthentication", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ role: "ADMIN" }), context)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      id: "target-1",
      role: "ADMIN",
      accountKind: "CLINICAL",
      reauthenticationRequired: true,
    })
    expect(mocks.userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ role: "ADMIN", passwordChangedAt: expect.any(Date) }),
    }))
    expect(mocks.revokeAll).toHaveBeenCalledWith(
      expect.anything(), "target-1", expect.any(Date), "ADMIN_AUTHORITY_CHANGE",
    )
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(), "admin-1", "ADMIN_ACCOUNT_PROMOTE", "target-1",
      expect.objectContaining({ reason: "Succession planning" }),
    )
  })

  // HAUD_ROLLBACK:administrator-authority-change
  it("does not publish administrator authority when its audit row fails", async () => {
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"))

    const { POST } = await import("./route")
    await expect(POST(request({ role: "ADMIN" }), context)).rejects.toThrow("audit unavailable")
    expect(mocks.note).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it("rejects the operation before mutation when actor password re-entry fails", async () => {
    mocks.verifyCurrentPassword.mockResolvedValue(false)
    const { POST } = await import("./route")
    const response = await POST(request({ role: "ADMIN" }), context)
    expect(response.status).toBe(401)
    expect(mocks.userFindUnique).not.toHaveBeenCalled()
    expect(mocks.userUpdateMany).not.toHaveBeenCalled()
  })

  it("serializably protects the last active clinical administrator from demotion", async () => {
    mocks.userFindUnique.mockResolvedValue(target({ role: "ADMIN" }))
    mocks.userCount.mockResolvedValue(1)
    const { POST } = await import("./route")
    const response = await POST(request({ role: "MEMBER" }), context)
    expect(response.status).toBe(409)
    expect(mocks.userUpdateMany).not.toHaveBeenCalled()
  })

  it("does not combine broad ADMIN gates with a research-only account", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ role: "ADMIN", accountKind: "RESEARCH_ONLY" }), context)
    expect(response.status).toBe(409)
    expect(mocks.userUpdateMany).not.toHaveBeenCalled()
  })

  it("changes a non-admin account kind only through password-and-reason step-up", async () => {
    const { POST } = await import("./route")
    const response = await POST(request({ accountKind: "RESEARCH_ONLY" }), context)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      id: "target-1",
      role: "MEMBER",
      accountKind: "RESEARCH_ONLY",
      reauthenticationRequired: true,
    })
    expect(mocks.verifyCurrentPassword).toHaveBeenCalledWith("admin-1", "Admin1!")
    expect(mocks.revokeAll).toHaveBeenCalledWith(
      expect.anything(), "target-1", expect.any(Date), "ADMIN_AUTHORITY_CHANGE",
    )
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(), "admin-1", "ADMIN_ACCOUNT_AUTHORITY_CHANGE", "target-1",
      expect.objectContaining({
        previousAccountKind: "CLINICAL",
        accountKind: "RESEARCH_ONLY",
        reason: "Succession planning",
      }),
    )
  })

  it("will not promote invited, suspended, deleted, or recovery-required accounts", async () => {
    const { POST } = await import("./route")
    for (const inactive of [
      { activatedAt: null },
      { suspendedAt: new Date() },
      { deletedAt: new Date() },
      { recoveryRequiredAt: new Date() },
    ]) {
      mocks.userFindUnique.mockResolvedValueOnce(target(inactive))
      const response = await POST(request({ role: "ADMIN" }), context)
      expect(response.status).toBe(409)
    }
    expect(mocks.userUpdateMany).not.toHaveBeenCalled()
  })
})
