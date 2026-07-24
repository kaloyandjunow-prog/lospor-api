import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { hashAuthToken, normalizeEmail } from "@/lib/auth-email-tokens"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  after: vi.fn((fn: () => void) => fn()),
  rateLimit: vi.fn(),
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  userUpdate: vi.fn(),
  institutionFindUnique: vi.fn(),
  passwordResetCreate: vi.fn(),
  passwordResetFindUnique: vi.fn(),
  passwordResetUpdate: vi.fn(),
  passwordResetUpdateMany: vi.fn(),
  emailVerificationFindUnique: vi.fn(),
  emailVerificationUpdate: vi.fn(),
  emailVerificationUpdateMany: vi.fn(),
  transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
}))

vi.mock("next/server", async importOriginal => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: mocks.after }
})

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: mocks.rateLimit,
}))

vi.mock("@/lib/mobile-auth", () => ({
  signMobileToken: vi.fn(async () => "test-token"),
}))

vi.mock("@/lib/transactional-email", () => ({
  appUrl: (path: string) => `http://localhost:3000${path}`,
  sendVerificationEmail: mocks.sendVerificationEmail,
  sendPasswordResetEmail: mocks.sendPasswordResetEmail,
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: mocks.userFindUnique,
      create: mocks.userCreate,
      update: mocks.userUpdate,
    },
    institution: {
      findUnique: mocks.institutionFindUnique,
    },
    passwordResetToken: {
      create: mocks.passwordResetCreate,
      findUnique: mocks.passwordResetFindUnique,
      update: mocks.passwordResetUpdate,
      updateMany: mocks.passwordResetUpdateMany,
    },
    emailVerificationToken: {
      findUnique: mocks.emailVerificationFindUnique,
      update: mocks.emailVerificationUpdate,
      updateMany: mocks.emailVerificationUpdateMany,
    },
    $transaction: mocks.transaction,
  },
}))

function jsonRequest(url: string, body: Record<string, unknown>) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify(body),
  }) as NextRequest
}

describe("account email auth flows", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.rateLimit.mockResolvedValue({ allowed: true, retryAfter: 0 })
    mocks.sendVerificationEmail.mockResolvedValue({ sent: false, provider: "none" })
    mocks.sendPasswordResetEmail.mockResolvedValue({ sent: false, provider: "none" })
    mocks.institutionFindUnique.mockResolvedValue({ id: "inst-1" })
  })

  it("registration creates an unverified user and verification token", async () => {
    mocks.userFindUnique.mockResolvedValue(null)
    mocks.userCreate.mockResolvedValue({ id: "user-1", email: "doctor@example.com", name: "Dr Test User" })

    const { POST } = await import("@/app/v1/auth/register/route")
    const res = await POST(jsonRequest("http://localhost/api/auth/register", {
      firstName: "Test",
      lastName: "User",
      title: "Dr",
      email: "doctor@example.com",
      password: "Strong1!",
      acceptedTerms: true,
    }))

    expect(res.status).toBe(201)
    expect(mocks.userCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        emailVerifiedAt: null,
        emailVerificationTokens: {
          create: expect.objectContaining({
            tokenHash: expect.any(String),
            expiresAt: expect.any(Date),
          }),
        },
      }),
    }))
    expect(mocks.sendVerificationEmail).toHaveBeenCalledWith(
      { email: "doctor@example.com", name: "Dr Test User" },
      expect.stringContaining("/verify-email?token="),
    )
  })

  it("normalizeEmail lowercases and trims", () => {
    expect(normalizeEmail("  Doctor@Example.COM ")).toBe("doctor@example.com")
    expect(normalizeEmail("doctor@example.com")).toBe("doctor@example.com")
  })

  it("registration stores the normalized email and checks duplicates case-insensitively", async () => {
    mocks.userFindUnique.mockResolvedValue(null)
    mocks.userCreate.mockResolvedValue({ id: "user-1", email: "doctor@example.com", name: "Dr Test User" })

    const { POST } = await import("@/app/v1/auth/register/route")
    const res = await POST(jsonRequest("http://localhost/api/auth/register", {
      firstName: "Test",
      lastName: "User",
      title: "Dr",
      email: "  Doctor@Example.COM ",
      password: "Strong1!",
      acceptedTerms: true,
    }))

    expect(res.status).toBe(201)
    expect(mocks.userFindUnique).toHaveBeenCalledWith({ where: { email: "doctor@example.com" } })
    expect(mocks.userCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ email: "doctor@example.com" }),
    }))
  })

  it("mobile token login looks up and rate-limits with the normalized email", async () => {
    mocks.userFindUnique.mockResolvedValue(null)

    const { POST } = await import("@/app/v1/auth/token/route")
    const res = await POST(jsonRequest("http://localhost/api/auth/token", {
      email: " DOCTOR@Example.com ",
      password: "whatever1",
    }))

    expect(res.status).toBe(401)
    expect(mocks.userFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: "doctor@example.com" },
    }))
    expect(mocks.rateLimit).toHaveBeenCalledWith("login:doctor@example.com", expect.any(Number), expect.any(Number))
  })

  it("password reset request finds the user regardless of email casing", async () => {
    mocks.userFindUnique.mockResolvedValue({ id: "user-1", email: "doctor@example.com", name: "Doctor", deletedAt: null })
    mocks.passwordResetCreate.mockResolvedValue({ id: "prt-1" })

    const { POST } = await import("@/app/v1/auth/password-reset/request/route")
    const res = await POST(jsonRequest("http://localhost/api/auth/password-reset/request", { email: "DOCTOR@EXAMPLE.COM" }))

    expect(res.status).toBe(200)
    expect(mocks.userFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: "doctor@example.com" },
    }))
    expect(mocks.rateLimit).toHaveBeenCalledWith("password-reset:doctor@example.com", expect.any(Number), expect.any(Number))
  })

  it("password reset request always returns ok while creating a token for real users", async () => {
    mocks.userFindUnique.mockResolvedValue({ id: "user-1", email: "doctor@example.com", name: "Doctor", deletedAt: null })
    mocks.passwordResetCreate.mockResolvedValue({ id: "prt-1" })

    const { POST } = await import("@/app/v1/auth/password-reset/request/route")
    const res = await POST(jsonRequest("http://localhost/api/auth/password-reset/request", { email: "doctor@example.com" }))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
    expect(mocks.passwordResetCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: "user-1", tokenHash: expect.any(String), expiresAt: expect.any(Date) }),
    }))
    expect(mocks.sendPasswordResetEmail).toHaveBeenCalled()
  })

  it("password reset confirm updates the password and consumes all active reset tokens", async () => {
    const token = "reset-token-12345678901234567890"
    mocks.passwordResetFindUnique.mockResolvedValue({
      id: "prt-1",
      userId: "user-1",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { deletedAt: null },
    })
    mocks.userUpdate.mockResolvedValue({})
    mocks.passwordResetUpdate.mockResolvedValue({})
    mocks.passwordResetUpdateMany.mockResolvedValue({ count: 1 })

    const { POST } = await import("@/app/v1/auth/password-reset/confirm/route")
    const res = await POST(jsonRequest("http://localhost/api/auth/password-reset/confirm", {
      token,
      password: "NewStrong1!",
    }))

    expect(res.status).toBe(200)
    expect(mocks.passwordResetFindUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashAuthToken(token) },
      include: { user: true },
    })
    expect(mocks.userUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "user-1" },
      // passwordChangedAt is the token-revocation epoch (v5.1): sessions and
      // mobile JWTs issued before it are rejected after a reset.
      data: { passwordHash: expect.any(String), passwordChangedAt: expect.any(Date) },
    }))
    expect(mocks.passwordResetUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "user-1", usedAt: null, id: { not: "prt-1" } },
    }))
  })

  it("email verification marks the user verified and consumes active verification tokens", async () => {
    const token = "verify-token-12345678901234567890"
    mocks.emailVerificationFindUnique.mockResolvedValue({
      id: "evt-1",
      userId: "user-1",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: { deletedAt: null, emailVerifiedAt: null },
    })
    mocks.userUpdate.mockResolvedValue({})
    mocks.emailVerificationUpdate.mockResolvedValue({})
    mocks.emailVerificationUpdateMany.mockResolvedValue({ count: 1 })

    const { GET } = await import("@/app/v1/auth/verify-email/route")
    const res = await GET(new NextRequest(`http://localhost/api/auth/verify-email?token=${token}`))

    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe("http://localhost/verify-email?status=verified")
    expect(mocks.emailVerificationFindUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashAuthToken(token) },
      include: { user: true },
    })
    expect(mocks.userUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "user-1" },
      data: { emailVerifiedAt: expect.any(Date), approvedAt: expect.any(Date) },
    }))
  })
})
