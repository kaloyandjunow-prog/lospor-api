import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  verifyCredentials: vi.fn(),
  rateLimit: vi.fn(),
  update: vi.fn(),
  signMobileToken: vi.fn(),
  invalidate: vi.fn(),
  createSession: vi.fn(),
  beginMfa: vi.fn(),
}))

vi.mock("@/lib/credentials", () => ({ verifyCredentials: mocks.verifyCredentials }))
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { update: mocks.update },
    $transaction: (run: (tx: unknown) => unknown) => run({ user: { update: mocks.update } }),
  },
}))
vi.mock("@/lib/auth-sessions", () => ({
  createAuthSessionInTransaction: mocks.createSession,
  normalizeDeviceLabel: (value: unknown, fallback: string) => typeof value === "string" && value ? value : fallback,
  revokeTrackedSession: vi.fn(),
}))
vi.mock("@/lib/mobile-auth", () => ({
  AUTH_COOKIE_NAME: "lospor_session",
  AUTH_TOKEN_TTL_SECONDS: 28_800,
  signMobileToken: mocks.signMobileToken,
  getAuthUser: vi.fn(),
}))
vi.mock("@/lib/password-epoch", () => ({ invalidateAccountState: mocks.invalidate }))
vi.mock("@/lib/token-blocklist", () => ({ revokeToken: vi.fn() }))
vi.mock("@/lib/administrator-mfa", () => ({
  administratorMfaRequired: (role: string) => process.env.LOSPOR_ADMIN_MFA_REQUIRED === "true" && role === "ADMIN",
  beginAdministratorMfaLogin: mocks.beginMfa,
  MfaConfigurationError: class MfaConfigurationError extends Error {
    readonly code = "MFA_CONFIGURATION_UNAVAILABLE"
  },
}))

const originalMfaRequired = process.env.LOSPOR_ADMIN_MFA_REQUIRED
const originalDeploymentMode = process.env.LOSPOR_DEPLOYMENT_MODE
const originalAccountAdministration = process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED

afterAll(() => {
  if (originalMfaRequired === undefined) delete process.env.LOSPOR_ADMIN_MFA_REQUIRED
  else process.env.LOSPOR_ADMIN_MFA_REQUIRED = originalMfaRequired
  if (originalDeploymentMode === undefined) delete process.env.LOSPOR_DEPLOYMENT_MODE
  else process.env.LOSPOR_DEPLOYMENT_MODE = originalDeploymentMode
  if (originalAccountAdministration === undefined) delete process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED
  else process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED = originalAccountAdministration
})

const account = {
  id: "user-1",
  email: "doctor@example.test",
  username: null,
  name: "Doctor",
  firstName: "Test",
  lastName: "Doctor",
  title: "Dr",
  role: "MEMBER",
  accountKind: "CLINICAL",
  institutionId: "inst-1",
  institution: { name: "Hospital" },
  acceptedTermsAt: null,
  lastLoginAt: null,
  preferences: { theme: "dark", ui: { density: "compact", locale: "bg" } },
  legalAcceptances: [],
}

function request(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify(body),
  })
}

function pwaRequest(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "127.0.0.1",
      "x-lospor-client": "pwa",
    },
    body: JSON.stringify(body),
  })
}

describe("atomic login locale persistence", () => {
  beforeEach(() => {
    delete process.env.LOSPOR_ADMIN_MFA_REQUIRED
    delete process.env.LOSPOR_DEPLOYMENT_MODE
    delete process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED
    vi.clearAllMocks()
    mocks.verifyCredentials.mockResolvedValue(account)
    mocks.rateLimit.mockResolvedValue({ allowed: true })
    mocks.update.mockResolvedValue({})
    mocks.signMobileToken.mockResolvedValue("signed-token")
    mocks.beginMfa.mockResolvedValue({
      code: "MFA_REQUIRED",
      challengeToken: "challenge-token",
      expiresIn: 300,
      enrollmentRequired: false,
    })
  })

  it("persists an explicit browser login choice without losing other preferences", async () => {
    const { POST } = await import("@/app/v1/auth/session/route")
    const response = await POST(request("/v1/auth/session", {
      email: account.email,
      password: "secret",
      locale: "en",
    }))
    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        preferences: {
          theme: "dark",
          ui: { density: "compact", locale: "en" },
        },
      }),
    }))
    expect(mocks.signMobileToken).toHaveBeenCalledWith(expect.objectContaining({
      accountKind: "CLINICAL",
      preferredLocale: "en",
    }))
    await expect(response.json()).resolves.toMatchObject({ user: { preferredLocale: "en" } })
    expect(mocks.invalidate).toHaveBeenCalledWith("user-1")
  })

  it("persists an explicit native login choice in the same flow", async () => {
    const { POST } = await import("@/app/v1/auth/token/route")
    const response = await POST(request("/v1/auth/token", {
      email: account.email,
      password: "secret",
      locale: "en",
    }))
    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ preferences: expect.objectContaining({ ui: expect.objectContaining({ locale: "en" }) }) }),
    }))
    expect(mocks.signMobileToken).toHaveBeenCalledWith(expect.objectContaining({ preferredLocale: "en" }))
    await expect(response.json()).resolves.toMatchObject({ preferredLocale: "en" })
  })

  it("binds the PWA identity to the issued cookie session and token", async () => {
    const { POST } = await import("@/app/v1/auth/session/route")
    const response = await POST(pwaRequest("/v1/auth/session", {
      email: account.email,
      password: "secret",
      locale: "bg",
    }))

    expect(response.status).toBe(200)
    expect(mocks.signMobileToken).toHaveBeenCalledWith(expect.objectContaining({ clientType: "PWA" }))
    expect(mocks.createSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ clientType: "PWA" }),
    )
  })

  it("preserves the account preference when the client reports no explicit choice", async () => {
    const { POST } = await import("@/app/v1/auth/session/route")
    await POST(request("/v1/auth/session", { email: account.email, password: "secret" }))
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { lastLoginAt: expect.any(Date) },
    }))
    expect(mocks.invalidate).not.toHaveBeenCalled()
    expect(mocks.signMobileToken).toHaveBeenCalledWith(expect.objectContaining({ preferredLocale: "bg" }))
  })

  it("returns the existing account preference from native login when locale is omitted", async () => {
    const { POST } = await import("@/app/v1/auth/token/route")
    const response = await POST(request("/v1/auth/token", {
      email: account.email,
      password: "secret",
    }))
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { lastLoginAt: expect.any(Date) },
    }))
    expect(mocks.invalidate).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({ preferredLocale: "bg" })
  })

  it.each([
    ["browser", "/v1/auth/session"],
    ["native", "/v1/auth/token"],
  ] as const)("uses only a case-insensitive username in trusted Hospital %s login", async (_name, path) => {
    process.env.LOSPOR_DEPLOYMENT_MODE = "hospital"
    process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED = "true"
    mocks.verifyCredentials.mockResolvedValue({ ...account, username: "Dr.Smith" })
    const route = path.endsWith("token")
      ? await import("@/app/v1/auth/token/route")
      : await import("@/app/v1/auth/session/route")
    const response = await route.POST(request(path, {
      username: "Dr.Smith",
      password: "secret",
    }))

    expect(response.status).toBe(200)
    expect(mocks.verifyCredentials).toHaveBeenCalledWith(
      { kind: "USERNAME", canonical: "dr.smith" },
      "secret",
    )
    const identityRateKey = mocks.rateLimit.mock.calls[0][0] as string
    expect(identityRateKey).toMatch(/^login-identity:v1:[0-9a-f]{64}$/)
    expect(identityRateKey).not.toContain("dr.smith")
  })

  it.each([
    ["public email login", {}, { username: "Dr.Smith", password: "secret" }],
    ["Hospital email fallback", { hospital: true }, { email: account.email, password: "secret" }],
    ["Hospital dual identifier", { hospital: true }, { username: "Dr.Smith", email: account.email, password: "secret" }],
    ["Hospital username whitespace", { hospital: true }, { username: " Dr.Smith ", password: "secret" }],
    ["Hospital full-width username", { hospital: true }, { username: "ＤｒSmith", password: "secret" }],
  ])("rejects identifier crossover for %s", async (_name, configuration, body) => {
    if ("hospital" in configuration) {
      process.env.LOSPOR_DEPLOYMENT_MODE = "hospital"
      process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED = "true"
    }
    const { POST } = await import("@/app/v1/auth/session/route")
    const response = await POST(request("/v1/auth/session", body))
    expect(response.status).toBe(400)
    expect(mocks.verifyCredentials).not.toHaveBeenCalled()
    expect(mocks.rateLimit).not.toHaveBeenCalled()
  })

  it("fails closed instead of reverting to email when Hospital trust configuration is partial", async () => {
    process.env.LOSPOR_DEPLOYMENT_MODE = "hospital"
    delete process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED
    const { POST } = await import("@/app/v1/auth/session/route")
    const response = await POST(request("/v1/auth/session", {
      email: account.email,
      password: "secret",
    }))
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      code: "AUTHENTICATION_DEPLOYMENT_UNAVAILABLE",
    })
    expect(mocks.verifyCredentials).not.toHaveBeenCalled()
  })

  it.each([
    ["browser", "/v1/auth/session", "WEB"],
    ["native", "/v1/auth/token", "NATIVE"],
  ] as const)("requires the Hospital administrator %s second factor before issuing a session", async (_name, path, clientType) => {
    process.env.LOSPOR_ADMIN_MFA_REQUIRED = "true"
    mocks.verifyCredentials.mockResolvedValue({ ...account, role: "ADMIN" })
    const route = path.endsWith("token")
      ? await import("@/app/v1/auth/token/route")
      : await import("@/app/v1/auth/session/route")
    const response = await route.POST(request(path, {
      email: account.email,
      password: "secret",
    }))
    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({
      code: "MFA_REQUIRED",
      mfa: {
        code: "MFA_REQUIRED",
        challengeToken: "challenge-token",
        expiresIn: 300,
        enrollmentRequired: false,
      },
    })
    expect(mocks.beginMfa).toHaveBeenCalledWith(expect.objectContaining({ clientType }))
    expect(mocks.signMobileToken).not.toHaveBeenCalled()
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it("preserves PWA identity in the Hospital administrator MFA continuation", async () => {
    process.env.LOSPOR_ADMIN_MFA_REQUIRED = "true"
    mocks.verifyCredentials.mockResolvedValue({ ...account, role: "ADMIN" })
    const { POST } = await import("@/app/v1/auth/session/route")
    const response = await POST(pwaRequest("/v1/auth/session", {
      email: account.email,
      password: "secret",
    }))

    expect(response.status).toBe(202)
    expect(mocks.beginMfa).toHaveBeenCalledWith(expect.objectContaining({ clientType: "PWA" }))
  })

  it.each([
    ["browser", "/v1/auth/session"],
    ["native", "/v1/auth/token"],
  ] as const)("fails the administrator %s login closed when the MFA key is unavailable", async (_name, path) => {
    process.env.LOSPOR_ADMIN_MFA_REQUIRED = "true"
    mocks.verifyCredentials.mockResolvedValue({ ...account, role: "ADMIN" })
    const { MfaConfigurationError } = await import("@/lib/administrator-mfa")
    mocks.beginMfa.mockRejectedValue(new MfaConfigurationError("unavailable"))
    const route = path.endsWith("token")
      ? await import("@/app/v1/auth/token/route")
      : await import("@/app/v1/auth/session/route")
    const response = await route.POST(request(path, {
      email: account.email,
      password: "secret",
    }))
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ code: "MFA_CONFIGURATION_UNAVAILABLE" })
    expect(mocks.signMobileToken).not.toHaveBeenCalled()
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it.each([
    ["browser", "/v1/auth/session"],
    ["native", "/v1/auth/token"],
  ] as const)("keeps the public-demo administrator %s login one-step when MFA is not enabled", async (_name, path) => {
    delete process.env.LOSPOR_ADMIN_MFA_REQUIRED
    mocks.verifyCredentials.mockResolvedValue({ ...account, role: "ADMIN" })
    const route = path.endsWith("token")
      ? await import("@/app/v1/auth/token/route")
      : await import("@/app/v1/auth/session/route")
    const response = await route.POST(request(path, {
      email: account.email,
      password: "secret",
    }))
    expect(response.status).toBe(200)
    expect(mocks.beginMfa).not.toHaveBeenCalled()
    expect(mocks.signMobileToken).toHaveBeenCalledOnce()
    expect(mocks.createSession).toHaveBeenCalledOnce()
  })
})
