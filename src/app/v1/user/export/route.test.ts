import { beforeEach, describe, expect, it, vi } from "vitest"

const getAuthUser = vi.fn()
const findAccount = vi.fn()
const caseCount = vi.fn()
const auditCount = vi.fn()
const roleRequestCount = vi.fn()
const transferCount = vi.fn()
const findCases = vi.fn()
const findAudit = vi.fn()
const findRoleRequests = vi.fn()
const findTransfers = vi.fn()

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: findAccount },
    case: { count: caseCount, findMany: findCases },
    auditLog: { count: auditCount, findMany: findAudit },
    roleRequest: { count: roleRequestCount, findMany: findRoleRequests },
    caseTransfer: { count: transferCount, findMany: findTransfers },
  },
}))

describe("personal data archive", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAuthUser.mockResolvedValue({ id: "user-1" })
    findAccount.mockResolvedValue({
      id: "user-1",
      email: "clinician@example.test",
      deletedAt: null,
    })
    caseCount.mockResolvedValue(251)
    auditCount.mockResolvedValue(0)
    roleRequestCount.mockResolvedValue(0)
    transferCount.mockResolvedValue(0)
    findCases
      .mockResolvedValueOnce(Array.from({ length: 250 }, (_, index) => ({ id: `case-${index}` })))
      .mockResolvedValueOnce([{ id: "case-250" }])
      .mockResolvedValueOnce([])
    findAudit.mockResolvedValue([])
    findRoleRequests.mockResolvedValue([])
    findTransfers.mockResolvedValue([])
  })

  it("streams every cursor page as one ZIP archive", async () => {
    const { GET } = await import("./route")
    const response = await GET(new Request("http://localhost/v1/user/export") as never)
    const bytes = await response.arrayBuffer()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/zip")
    expect(response.headers.get("content-disposition")).toContain(".zip")
    expect(bytes.byteLength).toBeGreaterThan(100)
    expect(findCases).toHaveBeenCalledTimes(3)
    expect(findCases.mock.calls[1][0]).toMatchObject({
      cursor: { id: "case-249" },
      skip: 1,
    })
  })
})
