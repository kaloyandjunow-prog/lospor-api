import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  userCount: vi.fn(),
  userUpdateMany: vi.fn(),
  resetUpdateMany: vi.fn(),
  revokeAll: vi.fn(),
  audit: vi.fn(),
  note: vi.fn(),
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
  notePasswordChanged: mocks.note,
  invalidateAccountState: mocks.invalidate,
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (run: (transaction: unknown) => unknown) => run({
      user: {
        count: mocks.userCount,
        updateMany: mocks.userUpdateMany,
      },
      passwordResetToken: { updateMany: mocks.resetUpdateMany },
      auditLog: { create: vi.fn() },
    }),
  },
}))

describe("self-service account deletion audit rollback", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAuthUser.mockResolvedValue({
      id: "user-1",
      role: "MEMBER",
      accountKind: "CLINICAL",
    })
    mocks.userUpdateMany.mockResolvedValue({ count: 1 })
    mocks.resetUpdateMany.mockResolvedValue({ count: 1 })
    mocks.revokeAll.mockResolvedValue(2)
  })

  // HAUD_ROLLBACK:account-delete-restore
  it("does not publish deletion or revoke the caller response when audit persistence fails", async () => {
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"))

    const { POST } = await import("./route")
    await expect(POST(new NextRequest("https://api.lospor.org/v1/user/delete", {
      method: "POST",
    }))).rejects.toThrow("audit unavailable")
    expect(mocks.note).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })
})
