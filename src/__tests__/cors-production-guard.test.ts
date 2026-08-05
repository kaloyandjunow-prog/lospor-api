import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { allowedCorsOrigin, corsHeaders, isProductionDeployment } from "../lib/cors"
import { validateCookieWriteOrigin } from "../lib/csrf"

/**
 * Enforcement used to require `NODE_ENV=production` **and**
 * `VERCEL_ENV=production`. A hospital-hosted appliance sets the first and never
 * the second, so it matched neither branch and fell through to
 * `Access-Control-Allow-Origin: *` — every site on the internet permitted to
 * call a clinical API. Self-hosting is the intended deployment model, so that is
 * precisely where the guard has to hold.
 *
 * Vercel preview builds also set `NODE_ENV=production`, so keying on that alone
 * would break every preview. The cases below pin both halves.
 */
/** NODE_ENV is typed read-only, so assign through the record. */
const setNodeEnv = (value: string) => { (process.env as Record<string, string>).NODE_ENV = value }

const saved = { ...process.env }
beforeEach(() => {
  delete process.env.CORS_ALLOW_ORIGIN
  delete process.env.CORS_ALLOW_ORIGINS
  delete process.env.VERCEL_ENV
  delete process.env.LOSPOR_WEB_URL
  delete process.env.NEXT_PUBLIC_APP_URL
  delete process.env.NEXTAUTH_URL
  delete process.env.LOSPOR_DATABASE_URL
  delete process.env.VERCEL_URL
  setNodeEnv("test")
})
afterEach(() => { process.env = { ...saved } })

describe("isProductionDeployment", () => {
  it("is true for a self-hosted appliance — NODE_ENV only, no VERCEL_ENV", () => {
    setNodeEnv("production")
    expect(isProductionDeployment()).toBe(true)
  })

  it("is true on Vercel production", () => {
    setNodeEnv("production")
    process.env.VERCEL_ENV = "production"
    expect(isProductionDeployment()).toBe(true)
  })

  it("is false on a Vercel preview, which also builds with NODE_ENV=production", () => {
    setNodeEnv("production")
    process.env.VERCEL_ENV = "preview"
    expect(isProductionDeployment()).toBe(false)
  })

  it("is false in local development", () => {
    setNodeEnv("development")
    expect(isProductionDeployment()).toBe(false)
  })
})

describe("allowedCorsOrigin", () => {
  it("refuses to fall back to '*' on a self-hosted production install", () => {
    // The exact case that was open: appliance, CORS variable forgotten.
    setNodeEnv("production")
    expect(() => allowedCorsOrigin(null)).toThrow(/must be set in production/)
  })

  it("still allows '*' in development and on previews", () => {
    setNodeEnv("development")
    expect(allowedCorsOrigin(null)).toBe("*")
    setNodeEnv("production")
    process.env.VERCEL_ENV = "preview"
    expect(allowedCorsOrigin(null)).toBe("*")
  })

  it("reflects a configured origin back", () => {
    process.env.CORS_ALLOW_ORIGINS = "https://app.lospor.org,https://pwa.lospor.org"
    expect(allowedCorsOrigin("https://pwa.lospor.org")).toBe("https://pwa.lospor.org")
  })

  it("returns nothing for an unrecognised origin, rather than another site's", () => {
    process.env.CORS_ALLOW_ORIGINS = "https://app.lospor.org"
    expect(allowedCorsOrigin("https://evil.example")).toBeNull()
  })

  it("omits the header entirely for an unrecognised origin", () => {
    process.env.CORS_ALLOW_ORIGINS = "https://app.lospor.org"
    const headers = corsHeaders({ headers: { get: () => "https://evil.example" } })
    expect("Access-Control-Allow-Origin" in headers).toBe(false)
  })

  it("a correctly configured appliance is unaffected", () => {
    // compose.yaml sets both NODE_ENV and the origins, so nothing changes there.
    setNodeEnv("production")
    process.env.CORS_ALLOW_ORIGINS = "https://lospor.hospital.local"
    expect(allowedCorsOrigin("https://lospor.hospital.local")).toBe("https://lospor.hospital.local")
  })
})

describe("validateCookieWriteOrigin", () => {
  const write = (origin: string | null) => ({
    method: "POST",
    headers: { get: (name: string) => (name === "origin" ? origin : null) },
  })

  it("fails closed in production when no trusted origin is configured", () => {
    // Previously "skip": every cookie-authenticated write accepted, which is
    // cross-site request forgery waiting on a misconfigured install.
    setNodeEnv("production")
    expect(validateCookieWriteOrigin(write("https://evil.example"))).toBe("fail")
  })

  it("still rejects an untrusted origin in development", () => {
    // In development trustedAppOrigins() is never empty — it adds the local
    // client origins — so the "no trusted origin" branch is unreachable there
    // and this behaviour is unchanged by the production fix.
    setNodeEnv("development")
    expect(validateCookieWriteOrigin(write("https://evil.example"))).toBe("fail")
  })

  it("accepts a write from a configured origin", () => {
    setNodeEnv("production")
    process.env.CORS_ALLOW_ORIGIN = "https://app.lospor.org"
    expect(validateCookieWriteOrigin(write("https://app.lospor.org"))).toBe("pass")
  })

  it("passes a bearer-authenticated write regardless", () => {
    setNodeEnv("production")
    expect(validateCookieWriteOrigin({
      method: "POST",
      headers: { get: (n: string) => (n === "authorization" ? "Bearer token" : null) },
    })).toBe("pass")
  })

  it("leaves reads alone", () => {
    setNodeEnv("production")
    expect(validateCookieWriteOrigin({ method: "GET", headers: { get: () => null } })).toBe("pass")
  })
})
