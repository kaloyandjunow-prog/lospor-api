import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const getAuthUserMock = vi.fn()
const rateLimitMock = vi.fn()
const findUniqueMock = vi.fn()

vi.mock("@/lib/mobile-auth", () => ({
  getAuthUser: getAuthUserMock,
}))

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: rateLimitMock,
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    case: {
      findUnique: findUniqueMock,
    },
  },
}))

describe("case vitals scan route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // This suite verifies case authorization, so make the independently
    // governed AI capability available. Production deliberately rejects an
    // unavailable capability before reading any case or clinical payload.
    vi.stubEnv("MISTRAL_API_KEY", "configured-for-route-test")
    vi.stubEnv("LOSPOR_DISABLE_EXTERNAL_AI", "false")
    vi.stubEnv("HOSPITAL_APPLIANCE", "false")
    vi.stubGlobal("fetch", vi.fn())
    getAuthUserMock.mockResolvedValue({ id: "user-1", role: "MEMBER", institutionId: "inst-1" })
    rateLimitMock.mockResolvedValue({ allowed: true })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("rejects a case the authenticated user cannot access before calling Mistral", async () => {
    findUniqueMock.mockResolvedValue({
      userId: "other-user",
      user: { institutionId: "inst-2" },
    })

    const { POST } = await import("@/app/v1/cases/[id]/vitals-scan/route")
    const response = await POST(
      new Request("http://localhost/api/cases/case-1/vitals-scan", {
        method: "POST",
        body: JSON.stringify({ image: "base64-image" }),
      }) as Parameters<typeof POST>[0],
      { params: Promise.resolve({ id: "case-1" }) },
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" })
    expect(findUniqueMock).toHaveBeenCalledWith({
      where: { id: "case-1" },
      select: {
        userId: true,
        user: { select: { institutionId: true } },
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
