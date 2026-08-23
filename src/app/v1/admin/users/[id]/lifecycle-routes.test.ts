import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  userFindUnique: vi.fn(),
  userCount: vi.fn(),
  userUpdateMany: vi.fn(),
  resetUpdateMany: vi.fn(),
  revokeAll: vi.fn(),
  audit: vi.fn(),
  note: vi.fn(),
  invalidate: vi.fn(),
}))

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: mocks.getAuthUser }))
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
      passwordResetToken: { updateMany: mocks.resetUpdateMany },
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

function request(path: string, reason = "Routine offboarding") {
  return new NextRequest(`https://api.lospor.org${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  })
}

function activeTarget(overrides: Record<string, unknown> = {}) {
  return {
    id: "target-1",
    role: "MEMBER",
    accountKind: "CLINICAL",
    activatedAt: new Date("2026-01-01T00:00:00Z"),
    emailVerifiedAt: new Date("2026-01-01T00:00:00Z"),
    suspendedAt: null,
    recoveryRequiredAt: null,
    deletedAt: null,
    anonymizedAt: null,
    ...overrides,
  }
}

describe("administrator account lifecycle", () => {
  beforeEach(() => {
    process.env.LOSPOR_DEPLOYMENT_MODE = "hospital"
    process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED = "true"
    vi.clearAllMocks()
    mocks.getAuthUser.mockResolvedValue({ id: "admin-1", role: "ADMIN" })
    mocks.userFindUnique.mockResolvedValue(activeTarget())
    mocks.userCount.mockResolvedValue(2)
    mocks.userUpdateMany.mockResolvedValue({ count: 1 })
    mocks.resetUpdateMany.mockResolvedValue({ count: 1 })
    mocks.revokeAll.mockResolvedValue(2)
    mocks.audit.mockResolvedValue(undefined)
  })

  it("is absent from the public serverless deployment", async () => {
    delete process.env.LOSPOR_DEPLOYMENT_MODE
    const { POST } = await import("./suspend/route")
    const response = await POST(request("/v1/admin/users/target-1/suspend"), context)
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      code: "ACCOUNT_ADMINISTRATION_DISABLED_BY_DEPLOYMENT",
    })
    expect(mocks.getAuthUser).not.toHaveBeenCalled()
    expect(mocks.userUpdateMany).not.toHaveBeenCalled()
  })

  it("suspends and revokes access in the same audited transaction", async () => {
    const { POST } = await import("./suspend/route")
    const response = await POST(request("/v1/admin/users/target-1/suspend"), context)
    expect(response.status).toBe(200)
    expect(mocks.userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ suspendedAt: expect.any(Date), passwordChangedAt: expect.any(Date) }),
    }))
    expect(mocks.revokeAll).toHaveBeenCalledWith(
      expect.anything(), "target-1", expect.any(Date), "ACCOUNT_SUSPENDED",
    )
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(), "admin-1", "ADMIN_ACCOUNT_SUSPEND", "target-1",
      expect.objectContaining({ reason: "Routine offboarding", revokedSessionCount: 2 }),
    )
  })

  it("protects the last active clinical administrator from suspension", async () => {
    mocks.userFindUnique.mockResolvedValue(activeTarget({ role: "ADMIN" }))
    mocks.userCount.mockResolvedValue(1)
    const { POST } = await import("./suspend/route")
    const response = await POST(request("/v1/admin/users/target-1/suspend"), context)
    expect(response.status).toBe(409)
    expect(mocks.userUpdateMany).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  // HAUD_ROLLBACK:administrator-suspend-reactivate
  it("does not publish cache state when suspension audit fails", async () => {
    mocks.audit.mockRejectedValue(new Error("audit unavailable"))
    const { POST } = await import("./suspend/route")
    await expect(POST(request("/v1/admin/users/target-1/suspend"), context)).rejects.toThrow("audit unavailable")
    expect(mocks.note).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it("reactivates a suspended account without reviving any old session", async () => {
    mocks.userFindUnique.mockResolvedValue({
      suspendedAt: new Date("2026-08-20T00:00:00Z"),
      deletedAt: null,
      anonymizedAt: null,
    })
    const { POST } = await import("./reactivate/route")
    const response = await POST(request("/v1/admin/users/target-1/reactivate"), context)
    expect(response.status).toBe(200)
    expect(mocks.userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { suspendedAt: null } }))
    expect(mocks.invalidate).toHaveBeenCalledWith("target-1")
  })

  it("does not publish reactivation when its durable audit row fails", async () => {
    mocks.userFindUnique.mockResolvedValue({
      suspendedAt: new Date("2026-08-20T00:00:00Z"),
      deletedAt: null,
      anonymizedAt: null,
    })
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"))

    const { POST } = await import("./reactivate/route")
    await expect(POST(request("/v1/admin/users/target-1/reactivate"), context))
      .rejects.toThrow("audit unavailable")
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it("restores only inside the 30-day window and requires fresh recovery", async () => {
    mocks.userFindUnique.mockResolvedValue({
      deletedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      anonymizedAt: null,
    })
    const { POST } = await import("./restore/route")
    const response = await POST(request("/v1/admin/users/target-1/restore"), context)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: "RECOVERY_REQUIRED" })
    expect(mocks.userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        deletedAt: null,
        suspendedAt: null,
        recoveryRequiredAt: expect.any(Date),
        passwordChangedAt: expect.any(Date),
      }),
    }))
  })

  it("does not publish restored credentials when its durable audit row fails", async () => {
    mocks.userFindUnique.mockResolvedValue({
      deletedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      anonymizedAt: null,
    })
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"))

    const { POST } = await import("./restore/route")
    await expect(POST(request("/v1/admin/users/target-1/restore"), context))
      .rejects.toThrow("audit unavailable")
    expect(mocks.note).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it("refuses restoration after the retention window or anonymization", async () => {
    const { POST } = await import("./restore/route")
    mocks.userFindUnique.mockResolvedValue({
      deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      anonymizedAt: null,
    })
    expect((await POST(request("/v1/admin/users/target-1/restore"), context)).status).toBe(409)
    mocks.userFindUnique.mockResolvedValue({
      deletedAt: new Date(),
      anonymizedAt: new Date(),
    })
    expect((await POST(request("/v1/admin/users/target-1/restore"), context)).status).toBe(409)
    expect(mocks.userUpdateMany).not.toHaveBeenCalled()
  })
})
