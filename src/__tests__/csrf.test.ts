import { afterEach, describe, expect, it, vi } from "vitest"
import { validateCookieWriteOrigin } from "@/lib/csrf"

function req(method: string, headers: Record<string, string>) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  return {
    method,
    headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null },
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  delete process.env.NEXTAUTH_URL
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.LOSPOR_DATABASE_URL
  delete process.env.CORS_ALLOW_ORIGIN
  delete process.env.CORS_ALLOW_ORIGINS
  delete process.env.VERCEL_URL
})

describe("cookie-authenticated API write CSRF guard", () => {
  it("rejects hostile-origin cookie writes", () => {
    vi.stubEnv("LOSPOR_WEB_URL", "https://app.lospor.org")
    expect(validateCookieWriteOrigin(req("POST", { origin: "https://evil.example" }))).toBe("fail")
  })

  it("accepts same-origin cookie writes", () => {
    vi.stubEnv("LOSPOR_WEB_URL", "https://app.lospor.org")
    expect(validateCookieWriteOrigin(req("PATCH", { origin: "https://app.lospor.org" }))).toBe("pass")
  })

  it("accepts the configured Database Browser origin", () => {
    vi.stubEnv("LOSPOR_WEB_URL", "https://app.lospor.org")
    vi.stubEnv("LOSPOR_DATABASE_URL", "https://database.lospor.org")
    expect(validateCookieWriteOrigin(req("POST", {
      origin: "https://database.lospor.org",
    }))).toBe("pass")
  })

  it("accepts the local Database Browser on a private LAN address", () => {
    vi.stubEnv("LOSPOR_WEB_URL", "https://app.lospor.org")
    expect(validateCookieWriteOrigin(req("POST", {
      origin: "http://192.168.0.101:3003",
    }))).toBe("pass")
  })

  it("does not allow the private-LAN exception in production", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("LOSPOR_WEB_URL", "https://app.lospor.org")
    expect(validateCookieWriteOrigin(req("POST", {
      origin: "http://192.168.0.101:3003",
    }))).toBe("fail")
  })

  it("rejects a hostile origin", () => {
    vi.stubEnv("LOSPOR_WEB_URL", "https://app.lospor.org")
    expect(validateCookieWriteOrigin(req("POST", {
      origin: "https://evil.example",
    }))).toBe("fail")
  })

  it("accepts bearer-token mobile writes", () => {
    vi.stubEnv("LOSPOR_WEB_URL", "https://app.lospor.org")
    expect(validateCookieWriteOrigin(req("POST", {
      origin: "https://pwa.lospor.org",
      authorization: "Bearer token",
    }))).toBe("pass")
  })

  it("does not require an origin for reads", () => {
    vi.stubEnv("LOSPOR_WEB_URL", "https://app.lospor.org")
    expect(validateCookieWriteOrigin(req("GET", {}))).toBe("pass")
  })
})
