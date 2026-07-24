import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/labs", () => ({ LAB_LIBRARY: [{ name: "Glucose", unit: "mmol/L" }] }))
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: vi.fn(async () => ({ id: "user-1" })) }))
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ allowed: true })) }))

describe("AI lab reading upload size guard", () => {
  it("rejects oversized base64 payloads even without Content-Length", async () => {
    vi.stubEnv("MISTRAL_API_KEY", "test")
    const { POST } = await import("@/app/v1/ai/read-labs/route")

    const req = new Request("https://app.lospor.org/api/ai/read-labs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64: "a".repeat(Math.ceil(10_485_760 * 4 / 3) + 1),
        mimeType: "image/jpeg",
      }),
    })

    const res = await POST(req as never)
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: "Image too large" })
  })
})
