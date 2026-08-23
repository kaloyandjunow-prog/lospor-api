import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  pending: vi.fn(),
  create: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
}))

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: mocks.auth }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    roleRequest: { findFirst: mocks.pending },
    $transaction: mocks.transaction,
  },
}))

describe("role request audit", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({ id: "member-1", role: "MEMBER" })
    mocks.pending.mockResolvedValue(null)
    mocks.create.mockResolvedValue({ id: "request-1", userId: "member-1", status: "PENDING" })
    mocks.auditCreate.mockResolvedValue({})
    mocks.transaction.mockImplementation(async callback => callback({
      roleRequest: { create: mocks.create },
      auditLog: { create: mocks.auditCreate },
    }))
  })

  it("creates the request and its durable event in one transaction", async () => {
    const { POST } = await import("./route")
    const response = await POST(new Request("https://api.lospor.org/v1/role-request", {
      method: "POST",
    }) as never)
    expect(response.status).toBe(201)
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: {
        userId: "member-1",
        action: "ROLE_REQUEST_SUBMIT",
        entityId: "member-1",
        detail: { requestId: "request-1", requestedRole: "HEAD_OF_DEPT" },
      },
    })
  })

  // HAUD_ROLLBACK:role-request-submit
  it("does not report success when the transaction cannot write its audit row", async () => {
    mocks.auditCreate.mockRejectedValue(new Error("audit unavailable"))
    const { POST } = await import("./route")
    await expect(POST(new Request("https://api.lospor.org/v1/role-request", {
      method: "POST",
    }) as never)).rejects.toThrow("audit unavailable")
  })
})
