import { afterEach, describe, expect, it, vi } from "vitest"
import { allowedCorsOrigin, corsHeaders } from "@/lib/cors"

function requestWithOrigin(origin: string | null) {
  return { headers: { get: (name: string) => (name === "origin" ? origin : null) } }
}

afterEach(() => {
  vi.unstubAllEnvs()
  delete process.env.CORS_ALLOW_ORIGIN
  delete process.env.CORS_ALLOW_ORIGINS
})

describe("CORS config", () => {
  it("allows permissive origin outside production deployment", () => {
    delete process.env.CORS_ALLOW_ORIGIN
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("VERCEL_ENV", undefined as unknown as string)
    expect(allowedCorsOrigin()).toBe("*")
  })

  it("fails closed in Vercel production when origin is missing", () => {
    delete process.env.CORS_ALLOW_ORIGIN
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("VERCEL_ENV", "production")
    expect(() => allowedCorsOrigin()).toThrow("CORS_ALLOW_ORIGIN")
  })

  it("accepts the first origin from CORS_ALLOW_ORIGINS", () => {
    vi.stubEnv("CORS_ALLOW_ORIGINS", "https://pwa.lospor.org, https://preview.lospor.org")
    expect(allowedCorsOrigin()).toBe("https://pwa.lospor.org")
  })

  it("reflects any allowlisted origin, not just the first", () => {
    vi.stubEnv("CORS_ALLOW_ORIGINS", "https://pwa.lospor.org, https://preview.lospor.org")
    expect(allowedCorsOrigin("https://preview.lospor.org")).toBe("https://preview.lospor.org")
    expect(allowedCorsOrigin("https://pwa.lospor.org")).toBe("https://pwa.lospor.org")
  })

  it("falls back to the first configured origin for unknown origins", () => {
    vi.stubEnv("CORS_ALLOW_ORIGINS", "https://pwa.lospor.org, https://preview.lospor.org")
    expect(allowedCorsOrigin("https://evil.example.com")).toBe("https://pwa.lospor.org")
  })

  it("merges the singular CORS_ALLOW_ORIGIN into the allowlist", () => {
    vi.stubEnv("CORS_ALLOW_ORIGINS", "https://pwa.lospor.org")
    vi.stubEnv("CORS_ALLOW_ORIGIN", "https://app.lospor.org")
    expect(allowedCorsOrigin("https://app.lospor.org")).toBe("https://app.lospor.org")
  })

  it("corsHeaders reflects the request origin and sets Vary: Origin", () => {
    vi.stubEnv("CORS_ALLOW_ORIGINS", "https://pwa.lospor.org, https://preview.lospor.org")
    const headers = corsHeaders(requestWithOrigin("https://preview.lospor.org"))
    expect(headers["Access-Control-Allow-Origin"]).toBe("https://preview.lospor.org")
    expect(headers["Vary"]).toBe("Origin")
    expect(headers["Access-Control-Expose-Headers"]).toContain("X-Request-Id")
    expect(headers["Access-Control-Expose-Headers"]).toContain("X-Case-Revision")
  })

  it("corsHeaders without a request keeps the static first-origin behaviour", () => {
    vi.stubEnv("CORS_ALLOW_ORIGINS", "https://pwa.lospor.org, https://preview.lospor.org")
    expect(corsHeaders()["Access-Control-Allow-Origin"]).toBe("https://pwa.lospor.org")
  })
})
