import { beforeEach, describe, expect, it, vi } from "vitest"
import type { NextRequest } from "next/server"

const getAuthUserMock = vi.fn()
const findManyMock = vi.fn()

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: getAuthUserMock }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    optionLibrary: { findMany: findManyMock },
  },
}))

let GET: (
  req: NextRequest,
  ctx: { params: Promise<{ category: string }> },
) => Promise<Response>

describe("GET /api/library/:category", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import("@/app/v1/library/[category]/route")
    GET = mod.GET as typeof GET
  })

  it("returns 401 when unauthenticated", async () => {
    getAuthUserMock.mockResolvedValue(null)

    const res = await GET(new Request("http://localhost/api/library/TECHNIQUE") as NextRequest, {
      params: Promise.resolve({ category: "TECHNIQUE" }),
    })

    expect(res.status).toBe(401)
    expect(findManyMock).not.toHaveBeenCalled()
  })

  it("returns active library rows for authenticated users", async () => {
    getAuthUserMock.mockResolvedValue({ id: "user-1" })
    findManyMock.mockResolvedValue([
      {
        id: "opt-1",
        value: "GENERAL",
        labelEn: "General",
        labelBg: null,
        group: null,
        parentId: null,
        color: null,
        description: null,
        drugId: null,
        drug: null,
        metadata: null,
      },
    ])

    const res = await GET(new Request("http://localhost/api/library/TECHNIQUE") as NextRequest, {
      params: Promise.resolve({ category: "TECHNIQUE" }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      {
        id: "opt-1",
        value: "GENERAL",
        label: "General",
        labelBg: null,
        group: null,
        parentId: null,
        color: null,
        description: null,
        drugId: null,
        atcCode: null,
        inn: null,
        metadata: null,
      },
    ])
  })
})
