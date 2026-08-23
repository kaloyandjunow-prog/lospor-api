import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  jwtVerify: vi.fn(),
  isRevokedAsync: vi.fn(),
  resolveAccount: vi.fn(),
  validateTrackedSession: vi.fn(),
}))

vi.mock("jose", () => ({
  jwtVerify: mocks.jwtVerify,
  SignJWT: class {
    setProtectedHeader() { return this }
    setIssuedAt() { return this }
    setJti() { return this }
    setExpirationTime() { return this }
    sign() { return Promise.resolve("token") }
  },
}))

vi.mock("@/lib/token-blocklist", () => ({
  isRevokedAsync: mocks.isRevokedAsync,
}))

vi.mock("@/lib/password-epoch", () => ({
  resolveAccount: mocks.resolveAccount,
}))
vi.mock("@/lib/auth-sessions", () => ({
  validateTrackedSession: mocks.validateTrackedSession,
}))

import { getAuthUser } from "./mobile-auth"

const originalMfaRequired = process.env.LOSPOR_ADMIN_MFA_REQUIRED

afterEach(() => {
  if (originalMfaRequired === undefined) delete process.env.LOSPOR_ADMIN_MFA_REQUIRED
  else process.env.LOSPOR_ADMIN_MFA_REQUIRED = originalMfaRequired
})

describe("getAuthUser", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.LOSPOR_ADMIN_MFA_REQUIRED
    process.env.NEXTAUTH_SECRET = "test-secret-with-sufficient-length"
    mocks.isRevokedAsync.mockResolvedValue(false)
    mocks.resolveAccount.mockResolvedValue({
      role: "MEMBER",
      accountKind: "CLINICAL",
      preferredLocale: "bg",
      institutionId: null,
      institutionName: null,
      firstName: "Ada",
      lastName: "Lovelace",
      title: "Dr",
    })
    mocks.validateTrackedSession.mockResolvedValue(true)
  })

  it("uses live account state for bearer tokens", async () => {
    mocks.jwtVerify.mockResolvedValue({
      payload: {
        id: "user-1",
        role: "ADMIN",
        institutionId: "old-inst",
        institutionName: "Old Hospital",
        iat: 1_780_000_000,
        jti: "token-1",
      },
    })

    const user = await getAuthUser(new Request("https://api.lospor.org/v1/cases", {
      headers: { authorization: "Bearer abc" },
    }))

    expect(mocks.resolveAccount).toHaveBeenCalledWith("user-1", 1_780_000_000)
    expect(user).toEqual(expect.objectContaining({
      id: "user-1",
      role: "MEMBER",
      accountKind: "CLINICAL",
      preferredLocale: "bg",
      institutionId: null,
      institutionName: null,
      clientType: "NATIVE",
    }))
  })

  it("verifies the API-owned browser cookie through the same token path", async () => {
    mocks.jwtVerify.mockResolvedValue({
      payload: {
        id: "user-1",
        role: "MEMBER",
        firstName: "Ada",
        lastName: "Lovelace",
        title: "Dr",
        iat: 1_780_000_000,
        jti: "cookie-1",
        clientType: "PWA",
      },
    })

    const user = await getAuthUser(new Request("https://app.lospor.org/api/cases", {
      headers: { cookie: "theme=dark; lospor_session=abc" },
    }))

    expect(mocks.jwtVerify).toHaveBeenCalledWith(
      "abc",
      expect.any(Uint8Array),
    )
    expect(user).toEqual(expect.objectContaining({
      id: "user-1",
      firstName: "Ada",
      lastName: "Lovelace",
      jti: "cookie-1",
      clientType: "PWA",
    }))
  })

  it("does not let a request header rewrite the client type in a signed session", async () => {
    mocks.jwtVerify.mockResolvedValue({
      payload: {
        id: "user-1",
        iat: 1_780_000_000,
        jti: "session-1",
        clientType: "WEB",
      },
    })

    const user = await getAuthUser(new Request("https://app.lospor.org/api/cases", {
      headers: {
        cookie: "lospor_session=abc",
        "x-lospor-client": "pwa",
        "x-lospor-source": "ai",
      },
    }))

    expect(user?.clientType).toBe("WEB")
  })

  it("rejects revoked cookie tokens", async () => {
    mocks.jwtVerify.mockResolvedValue({
      payload: { id: "user-1", iat: 1_780_000_000, jti: "cookie-1" },
    })
    mocks.isRevokedAsync.mockResolvedValue(true)

    const user = await getAuthUser(new Request("https://app.lospor.org/api/cases", {
      headers: { cookie: "lospor_session=abc" },
    }))

    expect(user).toBeNull()
    expect(mocks.resolveAccount).not.toHaveBeenCalled()
  })

  it("rejects an administrator token without verified MFA when the deployment requires it", async () => {
    process.env.LOSPOR_ADMIN_MFA_REQUIRED = "true"
    mocks.jwtVerify.mockResolvedValue({
      payload: { id: "admin-1", role: "ADMIN", iat: 1_780_000_000, jti: "admin-token" },
    })
    mocks.resolveAccount.mockResolvedValue({
      role: "ADMIN",
      accountKind: "CLINICAL",
      preferredLocale: "bg",
      institutionId: null,
      institutionName: null,
      firstName: "Ada",
      lastName: "Admin",
      title: "Dr",
    })
    await expect(getAuthUser(new Request("https://api.lospor.org/v1/cases", {
      headers: { authorization: "Bearer abc" },
    }))).resolves.toBeNull()
  })

  it("accepts verified administrator MFA and keeps the disabled public-demo gate non-breaking", async () => {
    mocks.resolveAccount.mockResolvedValue({
      role: "ADMIN",
      accountKind: "CLINICAL",
      preferredLocale: "bg",
      institutionId: null,
      institutionName: null,
      firstName: "Ada",
      lastName: "Admin",
      title: "Dr",
    })
    mocks.jwtVerify.mockResolvedValue({
      payload: {
        id: "admin-1",
        role: "ADMIN",
        iat: 1_780_000_000,
        jti: "admin-token",
        mfaVerified: true,
      },
    })
    process.env.LOSPOR_ADMIN_MFA_REQUIRED = "true"
    await expect(getAuthUser(new Request("https://api.lospor.org/v1/cases", {
      headers: { authorization: "Bearer abc" },
    }))).resolves.toEqual(expect.objectContaining({ id: "admin-1", role: "ADMIN" }))

    delete process.env.LOSPOR_ADMIN_MFA_REQUIRED
    mocks.jwtVerify.mockResolvedValue({
      payload: { id: "admin-1", role: "ADMIN", iat: 1_780_000_000, jti: "legacy-admin-token" },
    })
    await expect(getAuthUser(new Request("https://api.lospor.org/v1/cases", {
      headers: { authorization: "Bearer legacy" },
    }))).resolves.toEqual(expect.objectContaining({ id: "admin-1", role: "ADMIN" }))
  })
})
