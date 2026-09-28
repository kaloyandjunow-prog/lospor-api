import { beforeEach, describe, expect, it, vi } from "vitest"

const { authUser } = vi.hoisted(() => ({ authUser: vi.fn() }))
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: authUser }))

import { GET } from "./route"

// Home medications and allergies come from Core's medication list (NHIS CL009
// plus the BDA products it lacks), the same list and search the phone uses
// offline and Status maps codes to (9.13.3).

const search = async (q: string) => {
  const response = await GET({ nextUrl: new URL(`http://localhost/v1/search/drugs?q=${encodeURIComponent(q)}`) } as never)
  return { status: response.status, body: await response.json() as Record<string, unknown>[] }
}

describe("the drug search", () => {
  beforeEach(() => { authUser.mockResolvedValue({ id: "user-1" }) })

  it("answers from the medication list, with the national code and the ATC code under both names", async () => {
    const { status, body } = await search("ramipril")
    expect(status).toBe(200)
    expect(body.length).toBeGreaterThan(3)
    expect(body.every(drug => drug.atc === drug.atcCode)).toBe(true)
    const national = body.find(drug => typeof drug.nhisCode === "string")
    expect(national).toMatchObject({ id: `cl009:${national?.nhisCode}`, inn: expect.stringMatching(/ramipril/i) })
  })

  it("finds by ATC code", async () => {
    const { body } = await search("C09AA05")
    expect(body.length).toBeGreaterThan(0)
    expect(body.every(drug => drug.atc === "C09AA05")).toBe(true)
  })

  it("asks nothing of a too-short query, and nothing of a stranger", async () => {
    expect((await search("r")).body).toEqual([])
    authUser.mockResolvedValue(null)
    expect((await search("ramipril")).status).toBe(401)
  })
})
