import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  executeRaw: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: mocks.getAuthUser }))
vi.mock("@/lib/audit", () => ({ logAuditInTransaction: mocks.audit }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (run: (transaction: unknown) => unknown) => run({
      $executeRaw: mocks.executeRaw,
      researchSelfAuthorization: {
        findFirst: mocks.findFirst,
        create: mocks.create,
      },
      auditLog: { create: vi.fn() },
    }),
  },
}))

describe("research self-authorization audit rollback", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAuthUser.mockResolvedValue({
      id: "clinician-1",
      role: "MEMBER",
      accountKind: "CLINICAL",
      institutionId: "institution-1",
    })
    mocks.executeRaw.mockResolvedValue(1)
    mocks.findFirst.mockResolvedValue(null)
    mocks.create.mockResolvedValue({
      id: "self-auth-1",
      userId: "clinician-1",
      institutionId: "institution-1",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
  })

  // HAUD_ROLLBACK:research-self-authorization
  it("does not report aggregate access when durable authorization evidence fails", async () => {
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"))

    const { POST } = await import("./route")
    await expect(POST(new Request(
      "https://api.lospor.org/v1/research/self-authorization",
      { method: "POST" },
    ))).rejects.toThrow("audit unavailable")
  })
})
