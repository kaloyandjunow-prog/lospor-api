import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  getAuthUser: vi.fn(),
  authTokenFromRequest: vi.fn(),
  revokeTrackedSession: vi.fn(),
  revokeToken: vi.fn(),
}))

vi.mock("@/lib/mobile-auth", () => ({
  AUTH_COOKIE_NAME: "lospor_session",
  AUTH_TOKEN_TTL_SECONDS: 28_800,
  getAuthUser: mocks.getAuthUser,
  authTokenFromRequest: mocks.authTokenFromRequest,
  signMobileToken: vi.fn(),
}))
vi.mock("@/lib/auth-sessions", () => ({
  revokeTrackedSession: mocks.revokeTrackedSession,
  createAuthSessionInTransaction: vi.fn(),
  normalizeDeviceLabel: (_value: unknown, fallback: string) => fallback,
}))
vi.mock("@/lib/token-blocklist", () => ({ revokeToken: mocks.revokeToken }))
vi.mock("@/lib/credentials", () => ({ verifyCredentials: vi.fn() }))
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn() }))
vi.mock("@/lib/password-epoch", () => ({ invalidateAccountState: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: vi.fn() }, $transaction: vi.fn() },
}))

type LogoutCall = (request: NextRequest) => Promise<Response>

async function endpoints(): Promise<Array<[string, LogoutCall]>> {
  const [{ POST }, { DELETE }] = await Promise.all([
    import("./logout/route"),
    import("./session/route"),
  ])
  return [
    ["POST /v1/auth/logout", POST],
    ["DELETE /v1/auth/session", DELETE],
  ]
}

function request(method: string) {
  return new NextRequest("https://api.lospor.org/v1/auth/logout", {
    method,
    headers: { cookie: "lospor_session=signed" },
  })
}

function expectExpiredCookie(response: Response) {
  const cookie = response.headers.get("set-cookie") ?? ""
  expect(cookie).toContain("lospor_session=")
  expect(cookie.toLowerCase()).toContain("max-age=0")
}

describe("logout revocation semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAuthUser.mockResolvedValue({ id: "user-1", jti: "jti-1" })
    mocks.authTokenFromRequest.mockReturnValue("signed")
    mocks.revokeTrackedSession.mockResolvedValue(true)
    mocks.revokeToken.mockResolvedValue(true)
  })

  it("reports success only after tracked or legacy revocation is durable", async () => {
    for (const [name, call] of await endpoints()) {
      mocks.revokeTrackedSession.mockResolvedValueOnce(name.startsWith("POST"))
      mocks.revokeToken.mockResolvedValueOnce(!name.startsWith("POST"))
      const response = await call(request(name.startsWith("POST") ? "POST" : "DELETE"))
      expect(response.status, name).toBe(200)
      expectExpiredCookie(response)
    }
  })

  it("returns non-2xx but still expires the cookie when persistence is unconfirmed", async () => {
    mocks.revokeTrackedSession.mockResolvedValue(false)
    mocks.revokeToken.mockResolvedValue(false)
    for (const [name, call] of await endpoints()) {
      const response = await call(request(name.startsWith("POST") ? "POST" : "DELETE"))
      expect(response.status, name).toBe(503)
      expectExpiredCookie(response)
    }
  })

  it("expires the cookie even when session-ledger revocation throws", async () => {
    mocks.revokeTrackedSession.mockRejectedValue(new Error("database unavailable"))
    for (const [name, call] of await endpoints()) {
      const response = await call(request(name.startsWith("POST") ? "POST" : "DELETE"))
      expect(response.status, name).toBe(503)
      expectExpiredCookie(response)
    }
  })

  it("is idempotent when there is no credential to revoke", async () => {
    mocks.getAuthUser.mockResolvedValue(null)
    mocks.authTokenFromRequest.mockReturnValue(null)
    for (const [name, call] of await endpoints()) {
      const response = await call(request(name.startsWith("POST") ? "POST" : "DELETE"))
      expect(response.status, name).toBe(200)
      expectExpiredCookie(response)
    }
  })
})
