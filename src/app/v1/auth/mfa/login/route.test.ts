import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  challengeFind: vi.fn(),
  challengeConsume: vi.fn(),
  userUpdateMany: vi.fn(),
  recoveryFind: vi.fn(),
  recoveryDelete: vi.fn(),
  recoveryCreate: vi.fn(),
  recoveryConsume: vi.fn(),
  sessionCreate: vi.fn(),
  auditCreate: vi.fn(),
  signToken: vi.fn(),
  invalidate: vi.fn(),
}))

vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }))
vi.mock("@/lib/mobile-auth", () => ({
  AUTH_COOKIE_NAME: "lospor_session",
  AUTH_TOKEN_TTL_SECONDS: 28_800,
  signMobileToken: mocks.signToken,
}))
vi.mock("@/lib/password-epoch", () => ({ invalidateAccountState: mocks.invalidate }))
vi.mock("@/lib/auth-sessions", () => ({
  createAuthSessionInTransaction: mocks.sessionCreate,
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    mfaLoginChallenge: { findUnique: mocks.challengeFind },
    mfaRecoveryCode: { findFirst: mocks.recoveryFind },
    $transaction: (run: (transaction: unknown) => unknown) => run({
      mfaLoginChallenge: { updateMany: mocks.challengeConsume },
      user: { updateMany: mocks.userUpdateMany },
      mfaRecoveryCode: {
        deleteMany: mocks.recoveryDelete,
        createMany: mocks.recoveryCreate,
        updateMany: mocks.recoveryConsume,
      },
      authSession: { create: vi.fn() },
      auditLog: { create: mocks.auditCreate },
    }),
  },
}))

const original = {
  required: process.env.LOSPOR_ADMIN_MFA_REQUIRED,
  key: process.env.LOSPOR_MFA_ENCRYPTION_KEY,
  keyFile: process.env.LOSPOR_MFA_ENCRYPTION_KEY_FILE,
}

function restore(name: keyof typeof original, envName: string) {
  const value = original[name]
  if (value === undefined) delete process.env[envName]
  else process.env[envName] = value
}

afterEach(() => {
  vi.useRealTimers()
  restore("required", "LOSPOR_ADMIN_MFA_REQUIRED")
  restore("key", "LOSPOR_MFA_ENCRYPTION_KEY")
  restore("keyFile", "LOSPOR_MFA_ENCRYPTION_KEY_FILE")
})

const user = {
  id: "admin-1",
  email: "admin@example.test",
  name: "Admin",
  firstName: "Ada",
  lastName: "Admin",
  title: "Dr",
  role: "ADMIN",
  accountKind: "CLINICAL",
  institutionId: "inst-1",
  institution: { name: "Hospital" },
  emailVerifiedAt: new Date("2026-01-01T00:00:00Z"),
  activatedAt: new Date("2026-01-01T00:00:00Z"),
  deletedAt: null,
  suspendedAt: null,
  recoveryRequiredAt: null,
  anonymizedAt: null,
  acceptedTermsAt: null,
  legalAcceptances: [],
  preferences: { ui: { locale: "bg" } },
  mfaTotpSecretCiphertext: null,
  mfaEnabledAt: null,
  mfaLastTotpStep: null,
  passwordChangedAt: null,
}

function request(code: string) {
  return new NextRequest("https://api.example.test/v1/auth/mfa/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify({ challengeToken: "x".repeat(43), code }),
  })
}

describe("administrator MFA login continuation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(59_000))
    process.env.LOSPOR_ADMIN_MFA_REQUIRED = "true"
    process.env.LOSPOR_MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64")
    delete process.env.LOSPOR_MFA_ENCRYPTION_KEY_FILE
    mocks.rateLimit.mockResolvedValue({ allowed: true })
    mocks.challengeConsume.mockResolvedValue({ count: 1 })
    mocks.userUpdateMany.mockResolvedValue({ count: 1 })
    mocks.recoveryDelete.mockResolvedValue({ count: 0 })
    mocks.recoveryCreate.mockResolvedValue({ count: 10 })
    mocks.recoveryConsume.mockResolvedValue({ count: 1 })
    mocks.sessionCreate.mockResolvedValue(undefined)
    mocks.auditCreate.mockResolvedValue({})
    mocks.signToken.mockResolvedValue("signed-token")
  })

  it("enrolls from a one-use password challenge and returns ten codes only once", async () => {
    const { encryptTotpSecret } = await import("@/lib/administrator-mfa")
    mocks.challengeFind.mockResolvedValue({
      id: "challenge-1",
      tokenHash: "hash",
      clientType: "WEB",
      preferredLocale: "bg",
      deviceLabel: "Browser",
      enrollmentSecretCiphertext: encryptTotpSecret(Buffer.from("12345678901234567890")),
      expiresAt: new Date(120_000),
      createdAt: new Date(30_000),
      usedAt: null,
      user,
    })

    const { POST } = await import("./route")
    const response = await POST(request("287082"))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.recoveryCodes).toHaveLength(10)
    expect(new Set(body.recoveryCodes).size).toBe(10)
    expect(mocks.recoveryCreate).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ userId: "admin-1", codeHash: expect.stringMatching(/^[0-9a-f]{64}$/) }),
      ]),
    })
    expect(JSON.stringify(mocks.recoveryCreate.mock.calls)).not.toContain(body.recoveryCodes[0])
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "ADMIN_MFA_ENROLL", userId: "admin-1" }),
    })
    expect(mocks.signToken).toHaveBeenCalledWith(expect.objectContaining({ mfaVerified: true }))
    expect(response.cookies.get("lospor_session")?.value).toBe("signed-token")
    expect(mocks.userUpdateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        id: "admin-1",
        role: "ADMIN",
        suspendedAt: null,
        OR: [
          { passwordChangedAt: null },
          { passwordChangedAt: { lt: new Date(30_000) } },
        ],
      }),
    }))
  })

  // HAUD_ROLLBACK:administrator-mfa-state
  it("does not issue an enrolled administrator session when audit persistence fails", async () => {
    const { encryptTotpSecret } = await import("@/lib/administrator-mfa")
    mocks.challengeFind.mockResolvedValue({
      id: "challenge-audit-failure",
      tokenHash: "hash",
      clientType: "WEB",
      preferredLocale: "bg",
      deviceLabel: "Browser",
      enrollmentSecretCiphertext: encryptTotpSecret(Buffer.from("12345678901234567890")),
      expiresAt: new Date(120_000),
      createdAt: new Date(30_000),
      usedAt: null,
      user,
    })
    mocks.auditCreate.mockRejectedValueOnce(new Error("audit unavailable"))

    const { POST } = await import("./route")
    await expect(POST(request("287082"))).rejects.toThrow("audit unavailable")
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it("does not issue a session when the challenge was consumed concurrently", async () => {
    const { encryptTotpSecret } = await import("@/lib/administrator-mfa")
    mocks.challengeFind.mockResolvedValue({
      id: "challenge-1",
      clientType: "WEB",
      preferredLocale: "bg",
      deviceLabel: "Browser",
      enrollmentSecretCiphertext: encryptTotpSecret(Buffer.from("12345678901234567890")),
      expiresAt: new Date(120_000),
      createdAt: new Date(30_000),
      usedAt: null,
      user,
    })
    mocks.challengeConsume.mockResolvedValue({ count: 0 })
    const { POST } = await import("./route")
    const response = await POST(request("287082"))
    expect(response.status).toBe(409)
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
  })

  it("consumes a stored recovery code once without storing or auditing its plaintext", async () => {
    const { encryptTotpSecret } = await import("@/lib/administrator-mfa")
    const recoveryCode = "ABCD-EFGH-IJKL-MNOP"
    mocks.challengeFind.mockResolvedValue({
      id: "challenge-2",
      clientType: "NATIVE",
      preferredLocale: "en",
      deviceLabel: "Phone",
      enrollmentSecretCiphertext: null,
      expiresAt: new Date(120_000),
      createdAt: new Date(30_000),
      usedAt: null,
      user: {
        ...user,
        mfaEnabledAt: new Date(1),
        mfaTotpSecretCiphertext: encryptTotpSecret(Buffer.from("12345678901234567890")),
      },
    })
    mocks.recoveryFind.mockResolvedValue({ id: "recovery-1" })
    const { POST } = await import("./route")
    const response = await POST(request(recoveryCode))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ access_token: "signed-token" })
    expect(body).not.toHaveProperty("recoveryCodes")
    expect(mocks.recoveryConsume).toHaveBeenCalledWith({
      where: { id: "recovery-1", userId: "admin-1", usedAt: null },
      data: { usedAt: expect.any(Date) },
    })
    expect(JSON.stringify(mocks.auditCreate.mock.calls)).not.toContain(recoveryCode)
  })

  it("does not issue a session when recovery-code audit persistence fails", async () => {
    const { encryptTotpSecret } = await import("@/lib/administrator-mfa")
    const recoveryCode = "ABCD-EFGH-IJKL-MNOP"
    mocks.challengeFind.mockResolvedValue({
      id: "challenge-recovery-audit-failure",
      clientType: "NATIVE",
      preferredLocale: "en",
      deviceLabel: "Phone",
      enrollmentSecretCiphertext: null,
      expiresAt: new Date(120_000),
      createdAt: new Date(30_000),
      usedAt: null,
      user: {
        ...user,
        mfaEnabledAt: new Date(1),
        mfaTotpSecretCiphertext: encryptTotpSecret(Buffer.from("12345678901234567890")),
      },
    })
    mocks.recoveryFind.mockResolvedValue({ id: "recovery-1" })
    mocks.auditCreate.mockRejectedValueOnce(new Error("audit unavailable"))

    const { POST } = await import("./route")
    await expect(POST(request(recoveryCode))).rejects.toThrow("audit unavailable")
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
    expect(mocks.invalidate).not.toHaveBeenCalled()
  })

  it("returns the normal Web user shape without recovery codes after a fresh TOTP", async () => {
    const { encryptTotpSecret } = await import("@/lib/administrator-mfa")
    mocks.challengeFind.mockResolvedValue({
      id: "challenge-totp",
      clientType: "WEB",
      preferredLocale: "en",
      deviceLabel: "Browser",
      enrollmentSecretCiphertext: null,
      expiresAt: new Date(120_000),
      createdAt: new Date(30_000),
      usedAt: null,
      user: {
        ...user,
        mfaEnabledAt: new Date(1),
        mfaTotpSecretCiphertext: encryptTotpSecret(Buffer.from("12345678901234567890")),
      },
    })
    const { POST } = await import("./route")
    const response = await POST(request("287082"))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      user: { id: "admin-1", preferredLocale: "en", role: "ADMIN" },
    })
    expect(body).not.toHaveProperty("recoveryCodes")
    expect(response.cookies.get("lospor_session")?.value).toBe("signed-token")
    expect(mocks.userUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: "admin-1",
        OR: [
          { mfaLastTotpStep: null },
          { mfaLastTotpStep: { lt: 1 } },
        ],
      },
      data: { mfaLastTotpStep: 1 },
    })
  })

  it("rejects a challenge whose password proof predates a password epoch", async () => {
    const { encryptTotpSecret } = await import("@/lib/administrator-mfa")
    mocks.challengeFind.mockResolvedValue({
      id: "challenge-old-password",
      clientType: "WEB",
      preferredLocale: "bg",
      deviceLabel: "Browser",
      enrollmentSecretCiphertext: encryptTotpSecret(Buffer.from("12345678901234567890")),
      expiresAt: new Date(120_000),
      createdAt: new Date(30_000),
      usedAt: null,
      user: { ...user, passwordChangedAt: new Date(40_000) },
    })
    const { POST } = await import("./route")
    const response = await POST(request("287082"))
    expect(response.status).toBe(401)
    expect(mocks.userUpdateMany).not.toHaveBeenCalled()
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
  })

  it("fails closed if the configured key cannot open an enrolled seed", async () => {
    const { encryptTotpSecret } = await import("@/lib/administrator-mfa")
    const ciphertext = encryptTotpSecret(Buffer.from("12345678901234567890"))
    mocks.challengeFind.mockResolvedValue({
      id: "challenge-key-failure",
      clientType: "WEB",
      preferredLocale: "bg",
      deviceLabel: "Browser",
      enrollmentSecretCiphertext: null,
      expiresAt: new Date(120_000),
      createdAt: new Date(30_000),
      usedAt: null,
      user: {
        ...user,
        mfaEnabledAt: new Date(1),
        mfaTotpSecretCiphertext: ciphertext,
      },
    })
    process.env.LOSPOR_MFA_ENCRYPTION_KEY = `${Buffer.alloc(32, 9).toString("base64")}!!!!`
    const { POST } = await import("./route")
    const response = await POST(request("287082"))
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ code: "MFA_CONFIGURATION_UNAVAILABLE" })
    expect(mocks.userUpdateMany).not.toHaveBeenCalled()
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
  })

  it("rolls back when a concurrent account-state change wins the transaction lock", async () => {
    const { encryptTotpSecret } = await import("@/lib/administrator-mfa")
    mocks.challengeFind.mockResolvedValue({
      id: "challenge-state-race",
      clientType: "WEB",
      preferredLocale: "bg",
      deviceLabel: "Browser",
      enrollmentSecretCiphertext: encryptTotpSecret(Buffer.from("12345678901234567890")),
      expiresAt: new Date(120_000),
      createdAt: new Date(30_000),
      usedAt: null,
      user,
    })
    mocks.userUpdateMany.mockResolvedValueOnce({ count: 0 })
    const { POST } = await import("./route")
    const response = await POST(request("287082"))
    expect(response.status).toBe(409)
    expect(mocks.challengeConsume).not.toHaveBeenCalled()
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
  })

  it("rejects reuse of an accepted TOTP time step across concurrent challenges", async () => {
    const { encryptTotpSecret } = await import("@/lib/administrator-mfa")
    mocks.challengeFind.mockResolvedValue({
      id: "challenge-replayed-step",
      clientType: "WEB",
      preferredLocale: "bg",
      deviceLabel: "Browser",
      enrollmentSecretCiphertext: null,
      expiresAt: new Date(120_000),
      createdAt: new Date(30_000),
      usedAt: null,
      user: {
        ...user,
        mfaEnabledAt: new Date(1),
        mfaTotpSecretCiphertext: encryptTotpSecret(Buffer.from("12345678901234567890")),
      },
    })
    mocks.userUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
    const { POST } = await import("./route")
    const response = await POST(request("287082"))
    expect(response.status).toBe(409)
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
  })

  it("rejects a recovery code that another continuation consumed first", async () => {
    const { encryptTotpSecret } = await import("@/lib/administrator-mfa")
    mocks.challengeFind.mockResolvedValue({
      id: "challenge-recovery-race",
      clientType: "NATIVE",
      preferredLocale: "en",
      deviceLabel: "Phone",
      enrollmentSecretCiphertext: null,
      expiresAt: new Date(120_000),
      createdAt: new Date(30_000),
      usedAt: null,
      user: {
        ...user,
        mfaEnabledAt: new Date(1),
        mfaTotpSecretCiphertext: encryptTotpSecret(Buffer.from("12345678901234567890")),
      },
    })
    mocks.recoveryFind.mockResolvedValue({ id: "recovery-1" })
    mocks.recoveryConsume.mockResolvedValue({ count: 0 })
    const { POST } = await import("./route")
    const response = await POST(request("ABCD-EFGH-IJKL-MNOP"))
    expect(response.status).toBe(409)
    expect(mocks.sessionCreate).not.toHaveBeenCalled()
  })
})
