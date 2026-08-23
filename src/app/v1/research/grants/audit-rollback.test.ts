import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  routeError: vi.fn(),
  userFindUnique: vi.fn(),
  grantFindUnique: vi.fn(),
  grantCreate: vi.fn(),
  grantUpdate: vi.fn(),
  audit: vi.fn(),
}))

vi.mock("@/lib/research/request", () => ({
  authorizeResearchRequest: mocks.authorize,
  researchRouteError: mocks.routeError,
}))
vi.mock("@/lib/audit", () => ({ logAuditInTransaction: mocks.audit }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique },
    researchAccessGrant: { findUnique: mocks.grantFindUnique },
    $transaction: (run: (transaction: unknown) => unknown) => run({
      researchAccessGrant: {
        create: mocks.grantCreate,
        update: mocks.grantUpdate,
      },
      auditLog: { create: vi.fn() },
    }),
  },
}))

const grant = {
  id: "grant-1",
  userId: "researcher-1",
  institutionId: "institution-1",
  allInstitutions: false,
  canQuery: true,
  canInspectCases: false,
  canExport: false,
  canExportOmop: false,
  canShareCohorts: false,
  createdAt: new Date("2026-08-23T00:00:00Z"),
  expiresAt: new Date("2026-09-23T00:00:00Z"),
  revokedAt: null,
}

describe("public research grant audit rollback", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.authorize.mockResolvedValue({ context: { user: { id: "research-admin-1" } } })
    mocks.routeError.mockImplementation(() => Response.json(
      { error: "Research request failed", code: "RESEARCH_REQUEST_FAILED" },
      { status: 500 },
    ))
    mocks.userFindUnique.mockResolvedValue({
      id: "researcher-1",
      role: "MEMBER",
      accountKind: "RESEARCH_ONLY",
      activatedAt: new Date(),
      emailVerifiedAt: new Date(),
      suspendedAt: null,
      recoveryRequiredAt: null,
      deletedAt: null,
      anonymizedAt: null,
    })
    mocks.grantFindUnique.mockResolvedValue(grant)
    mocks.grantCreate.mockResolvedValue(grant)
    mocks.grantUpdate.mockResolvedValue(grant)
    mocks.audit.mockRejectedValue(new Error("audit unavailable"))
  })

  // HAUD_ROLLBACK:public-research-grants
  it("returns no grant success for create, change, or revoke when audit persistence fails", async () => {
    const collection = await import("./route")
    const member = await import("./[id]/route")

    const created = await collection.POST(new Request("https://api.lospor.org/v1/research/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: "researcher-1",
        institutionId: "institution-1",
        canQuery: true,
      }),
    }))
    const changed = await member.PATCH(new Request("https://api.lospor.org/v1/research/grants/grant-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ canInspectCases: true }),
    }), { params: Promise.resolve({ id: "grant-1" }) })
    const revoked = await member.DELETE(new Request(
      "https://api.lospor.org/v1/research/grants/grant-1",
      { method: "DELETE" },
    ), { params: Promise.resolve({ id: "grant-1" }) })

    expect([created.status, changed.status, revoked.status]).toEqual([500, 500, 500])
    expect(mocks.routeError).toHaveBeenCalledTimes(3)
  })
})
