import { beforeEach, describe, expect, it, vi } from "vitest"
import type { NextRequest } from "next/server"

const getAuthUserMock = vi.fn()
const findManyMock = vi.fn()
const drugColorFindManyMock = vi.fn()

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: getAuthUserMock }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    optionLibrary: { findMany: findManyMock },
    drugColor: { findMany: drugColorFindManyMock },
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
    expect(drugColorFindManyMock).not.toHaveBeenCalled()
  })

  it("gives each drug the hospital's colour: its own, else its group's (10.0.0)", async () => {
    getAuthUserMock.mockResolvedValue({ id: "user-1" })
    const row = (labelEn: string) => ({
      id: labelEn, value: labelEn.toUpperCase(), labelEn, labelBg: null, group: "Opioid analgesics", parentId: null,
      color: "#f97316", description: null, drugId: null, drug: null, metadata: null,
    })
    findManyMock.mockResolvedValue([row("Fentanyl"), row("Remifentanil"), { ...row("Ondansetron"), group: "Antiemetics / prokinetics" }])
    drugColorFindManyMock.mockResolvedValue([
      { scope: "GROUP", name: "Opioid analgesics", color: "#3b82f6" },
      { scope: "DRUG", name: "Remifentanil", color: "#EC4899" },
    ])

    const res = await GET(new Request("http://localhost/api/library/INTRAOP_INFUSION") as NextRequest, {
      params: Promise.resolve({ category: "INTRAOP_INFUSION" }),
    })

    const body = await res.json() as { label: string; color: string; customColor?: string; customGroupColor?: string }[]
    expect(body.map(option => [option.label, option.customColor, option.customGroupColor])).toEqual([
      ["Fentanyl", "#3b82f6", "#3b82f6"],
      ["Remifentanil", "#ec4899", "#3b82f6"],
      ["Ondansetron", undefined, undefined],
    ])
    // The bundled colour still travels, for a client that predates the custom one.
    expect(body[0].color).toBe("#f97316")
  })
})
