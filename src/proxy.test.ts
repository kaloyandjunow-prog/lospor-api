import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { getAuthUser } = vi.hoisted(() => ({ getAuthUser: vi.fn() }))
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser }))

import proxy, { isResearchOnlyAllowedPath } from "./proxy"
import { NextRequest } from "next/server"

describe("research-only application boundary", () => {
  beforeEach(() => getAuthUser.mockReset())

  it("keeps auth, account language, legal and research routes available", () => {
    expect(isResearchOnlyAllowedPath("/v1/auth/session")).toBe(true)
    expect(isResearchOnlyAllowedPath("/v1/user")).toBe(true)
    expect(isResearchOnlyAllowedPath("/v1/user/legal-acceptances")).toBe(true)
    expect(isResearchOnlyAllowedPath("/v1/user/change-password")).toBe(true)
    expect(isResearchOnlyAllowedPath("/v1/user/sessions/another-device")).toBe(true)
    expect(isResearchOnlyAllowedPath("/v1/locale")).toBe(true)
    expect(isResearchOnlyAllowedPath("/v1/legal/documents")).toBe(true)
    expect(isResearchOnlyAllowedPath("/v1/research/query")).toBe(true)
  })

  it("classifies case, clinical catalogue, AI and personal case export as clinical", () => {
    expect(isResearchOnlyAllowedPath("/v1/cases")).toBe(false)
    expect(isResearchOnlyAllowedPath("/v1/clinical/pediatric/rules")).toBe(false)
    expect(isResearchOnlyAllowedPath("/v1/search/icd10")).toBe(false)
    expect(isResearchOnlyAllowedPath("/v1/ai/advise")).toBe(false)
    expect(isResearchOnlyAllowedPath("/v1/user/export")).toBe(false)
    expect(isResearchOnlyAllowedPath("/v1/user/legal-acceptances-legacy")).toBe(false)
  })

  it("returns the stable clinical-app denial before a route handler runs", async () => {
    getAuthUser.mockResolvedValue({ id: "research-1", accountKind: "RESEARCH_ONLY" })
    const response = await proxy(new NextRequest("http://localhost/v1/cases"))
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ code: "CLINICAL_APP_FORBIDDEN" })
  })

  it("does not deny the research API", async () => {
    getAuthUser.mockResolvedValue({ id: "research-1", accountKind: "RESEARCH_ONLY" })
    const response = await proxy(new NextRequest("http://localhost/v1/research/query"))
    expect(response.status).toBe(200)
    expect(response.headers.get("x-middleware-next")).toBe("1")
  })
})

describe("browser session CSRF boundary", () => {
  beforeEach(() => {
    getAuthUser.mockReset()
    getAuthUser.mockResolvedValue(null)
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("LOSPOR_WEB_URL", "https://app.lospor.org")
    vi.stubEnv("CORS_ALLOW_ORIGIN", "https://app.lospor.org")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each(["POST", "DELETE"])("rejects cross-site %s on the cookie session route", async method => {
    const response = await proxy(new NextRequest("https://api.lospor.org/v1/auth/session", {
      method,
      headers: { origin: "https://evil.example" },
    }))
    expect(response.status).toBe(403)
  })

  it.each(["POST", "DELETE"])("accepts trusted same-origin %s on the cookie session route", async method => {
    const response = await proxy(new NextRequest("https://api.lospor.org/v1/auth/session", {
      method,
      headers: { origin: "https://app.lospor.org" },
    }))
    expect(response.status).toBe(200)
    expect(response.headers.get("x-middleware-next")).toBe("1")
  })

  it("accepts a trusted Referer when Origin is absent", async () => {
    const response = await proxy(new NextRequest("https://api.lospor.org/v1/auth/session", {
      method: "POST",
      headers: { referer: "https://app.lospor.org/login" },
    }))
    expect(response.status).toBe(200)
  })

  it("does not let a bogus Bearer header bypass session-login origin checks", async () => {
    const response = await proxy(new NextRequest("https://api.lospor.org/v1/auth/session", {
      method: "POST",
      headers: {
        authorization: "Bearer attacker-controlled",
        origin: "https://evil.example",
      },
    }))
    expect(response.status).toBe(403)
  })

  it("keeps the native token endpoint origin-independent", async () => {
    const response = await proxy(new NextRequest("https://api.lospor.org/v1/auth/token", {
      method: "POST",
      headers: { origin: "app://native" },
    }))
    expect(response.status).toBe(200)
  })
})
