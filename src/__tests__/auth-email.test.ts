import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { hashAuthToken, normalizeEmail } from "@/lib/auth-email-tokens"
import { createHash } from "node:crypto"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  after: vi.fn((fn: () => void) => fn()),
  rateLimit: vi.fn(),
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  userUpdate: vi.fn(),
  userUpdateMany: vi.fn(),
  legalAcceptanceCreateMany: vi.fn(),
  institutionFindUnique: vi.fn(),
  passwordResetCreate: vi.fn(),
  passwordResetFindUnique: vi.fn(),
  passwordResetUpdate: vi.fn(),
  passwordResetUpdateMany: vi.fn(),
  authSessionUpdateMany: vi.fn(),
  auditCreate: vi.fn(),
  emailVerificationFindUnique: vi.fn(),
  emailVerificationCreate: vi.fn(),
  emailVerificationUpdate: vi.fn(),
  emailVerificationUpdateMany: vi.fn(),
  transaction: vi.fn(),
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
      updateMany: mocks.userUpdateMany,
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

const legalManifest = {
  deployment: "test",
  documents: (["bg", "en"] as const).flatMap(locale => (["TERMS", "PRIVACY"] as const).map(kind => ({
    deployment: "test",
    kind,
    version: kind === "TERMS" ? "5" : "3",
    effectiveDate: "2026-09-01",
    locale,
    content: `${locale}-${kind}`,
  }))),
}

const originalDeploymentMode = process.env.LOSPOR_DEPLOYMENT_MODE
const originalAccountAdministration = process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED
const originalSelfRegistration = process.env.LOSPOR_SELF_REGISTRATION_ENABLED

afterAll(() => {
  if (originalDeploymentMode === undefined) delete process.env.LOSPOR_DEPLOYMENT_MODE
  else process.env.LOSPOR_DEPLOYMENT_MODE = originalDeploymentMode
  if (originalAccountAdministration === undefined) delete process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED
  else process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED = originalAccountAdministration
  if (originalSelfRegistration === undefined) delete process.env.LOSPOR_SELF_REGISTRATION_ENABLED
  else process.env.LOSPOR_SELF_REGISTRATION_ENABLED = originalSelfRegistration
})

function legalReferences(locale: "bg" | "en") {
  return legalManifest.documents
    .filter(document => document.locale === locale)
    .map(document => ({
      deployment: document.deployment,
      kind: document.kind,
      version: document.version,
      effectiveDate: document.effectiveDate,
      locale: document.locale,
      contentSha256: createHash("sha256").update(document.content).digest("hex"),
    }))
}

describe("account email auth flows", () => {
  beforeEach(() => {
    delete process.env.LOSPOR_DEPLOYMENT_MODE
    delete process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED
    delete process.env.LOSPOR_SELF_REGISTRATION_ENABLED
    vi.clearAllMocks()
    mocks.rateLimit.mockResolvedValue({ allowed: true, retryAfter: 0 })
    mocks.sendVerificationEmail.mockResolvedValue({ sent: false, provider: "none" })
    mocks.sendPasswordResetEmail.mockResolvedValue({ sent: false, provider: "none" })
    mocks.institutionFindUnique.mockResolvedValue({ id: "inst-1" })
    mocks.legalAcceptanceCreateMany.mockResolvedValue({ count: 2 })
    mocks.transaction.mockImplementation(async (operation: unknown) => {
      if (typeof operation === "function") {
        return (operation as (tx: unknown) => Promise<unknown>)({
          user: {
            create: mocks.userCreate,
            update: mocks.userUpdate,
            updateMany: mocks.userUpdateMany,
          },
          legalAcceptance: { createMany: mocks.legalAcceptanceCreateMany },
          passwordResetToken: {
            create: mocks.passwordResetCreate,
            update: mocks.passwordResetUpdate,
            updateMany: mocks.passwordResetUpdateMany,
          },
          authSession: { updateMany: mocks.authSessionUpdateMany },
          emailVerificationToken: {
            create: mocks.emailVerificationCreate,
            update: mocks.emailVerificationUpdate,
            updateMany: mocks.emailVerificationUpdateMany,
          },
          auditLog: { create: mocks.auditCreate },
        })
      }
      return Promise.all(operation as Promise<unknown>[])
    })
    process.env.LOSPOR_LEGAL_DOCUMENTS_JSON = JSON.stringify(legalManifest)
    mocks.userUpdateMany.mockResolvedValue({ count: 1 })
    mocks.passwordResetUpdateMany.mockResolvedValue({ count: 1 })
    mocks.authSessionUpdateMany.mockResolvedValue({ count: 0 })
    mocks.emailVerificationUpdateMany.mockResolvedValue({ count: 1 })
    mocks.auditCreate.mockResolvedValue({})
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
      // Registration requires an institution now; "Без институция" is the
      // one for clinicians with no department.
      institutionId: "no-institution",
      locale: "bg",
      legalAcceptances: legalReferences("bg"),
    }))

    expect(res.status).toBe(201)
    expect(mocks.userCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        role: "MEMBER",
        accountKind: "CLINICAL",
        emailVerifiedAt: null,
        preferences: expect.objectContaining({ ui: expect.objectContaining({ locale: "bg" }) }),
        emailVerificationTokens: {
          create: expect.objectContaining({
            tokenHash: expect.any(String),
            expiresAt: expect.any(Date),
          }),
        },
      }),
    }))
    expect(mocks.legalAcceptanceCreateMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ kind: "TERMS", deployment: "test", locale: "BG" }),
        expect.objectContaining({ kind: "PRIVACY", deployment: "test", locale: "BG" }),
      ]),
    })
    expect(mocks.sendVerificationEmail).toHaveBeenCalledWith(
      { email: "doctor@example.com", name: "Dr Test User" },
      expect.stringContaining("/verify-email?token="),
    )
    expect(mocks.auditCreate).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        userId: "user-1",
        action: "ACCOUNT_PROVISION",
        entityId: "user-1",
        detail: expect.objectContaining({ provisioningChannel: "SELF_REGISTRATION" }),
      }),
    })
    expect(mocks.auditCreate).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        action: "LEGAL_ACCEPTANCE_RECORD",
        detail: expect.objectContaining({ documents: expect.any(Array) }),
      }),
    })
    const auditJson = JSON.stringify(mocks.auditCreate.mock.calls)
    expect(auditJson).not.toContain("Strong1!")
    expect(auditJson).not.toContain("doctor@example.com")
  })

  it("requires an institution before creating a public-demo account", async () => {
    const { POST } = await import("@/app/v1/auth/register/route")
    const res = await POST(jsonRequest("http://localhost/api/auth/register", {
      firstName: "Test",
      lastName: "User",
      email: "doctor@example.com",
      password: "Strong1!",
      locale: "bg",
      legalAcceptances: legalReferences("bg"),
    }))

    expect(res.status).toBe(400)
    expect(mocks.userCreate).not.toHaveBeenCalled()
  })

  it("rejects legal evidence that is not the server-active exact document set", async () => {
    mocks.userFindUnique.mockResolvedValue(null)
    mocks.userCreate.mockResolvedValue({ id: "user-1", email: "doctor@example.com", name: "Doctor" })
    const substituted = legalReferences("bg")
    substituted[0] = { ...substituted[0], contentSha256: "0".repeat(64) }

    const { POST } = await import("@/app/v1/auth/register/route")
    const res = await POST(jsonRequest("http://localhost/api/auth/register", {
      firstName: "Test",
      lastName: "User",
      email: "doctor@example.com",
      password: "Strong1!",
      institutionId: "inst-1",
      locale: "bg",
      legalAcceptances: substituted,
    }))

    expect(res.status).toBe(422)
    expect(mocks.legalAcceptanceCreateMany).not.toHaveBeenCalled()
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
      // Registration requires an institution now; "Без институция" is the
      // one for clinicians with no department.
      institutionId: "no-institution",
      locale: "bg",
      legalAcceptances: legalReferences("bg"),
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
    const identityRateKey = mocks.rateLimit.mock.calls[0][0] as string
    expect(identityRateKey).toMatch(/^login-identity:v1:[0-9a-f]{64}$/)
    expect(identityRateKey).not.toContain("doctor@example.com")
  })

  it("password reset request finds the user regardless of email casing", async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: "user-1",
      email: "doctor@example.com",
      name: "Doctor",
      deletedAt: null,
      suspendedAt: null,
      anonymizedAt: null,
    })
    mocks.passwordResetCreate.mockResolvedValue({ id: "prt-1" })

    const { POST } = await import("@/app/v1/auth/password-reset/request/route")
    const res = await POST(jsonRequest("http://localhost/api/auth/password-reset/request", { email: "DOCTOR@EXAMPLE.COM" }))

    expect(res.status).toBe(202)
    expect(mocks.userFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: "doctor@example.com" },
    }))
    expect(mocks.rateLimit).toHaveBeenCalledWith("password-reset:doctor@example.com", expect.any(Number), expect.any(Number))
  })

  it("password reset request always returns ok while creating a token for real users", async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: "user-1",
      email: "doctor@example.com",
      name: "Doctor",
      deletedAt: null,
      suspendedAt: null,
      anonymizedAt: null,
    })
    mocks.passwordResetCreate.mockResolvedValue({ id: "prt-1" })

    const { POST } = await import("@/app/v1/auth/password-reset/request/route")
    const res = await POST(jsonRequest("http://localhost/api/auth/password-reset/request", { email: "doctor@example.com" }))

    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({ ok: true })
    expect(mocks.passwordResetCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: "user-1", tokenHash: expect.any(String), expiresAt: expect.any(Date) }),
    }))
    expect(mocks.sendPasswordResetEmail).toHaveBeenCalled()
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        action: "PASSWORD_RECOVERY_TOKEN_ISSUE",
        entityId: "user-1",
        detail: { replacedActiveTokenCount: 1 },
      },
    })
  })

  // HAUD_ROLLBACK:password-recovery-link-issue
  it("does not send a recovery link when its durable audit row fails", async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: "user-1",
      email: "doctor@example.com",
      name: "Doctor",
      deletedAt: null,
      suspendedAt: null,
      anonymizedAt: null,
    })
    mocks.passwordResetCreate.mockResolvedValue({ id: "prt-1" })
    mocks.auditCreate.mockRejectedValueOnce(new Error("audit unavailable"))

    const { POST } = await import("@/app/v1/auth/password-reset/request/route")
    await expect(POST(jsonRequest(
      "http://localhost/api/auth/password-reset/request",
      { email: "doctor@example.com" },
    ))).rejects.toThrow("audit unavailable")
    expect(mocks.sendPasswordResetEmail).not.toHaveBeenCalled()
  })

  it("returns the exact same generic 202 response for known and unknown addresses", async () => {
    const { POST } = await import("@/app/v1/auth/password-reset/request/route")
    mocks.userFindUnique.mockResolvedValueOnce({
      id: "user-1",
      email: "doctor@example.com",
      name: "Doctor",
      deletedAt: null,
      suspendedAt: null,
      anonymizedAt: null,
    }).mockResolvedValueOnce(null)

    const known = await POST(jsonRequest(
      "http://localhost/api/auth/password-reset/request",
      { email: "doctor@example.com" },
    ))
    const unknown = await POST(jsonRequest(
      "http://localhost/api/auth/password-reset/request",
      { email: "unknown@example.com" },
    ))

    expect(known.status).toBe(202)
    expect(unknown.status).toBe(202)
    expect(await known.json()).toEqual({ ok: true })
    expect(await unknown.json()).toEqual({ ok: true })
  })

  it("password reset confirm updates the password and consumes all active reset tokens", async () => {
    const token = "reset-token-12345678901234567890"
    mocks.passwordResetFindUnique.mockResolvedValue({
      id: "prt-1",
      userId: "user-1",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        deletedAt: null,
        anonymizedAt: null,
        passwordHash: "$2b$12$8Hgfmzh/eT3wO6GKKkEPoeC6rP9R5wI8M97v53FtBfe8chBgTrHpy",
      },
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
    expect(mocks.userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "user-1" }),
      // passwordChangedAt is the token-revocation epoch (v5.1): sessions and
      // mobile JWTs issued before it are rejected after a reset.
      data: expect.objectContaining({
        passwordHash: expect.any(String),
        passwordChangedAt: expect.any(Date),
        recoveryRequiredAt: null,
      }),
    }))
    expect(mocks.passwordResetUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "user-1", usedAt: null },
    }))
  })

  // HAUD_ROLLBACK:password-recovery-complete
  it("does not report a completed recovery when its durable audit row fails", async () => {
    const token = "reset-token-audit-failure-1234567890"
    mocks.passwordResetFindUnique.mockResolvedValue({
      id: "prt-1",
      userId: "user-1",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        deletedAt: null,
        anonymizedAt: null,
        passwordHash: "$2b$12$8Hgfmzh/eT3wO6GKKkEPoeC6rP9R5wI8M97v53FtBfe8chBgTrHpy",
      },
    })
    mocks.auditCreate.mockRejectedValueOnce(new Error("audit unavailable"))

    const { POST } = await import("@/app/v1/auth/password-reset/confirm/route")
    await expect(POST(jsonRequest("http://localhost/api/auth/password-reset/confirm", {
      token,
      password: "NewStrong1!",
    }))).rejects.toThrow("audit unavailable")
  })

  it("allows exactly one of two concurrent reset confirmations to claim the token", async () => {
    const token = "concurrent-reset-token-1234567890"
    mocks.passwordResetFindUnique.mockResolvedValue({
      id: "prt-concurrent",
      userId: "user-1",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        deletedAt: null,
        anonymizedAt: null,
        passwordHash: "$2b$12$8Hgfmzh/eT3wO6GKKkEPoeC6rP9R5wI8M97v53FtBfe8chBgTrHpy",
      },
    })
    let claimed = false
    mocks.passwordResetUpdateMany.mockImplementation(async (args: { where: { id?: string } }) => {
      if (args.where.id) {
        if (claimed) return { count: 0 }
        claimed = true
      }
      return { count: 1 }
    })

    const { POST } = await import("@/app/v1/auth/password-reset/confirm/route")
    const responses = await Promise.all([
      POST(jsonRequest("http://localhost/api/auth/password-reset/confirm", {
        token,
        password: "Concurrent2!",
      })),
      POST(jsonRequest("http://localhost/api/auth/password-reset/confirm", {
        token,
        password: "Concurrent2!",
      })),
    ])

    expect(responses.map(response => response.status).sort()).toEqual([200, 400])
    expect(mocks.userUpdateMany).toHaveBeenCalledTimes(1)
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1)
  })

  it("email verification marks the user verified and consumes active verification tokens", async () => {
    const token = "verify-token-12345678901234567890"
    mocks.emailVerificationFindUnique.mockResolvedValue({
      id: "evt-1",
      userId: "user-1",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        deletedAt: null,
        suspendedAt: null,
        anonymizedAt: null,
        activatedAt: null,
        emailVerifiedAt: null,
      },
    })
    mocks.userUpdate.mockResolvedValue({})
    mocks.emailVerificationUpdate.mockResolvedValue({})
    mocks.emailVerificationUpdateMany.mockResolvedValue({ count: 1 })

    const { GET } = await import("@/app/v1/auth/verify-email/route")
    const res = await GET(new NextRequest(`http://localhost/api/auth/verify-email?token=${token}`))

    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toBe("http://localhost:3000/verify-email?status=verified")
    expect(mocks.emailVerificationFindUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashAuthToken(token) },
      include: { user: true },
    })
    expect(mocks.userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "user-1" }),
      data: {
        emailVerifiedAt: expect.any(Date),
        activatedAt: expect.any(Date),
      },
    }))
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        action: "ACCOUNT_ACTIVATE",
        entityId: "user-1",
        detail: { activationMethod: "EMAIL_VERIFICATION" },
      },
    })
  })

  // HAUD_ROLLBACK:public-email-activation
  it("does not report activation when its durable audit row fails", async () => {
    const token = "verify-token-audit-failure-123456789"
    mocks.emailVerificationFindUnique.mockResolvedValue({
      id: "evt-1",
      userId: "user-1",
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        deletedAt: null,
        suspendedAt: null,
        anonymizedAt: null,
        activatedAt: null,
        emailVerifiedAt: null,
      },
    })
    mocks.auditCreate.mockRejectedValueOnce(new Error("audit unavailable"))

    const { GET } = await import("@/app/v1/auth/verify-email/route")
    await expect(GET(new NextRequest(
      `http://localhost/api/auth/verify-email?token=${token}`,
    ))).rejects.toThrow("audit unavailable")
  })

  it("reissues an activation link and its audit evidence in one transaction", async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: "user-1",
      email: "doctor@example.com",
      name: "Doctor",
      emailVerifiedAt: null,
      deletedAt: null,
    })
    mocks.emailVerificationCreate.mockResolvedValue({ id: "evt-2" })

    const { POST } = await import("@/app/v1/auth/verify-email/resend/route")
    const response = await POST(jsonRequest(
      "http://localhost/api/auth/verify-email/resend",
      { email: "doctor@example.com" },
    ))

    expect(response.status).toBe(200)
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        action: "ACCOUNT_ACTIVATION_TOKEN_REISSUE",
        entityId: "user-1",
        detail: { replacedActiveTokenCount: 1 },
      },
    })
    const auditJson = JSON.stringify(mocks.auditCreate.mock.calls)
    expect(auditJson).not.toContain("doctor@example.com")
    expect(auditJson).not.toContain("tokenHash")
  })

  // HAUD_ROLLBACK:public-activation-link-reissue
  it("does not send a reissued activation link when its audit row fails", async () => {
    mocks.userFindUnique.mockResolvedValue({
      id: "user-1",
      email: "doctor@example.com",
      name: "Doctor",
      emailVerifiedAt: null,
      deletedAt: null,
    })
    mocks.emailVerificationCreate.mockResolvedValue({ id: "evt-2" })
    mocks.auditCreate.mockRejectedValueOnce(new Error("audit unavailable"))

    const { POST } = await import("@/app/v1/auth/verify-email/resend/route")
    await expect(POST(jsonRequest(
      "http://localhost/api/auth/verify-email/resend",
      { email: "doctor@example.com" },
    ))).rejects.toThrow("audit unavailable")
    expect(mocks.sendVerificationEmail).not.toHaveBeenCalled()
  })

  // HAUD_ROLLBACK:public-account-registration
  it("does not send registration mail when durable audit evidence cannot be written", async () => {
    mocks.userFindUnique.mockResolvedValue(null)
    mocks.userCreate.mockResolvedValue({ id: "user-1", email: "doctor@example.com", name: "Doctor" })
    mocks.auditCreate.mockRejectedValueOnce(new Error("audit unavailable"))

    const { POST } = await import("@/app/v1/auth/register/route")
    const response = await POST(jsonRequest("http://localhost/api/auth/register", {
      firstName: "Test",
      lastName: "User",
      email: "doctor@example.com",
      password: "Strong1!",
      institutionId: "inst-1",
      locale: "bg",
      legalAcceptances: legalReferences("bg"),
    }))

    expect(response.status).toBe(500)
    expect(mocks.sendVerificationEmail).not.toHaveBeenCalled()
  })

  it("does not expose public email registration, verification, or recovery in trusted Hospital mode", async () => {
    process.env.LOSPOR_DEPLOYMENT_MODE = "hospital"
    process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED = "true"
    const register = await import("@/app/v1/auth/register/route")
    const verify = await import("@/app/v1/auth/verify-email/route")
    const resend = await import("@/app/v1/auth/verify-email/resend/route")
    const resetRequest = await import("@/app/v1/auth/password-reset/request/route")
    const resetConfirm = await import("@/app/v1/auth/password-reset/confirm/route")

    const responses = await Promise.all([
      register.POST(jsonRequest("http://localhost/v1/auth/register", { email: "contact@example.test" })),
      verify.GET(new NextRequest("http://localhost/v1/auth/verify-email?token=secret-token-123456789012345")),
      resend.POST(jsonRequest("http://localhost/v1/auth/verify-email/resend", { email: "contact@example.test" })),
      resetRequest.POST(jsonRequest("http://localhost/v1/auth/password-reset/request", { email: "contact@example.test" })),
      resetConfirm.POST(jsonRequest("http://localhost/v1/auth/password-reset/confirm", {
        token: "secret-token-123456789012345",
        password: "Strong2!",
      })),
    ])

    expect(responses.map(response => response.status)).toEqual([404, 404, 404, 404, 404])
    for (const response of responses) {
      await expect(response.json()).resolves.toMatchObject({ code: "EMAIL_AUTH_DISABLED_BY_DEPLOYMENT" })
    }
    expect(mocks.userFindUnique).not.toHaveBeenCalled()
    expect(mocks.emailVerificationFindUnique).not.toHaveBeenCalled()
    expect(mocks.rateLimit).not.toHaveBeenCalled()
  })
})
