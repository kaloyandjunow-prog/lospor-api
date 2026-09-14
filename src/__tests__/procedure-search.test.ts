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

describe("the exact operations inside a procedure group", () => {
  beforeEach(() => {
    getAuthUserMock.mockResolvedValue({ id: "user-1" })
  })

  const codesFor = async (query: string) => {
    const { GET: CODES } = await import("@/app/v1/search/procedures/codes/route")
    return CODES(new NextRequest(`http://localhost/v1/search/procedures/codes?${query}`))
  }

  it("lists every ICD-10-PCS code of the group", async () => {
    const response = await codesFor("group=Cholecystectomy")
    const body = await response.json() as { total: number; codes: { code: string; domain: string | null }[] }
    expect(response.status).toBe(200)
    expect(body.total).toBe(8)
    expect(body.codes.map(row => row.code)).toContain("0FT44ZZ")
    expect(body.codes.every(row => row.domain)).toBe(true)
  })

  it("narrows by the clinician's words, laparoscopic included", async () => {
    const body = await (await codesFor("group=Cholecystectomy&q=laparoscopic%20resection")).json() as { codes: { code: string }[] }
    expect(body.codes.map(row => row.code)).toEqual(["0FT44ZG", "0FT44ZZ"])
  })

  it("caps a huge group and says how many matched", async () => {
    const body = await (await codesFor("group=Musculoskeletal%20device%20procedures%2C%20NEC")).json() as { total: number; codes: unknown[] }
    expect(body.total).toBeGreaterThan(5000)
    expect(body.codes).toHaveLength(200)
  })

  it("needs a group and a signed-in user", async () => {
    expect((await codesFor("q=lap")).status).toBe(400)
    getAuthUserMock.mockResolvedValue(null)
    expect((await codesFor("group=Cholecystectomy")).status).toBe(401)
  })
})

describe("the bundled ICD-10-PCS research codes", () => {
  it("cover LOSPOR's operations with standard concepts and name their source", async () => {
    const fs = await import("node:fs")
    const pack = JSON.parse(fs.readFileSync("src/data/icd10pcs-omop.json", "utf8")) as {
      source: string
      standardVocabulary: string
      concepts: Record<string, number>
      mapsTo: Record<string, { conceptId: number; vocabulary: string }>
    }
    const pcs = JSON.parse(fs.readFileSync("src/data/pcs.json", "utf8")) as { code: string }[]
    const codes = new Set(pcs.map(row => row.code))

    expect(pack.source).toMatch(/^OHDSI Athena, ICD10PCS \d{4}/)
    expect(pack.standardVocabulary).toBe("ICD10PCS")
    expect(pack.concepts["0FT44ZZ"]).toBeGreaterThan(0)
    // Nearly every code, and nothing that is not one of LOSPOR's.
    expect(Object.keys(pack.concepts).length + Object.keys(pack.mapsTo).length).toBeGreaterThan(codes.size * 0.99)
    expect([...Object.keys(pack.concepts), ...Object.keys(pack.mapsTo)].every(code => codes.has(code))).toBe(true)
    // SNOMED stays out of the bundle until its licence is decided.
    expect(Object.values(pack.mapsTo).every(target => target.vocabulary.startsWith("RxNorm"))).toBe(true)
  })
})

describe("operations suggested by a hospital code", () => {
  it("come first and are marked", async () => {
    getAuthUserMock.mockResolvedValue({ id: "user-1" })
    const { GET: CODES } = await import("@/app/v1/search/procedures/codes/route")
    const body = await (await CODES(new NextRequest(
      "http://localhost/v1/search/procedures/codes?group=Cholecystectomy&suggested=0FT44ZZ,0FB44ZZ",
    ))).json() as { codes: { code: string; suggested?: boolean }[] }
    expect(body.codes.slice(0, 3)).toEqual([
      expect.objectContaining({ code: "0FB44ZZ", suggested: true }),
      expect.objectContaining({ code: "0FT44ZZ", suggested: true }),
      expect.not.objectContaining({ suggested: true }),
    ])
  })
})
