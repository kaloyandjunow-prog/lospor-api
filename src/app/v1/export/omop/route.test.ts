import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const getAuthUser = vi.fn()
const requireRole = vi.fn()
const countCases = vi.fn()
const findCases = vi.fn()

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser }))
vi.mock("@/lib/access-control", () => ({ requireRole }))
vi.mock("@/lib/prisma", () => ({
  prisma: { case: { count: countCases, findMany: findCases } },
}))
vi.mock("@/lib/omop-mapper", () => ({ mapCasesToOmop: vi.fn() }))

describe("OMOP export completeness gate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAuthUser.mockResolvedValue({ id: "admin-1", role: "ADMIN" })
    requireRole.mockReturnValue(true)
  })

  it("rejects a result above the hard limit without reading a partial page", async () => {
    countCases.mockResolvedValueOnce(5001).mockResolvedValueOnce(0)
    const { GET } = await import("./route")
    const request = new NextRequest("http://localhost/v1/export/omop")

    const response = await GET(request)

    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({
      code: "EXPORT_LIMIT_EXCEEDED",
      matchingCases: 5001,
      exportedCases: 0,
      exportLimit: 5000,
      complete: false,
    })
    expect(findCases).not.toHaveBeenCalled()
  })
})
