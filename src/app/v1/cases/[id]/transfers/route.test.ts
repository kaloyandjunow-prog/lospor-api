import { beforeEach, describe, expect, it, vi } from "vitest"

const getAuthUser = vi.fn()
const findCase = vi.fn()
const findTransfers = vi.fn()

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser }))
vi.mock("@/lib/access-control", () => ({
  caseReadWhereForUser: (_u: unknown, id: string) => ({ id }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    case: { findFirst: findCase },
    caseTransfer: { findMany: findTransfers },
  },
}))

const context = { params: Promise.resolve({ id: "case-1" }) }
const request = () =>
  new Request("http://localhost/v1/cases/case-1/transfers") as never

describe("a case's handover history", () => {
  let GET: typeof import("./route").GET

  beforeEach(async () => {
    vi.clearAllMocks()
    getAuthUser.mockResolvedValue({ id: "peer-1", role: "MEMBER", institutionId: "inst-1" })
    findCase.mockResolvedValue({ id: "case-1" })
    findTransfers.mockResolvedValue([])
    ;({ GET } = await import("./route"))
  })

  it("requires a signed-in user", async () => {
    getAuthUser.mockResolvedValue(null)
    expect((await GET(request(), context)).status).toBe(401)
  })

  // Visibility follows the case. Someone who may not open it learns nothing
  // about who has held it -- and gets the same answer as for a case that does
  // not exist, so the history cannot be used to probe for one.
  it("gives a stranger the same answer as a missing case", async () => {
    findCase.mockResolvedValue(null)
    const response = await GET(request(), context)

    expect(response.status).toBe(404)
    expect(findTransfers).not.toHaveBeenCalled()
  })

  it("returns the history oldest first, with both parties and the old code", async () => {
    findTransfers.mockResolvedValue([
      {
        id: "t-1", status: "ACCEPTED", previousCaseCode: "2026-0004",
        fromUser: { id: "author-1", name: "Member Alpha" },
        toUser: { id: "peer-1", name: "Hod Alpha" },
      },
    ])
    const response = await GET(request(), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject([
      { status: "ACCEPTED", previousCaseCode: "2026-0004" },
    ])
    // Forwards, because it is read as a history.
    expect(findTransfers).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "asc" } }),
    )
  })

  it("scopes to the case asked for", async () => {
    await GET(request(), context)
    expect(findTransfers).toHaveBeenCalledWith(
      expect.objectContaining({ where: { caseId: "case-1" } }),
    )
  })
})
