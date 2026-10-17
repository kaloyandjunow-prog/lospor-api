import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const verifyPrintTokenMock = vi.fn()
const caseFindFirstMock = vi.fn()
const userFindUniqueMock = vi.fn()
const renderRecordPdfMock = vi.fn()

vi.mock("@/lib/print-token", () => ({ verifyPrintToken: verifyPrintTokenMock }))
vi.mock("@/lib/token-blocklist", () => ({ revokeToken: vi.fn().mockResolvedValue(true) }))
vi.mock("@/lib/record-pdf", () => ({ renderRecordPdf: renderRecordPdfMock }))
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    case: { findFirst: caseFindFirstMock },
    user: { findUnique: userFindUniqueMock },
  },
}))

describe("GET /v1/cases/:id/pdf", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.LOSPOR_AUTH_SECRET = "test-secret-test-secret-test-secret"
    process.env.LOSPOR_WEB_URL = "https://web.test"
    verifyPrintTokenMock.mockResolvedValue("requester-1")
    caseFindFirstMock.mockResolvedValue({ id: "case-1", caseCode: "2026-0001", userId: "owner-1" })
    renderRecordPdfMock.mockResolvedValue(new Uint8Array([37, 80, 68, 70]))
  })

  async function pageUrl(): Promise<URL> {
    const { GET } = await import("@/app/v1/cases/[id]/pdf/route")
    const response = await GET(
      new NextRequest("https://api.test/v1/cases/case-1/pdf?print_token=t&lang=bg"),
      { params: Promise.resolve({ id: "case-1" }) },
    )
    expect(response.status).toBe(200)
    return new URL(renderRecordPdfMock.mock.calls[0][0] as string)
  }

  it("prints with the requester's Bulgarian-name switches, since the headless browser has none", async () => {
    userFindUniqueMock.mockResolvedValue({ preferences: { bulgarianNames: { drugs: true, fluids: true } } })
    const url = await pageUrl()
    expect(userFindUniqueMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "requester-1" } }))
    expect(url.searchParams.get("names")).toBe("drugs,fluids")
  })

  it("asks for international names when no switch is on", async () => {
    userFindUniqueMock.mockResolvedValue({ preferences: {} })
    expect((await pageUrl()).searchParams.get("names")).toBe("")
  })
})
