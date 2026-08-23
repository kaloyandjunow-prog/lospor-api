import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  findMany: vi.fn(),
  updateMany: vi.fn(),
  revokeAll: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: mocks.getAuthUser }))
vi.mock("@/lib/auth-sessions", () => ({ revokeAllSessionsInTransaction: mocks.revokeAll }))
vi.mock("@/lib/audit", () => ({ logAuditInTransaction: mocks.audit }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    authSession: { findMany: mocks.findMany },
    $transaction: (run: (transaction: unknown) => unknown) => run({
      authSession: { updateMany: mocks.updateMany },
      auditLog: { create: vi.fn() },
    }),
  },
}))

const now = new Date("2026-08-22T12:00:00Z")

describe("self-service session inventory and revocation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAuthUser.mockResolvedValue({ id: "user-1", jti: "current-jti" })
    mocks.findMany.mockResolvedValue([
      {
        jti: "current-jti",
        clientType: "WEB",
        deviceLabel: "Firefox",
        issuedAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      },
      {
        jti: "other-jti",
        clientType: "PWA",
        deviceLabel: "Phone",
        issuedAt: now,
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      },
    ])
    mocks.revokeAll.mockResolvedValue(1)
    mocks.updateMany.mockResolvedValue({ count: 1 })
  })

  it("lists only active sessions and marks the current one", async () => {
    const { GET } = await import("./route")
    const response = await GET(new NextRequest("https://api.lospor.org/v1/user/sessions"))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      sessions: [
        { id: "current-jti", clientType: "WEB", current: true },
        { id: "other-jti", clientType: "PWA", current: false },
      ],
    })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: "user-1", revokedAt: null }),
    }))
  })

  it("revokes all other sessions and records only the count in audit", async () => {
    const { DELETE } = await import("./route")
    const response = await DELETE(new NextRequest("https://api.lospor.org/v1/user/sessions", { method: "DELETE" }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, revokedCount: 1 })
    expect(mocks.revokeAll).toHaveBeenCalledWith(
      expect.anything(), "user-1", expect.any(Date), "USER_REVOKE_OTHER_SESSIONS", "current-jti",
    )
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(), "user-1", "SESSION_REVOKE_OTHERS", "user-1", { revokedCount: 1 },
    )
  })

  // HAUD_ROLLBACK:session-revocation
  it("does not report bulk revocation when its durable audit row fails", async () => {
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"))
    const { DELETE } = await import("./route")

    await expect(DELETE(new NextRequest(
      "https://api.lospor.org/v1/user/sessions",
      { method: "DELETE" },
    ))).rejects.toThrow("audit unavailable")
  })

  it("selectively revokes only a session owned by the caller", async () => {
    const { DELETE } = await import("./[id]/route")
    const response = await DELETE(
      new NextRequest("https://api.lospor.org/v1/user/sessions/other-jti", { method: "DELETE" }),
      { params: Promise.resolve({ id: "other-jti" }) },
    )
    expect(response.status).toBe(200)
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ jti: "other-jti", userId: "user-1" }),
      data: expect.objectContaining({ revokedAt: expect.any(Date) }),
    }))
  })

  it("does not report selective revocation when its durable audit row fails", async () => {
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"))
    const { DELETE } = await import("./[id]/route")

    await expect(DELETE(
      new NextRequest("https://api.lospor.org/v1/user/sessions/other-jti", { method: "DELETE" }),
      { params: Promise.resolve({ id: "other-jti" }) },
    )).rejects.toThrow("audit unavailable")
  })

  it("uses logout for the current session and does not mutate it here", async () => {
    const { DELETE } = await import("./[id]/route")
    const response = await DELETE(
      new NextRequest("https://api.lospor.org/v1/user/sessions/current-jti", { method: "DELETE" }),
      { params: Promise.resolve({ id: "current-jti" }) },
    )
    expect(response.status).toBe(409)
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it("does not disclose a session belonging to another account", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 })
    const { DELETE } = await import("./[id]/route")
    const response = await DELETE(
      new NextRequest("https://api.lospor.org/v1/user/sessions/not-owned", { method: "DELETE" }),
      { params: Promise.resolve({ id: "not-owned" }) },
    )
    expect(response.status).toBe(404)
    expect(mocks.audit).not.toHaveBeenCalled()
  })
})
