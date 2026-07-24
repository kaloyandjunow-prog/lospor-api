import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  jwtVerify: vi.fn(),
  isRevokedAsync: vi.fn(),
  resolveAccount: vi.fn(),
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

import { getAuthUser } from "./mobile-auth"

describe("getAuthUser", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXTAUTH_SECRET = "test-secret-with-sufficient-length"
    mocks.isRevokedAsync.mockResolvedValue(false)
    mocks.resolveAccount.mockResolvedValue({
      role: "MEMBER",
      institutionId: null,
      institutionName: null,
    })
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
      institutionId: null,
      institutionName: null,
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
    }))
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
})
