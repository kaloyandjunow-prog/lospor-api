import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import bcrypt from "bcryptjs"
import { NextRequest } from "next/server"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdateMany: vi.fn(),
  resetUpdateMany: vi.fn(),
  revokeAll: vi.fn(),
  audit: vi.fn(),
  notePasswordChanged: vi.fn(),
  invalidate: vi.fn(),
}))

vi.mock("@/lib/mobile-auth", () => ({
  AUTH_COOKIE_NAME: "lospor_session",
  getAuthUser: mocks.getAuthUser,
}))
vi.mock("@/lib/auth-sessions", () => ({
  revokeAllSessionsInTransaction: mocks.revokeAll,
}))
vi.mock("@/lib/audit", () => ({ logAuditInTransaction: mocks.audit }))
vi.mock("@/lib/password-epoch", () => ({
  notePasswordChanged: mocks.notePasswordChanged,
  invalidateAccountState: mocks.invalidate,
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    $transaction: (run: (transaction: unknown) => unknown) => run({
      user: { updateMany: mocks.userUpdateMany },
      passwordResetToken: { updateMany: mocks.resetUpdateMany },
      auditLog: { create: vi.fn() },
    }),
  },
}))

let currentHash: string

function request(currentPassword: string, newPassword: string) {
  return new NextRequest("https://api.lospor.org/v1/user/change-password", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  })
}

describe("authenticated password change", () => {
  beforeAll(async () => {
    currentHash = await bcrypt.hash("Current1!", 4)
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAuthUser.mockResolvedValue({ id: "user-1", jti: "session-1" })
    mocks.userFindUnique.mockResolvedValue({
      passwordHash: currentHash,
      deletedAt: null,
      suspendedAt: null,
      recoveryRequiredAt: null,
      anonymizedAt: null,
    })
    mocks.userUpdateMany.mockResolvedValue({ count: 1 })
    mocks.resetUpdateMany.mockResolvedValue({ count: 2 })
    mocks.revokeAll.mockResolvedValue(3)
  })

  it("changes the hash, consumes reset tokens, revokes every session, audits, and requires reauthentication", async () => {
    const { POST } = await import("./route")
    const response = await POST(request("Current1!", "Different2!"))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, reauthenticationRequired: true })
    expect(mocks.userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "user-1", passwordHash: currentHash }),
      data: expect.objectContaining({ passwordHash: expect.any(String), passwordChangedAt: expect.any(Date) }),
    }))
    expect(mocks.resetUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "user-1", usedAt: null },
    }))
    expect(mocks.revokeAll).toHaveBeenCalledWith(
      expect.anything(), "user-1", expect.any(Date), "PASSWORD_CHANGE",
    )
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(), "user-1", "PASSWORD_CHANGE", "user-1",
      { revokedSessionCount: 3 },
    )
    expect(mocks.notePasswordChanged).toHaveBeenCalled()
    expect(response.headers.get("set-cookie")?.toLowerCase()).toContain("max-age=0")
  })

  it("changes nothing when the current password is wrong", async () => {
    const { POST } = await import("./route")
    const response = await POST(request("Wrong1!", "Different2!"))
    expect(response.status).toBe(400)
    expect(mocks.userUpdateMany).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it("rejects reuse of the current password", async () => {
    const { POST } = await import("./route")
    const response = await POST(request("Current1!", "Current1!"))
    expect(response.status).toBe(409)
    expect(mocks.userUpdateMany).not.toHaveBeenCalled()
  })

  // HAUD_ROLLBACK:authenticated-password-change
  it("does not prime revocation state when the atomic audit write fails", async () => {
    mocks.audit.mockRejectedValue(new Error("audit unavailable"))
    const { POST } = await import("./route")
    await expect(POST(request("Current1!", "Different2!"))).rejects.toThrow("audit unavailable")
    expect(mocks.notePasswordChanged).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })
})
