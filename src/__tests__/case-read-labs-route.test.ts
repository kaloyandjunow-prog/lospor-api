import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const getAuthUserMock = vi.fn()
const rateLimitMock = vi.fn()
const findUniqueMock = vi.fn()

vi.mock("@/lib/labs", () => ({ LAB_LIBRARY: [{ name: "Glucose", unit: "mmol/L" }] }))
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: getAuthUserMock }))
vi.mock("@/lib/rate-limit", () => ({ rateLimit: rateLimitMock }))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: { case: { findUnique: findUniqueMock } },
}))

const MAX_BASE64_CHARS = Math.ceil(10_485_760 * 4 / 3)

async function post(body: unknown, id = "case-1") {
  const { POST } = await import("@/app/v1/cases/[id]/ai/read-labs/route")
  return POST(
    new Request(`http://localhost/api/cases/${id}/ai/read-labs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as Parameters<typeof POST>[0],
    { params: Promise.resolve({ id }) },
  )
}

describe("case lab report scan route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // This suite verifies case authorization and consent, so make the
    // independently governed AI capability available.
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
      preop: { aiOptIn: true },
    })

    const res = await post({ imageBase64: "aaaa", mimeType: "image/jpeg" })

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("returns 404 for a case that does not exist", async () => {
    findUniqueMock.mockResolvedValue(null)

    const res = await post({ imageBase64: "aaaa", mimeType: "image/jpeg" })

    expect(res.status).toBe(404)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("refuses to send a lab report image when the case has not opted in", async () => {
    findUniqueMock.mockResolvedValue({
      userId: "user-1",
      user: { institutionId: "inst-1" },
      preop: { aiOptIn: false },
    })

    const res = await post({ imageBase64: "aaaa", mimeType: "image/jpeg" })

    expect(res.status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })

  // The whole point of moving this route under a case. The previous unscoped
  // route read consent from the request body, so any authenticated caller could
  // assert consent the clinical record did not contain -- for a photograph that
  // carries the patient's name and EGN and cannot be redacted.
  it("ignores a client-supplied aiOptIn when the record says otherwise", async () => {
    findUniqueMock.mockResolvedValue({
      userId: "user-1",
      user: { institutionId: "inst-1" },
      preop: { aiOptIn: false },
    })

    const res = await post({ imageBase64: "aaaa", mimeType: "image/jpeg", aiOptIn: true })

    expect(res.status).toBe(403)
    expect(fetch).not.toHaveBeenCalled()
  })

  // Size is a structural fact about the payload, so it is answered before the
  // policy question. A caller sending something far too large is told that,
  // rather than being sent to fix a consent setting that is not the problem.
  it("rejects an oversized payload as oversized, even on a consenting case", async () => {
    findUniqueMock.mockResolvedValue({
      userId: "user-1",
      user: { institutionId: "inst-1" },
      preop: { aiOptIn: true },
    })

    const res = await post({
      imageBase64: "a".repeat(MAX_BASE64_CHARS + 1),
      mimeType: "image/jpeg",
    })

    expect(res.status).toBe(413)
    await expect(res.json()).resolves.toEqual({ error: "Image too large" })
    expect(fetch).not.toHaveBeenCalled()
  })
})
