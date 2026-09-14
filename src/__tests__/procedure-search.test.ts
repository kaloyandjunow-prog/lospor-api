import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { getAuthUserMock } = vi.hoisted(() => ({
  getAuthUserMock: vi.fn(),
}))

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: getAuthUserMock }))

import { GET } from "@/app/v1/search/procedures/route"

describe("procedure search", () => {
  beforeEach(() => {
    getAuthUserMock.mockResolvedValue({ id: "user-1" })
  })

  it("uses the English catalogue when the client locale is Bulgarian", async () => {
    const req = new NextRequest(
      "http://localhost/v1/search/procedures?q=append&locale=bg",
    )

    const response = await GET(req)
    const results = await response.json() as Array<{
      code: string
      description: string
      group: string
      domain: string
    }>

    expect(response.status).toBe(200)
    expect(results.length).toBeGreaterThan(0)
    expect(results).toContainEqual(expect.objectContaining({
      group: "Appendectomy",
      domain: "Gastrointestinal System Procedures",
    }))
  })

  it("finds a procedure group by its Bulgarian name", async () => {
    const response = await GET(new NextRequest(
      "http://localhost/v1/search/procedures?q=%D0%A5%D0%BE%D0%BB%D0%B5%D1%86%D0%B8%D1%81%D1%82%D0%B5%D0%BA%D1%82%D0%BE%D0%BC%D0%B8%D1%8F",
    ))
    const results = await response.json() as Array<{ group: string }>
    expect(results.map(row => row.group)).toContain("Cholecystectomy")
  })
})
