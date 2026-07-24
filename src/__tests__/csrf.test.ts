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
  delete process.env.VERCEL_URL
})

describe("cookie-authenticated API write CSRF guard", () => {
  it("rejects hostile-origin cookie writes", () => {
    vi.stubEnv("NEXTAUTH_URL", "https://app.lospor.org")
    expect(validateCookieWriteOrigin(req("POST", { origin: "https://evil.example" }))).toBe("fail")
  })

  it("accepts same-origin cookie writes", () => {
    vi.stubEnv("NEXTAUTH_URL", "https://app.lospor.org")
    expect(validateCookieWriteOrigin(req("PATCH", { origin: "https://app.lospor.org" }))).toBe("pass")
  })

  it("accepts bearer-token mobile writes", () => {
    vi.stubEnv("NEXTAUTH_URL", "https://app.lospor.org")
    expect(validateCookieWriteOrigin(req("POST", {
      origin: "https://pwa.lospor.org",
      authorization: "Bearer token",
    }))).toBe("pass")
  })

  it("does not require an origin for reads", () => {
    vi.stubEnv("NEXTAUTH_URL", "https://app.lospor.org")
    expect(validateCookieWriteOrigin(req("GET", {}))).toBe("pass")
  })
})
