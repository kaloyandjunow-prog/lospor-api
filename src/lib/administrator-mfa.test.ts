import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
const mocks = vi.hoisted(() => ({
  userFind: vi.fn(),
  challengeDelete: vi.fn(),
  challengeCreate: vi.fn(),
  transaction: vi.fn(),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.userFind },
    $transaction: mocks.transaction,
  },
}))
import {
  administratorMfaKeyIsReady,
  administratorMfaRequired,
  base32Encode,
  beginAdministratorMfaLogin,
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  normalizeRecoveryCode,
  recoveryCodeHash,
  verifyTotpCode,
} from "./administrator-mfa"

const original = {
  required: process.env.LOSPOR_ADMIN_MFA_REQUIRED,
  key: process.env.LOSPOR_MFA_ENCRYPTION_KEY,
  keyFile: process.env.LOSPOR_MFA_ENCRYPTION_KEY_FILE,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.challengeDelete.mockResolvedValue({ count: 0 })
  mocks.challengeCreate.mockResolvedValue({})
  mocks.transaction.mockImplementation((run: (transaction: unknown) => unknown) => run({
    mfaLoginChallenge: {
      deleteMany: mocks.challengeDelete,
      create: mocks.challengeCreate,
    },
  }))
})

afterEach(() => {
  if (original.required === undefined) delete process.env.LOSPOR_ADMIN_MFA_REQUIRED
  else process.env.LOSPOR_ADMIN_MFA_REQUIRED = original.required
  if (original.key === undefined) delete process.env.LOSPOR_MFA_ENCRYPTION_KEY
  else process.env.LOSPOR_MFA_ENCRYPTION_KEY = original.key
  if (original.keyFile === undefined) delete process.env.LOSPOR_MFA_ENCRYPTION_KEY_FILE
  else process.env.LOSPOR_MFA_ENCRYPTION_KEY_FILE = original.keyFile
})

describe("administrator MFA primitives", () => {
  it("is deployment-gated and applies only to administrators", () => {
    process.env.LOSPOR_ADMIN_MFA_REQUIRED = "true"
    expect(administratorMfaRequired("ADMIN")).toBe(true)
    expect(administratorMfaRequired("HEAD_OF_DEPT")).toBe(false)
    delete process.env.LOSPOR_ADMIN_MFA_REQUIRED
    expect(administratorMfaRequired("ADMIN")).toBe(false)
  })

  it("encrypts the TOTP seed with authenticated encryption", () => {
    process.env.LOSPOR_MFA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")
    delete process.env.LOSPOR_MFA_ENCRYPTION_KEY_FILE
    const secret = Buffer.from("12345678901234567890")
    const sealed = encryptTotpSecret(secret)
    expect(sealed).not.toContain(secret.toString("hex"))
    expect(decryptTotpSecret(sealed)).toEqual(secret)
    expect(() => decryptTotpSecret(`${sealed.slice(0, -1)}A`)).toThrow()
    expect(() => decryptTotpSecret(`${sealed}!`)).toThrow()
    expect(administratorMfaKeyIsReady()).toBe(true)
  })

  it("rejects base64 keys with ignored junk or missing canonical padding", () => {
    const valid = Buffer.alloc(32, 7).toString("base64")
    delete process.env.LOSPOR_MFA_ENCRYPTION_KEY_FILE
    process.env.LOSPOR_MFA_ENCRYPTION_KEY = `${valid}!!!!`
    expect(administratorMfaKeyIsReady()).toBe(false)
    expect(() => encryptTotpSecret(Buffer.alloc(20))).toThrow("canonical base64")

    process.env.LOSPOR_MFA_ENCRYPTION_KEY = valid.slice(0, -1)
    expect(administratorMfaKeyIsReady()).toBe(false)
  })

  it("matches the RFC 6238 SHA-1 test vector with a six-digit truncation", () => {
    const secret = Buffer.from("12345678901234567890")
    expect(base32Encode(secret)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")
    expect(verifyTotpCode(secret, "287082", 59_000)).toBe(1)
    expect(verifyTotpCode(secret, "287083", 59_000)).toBeNull()
  })

  it("creates exactly ten normalized, unique, user-bound recovery codes", () => {
    const codes = generateRecoveryCodes()
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    expect(codes.every(code => /^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){3}$/.test(code))).toBe(true)
    expect(normalizeRecoveryCode(codes[0].toLowerCase())).toHaveLength(16)
    expect(recoveryCodeHash("user-a", codes[0])).not.toBe(recoveryCodeHash("user-b", codes[0]))
  })

  it("creates an enrollment continuation atomically without storing its raw token or seed", async () => {
    process.env.LOSPOR_MFA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")
    delete process.env.LOSPOR_MFA_ENCRYPTION_KEY_FILE
    mocks.userFind.mockResolvedValue({ mfaEnabledAt: null, mfaTotpSecretCiphertext: null })

    const result = await beginAdministratorMfaLogin({
      userId: "admin-1",
      accountLabel: "Admin.Primary",
      clientType: "WEB",
      preferredLocale: "bg",
      deviceLabel: "Browser",
    })
    expect(result).toMatchObject({
      code: "MFA_ENROLLMENT_REQUIRED",
      expiresIn: 300,
      enrollmentRequired: true,
      manualKey: expect.stringMatching(/^[A-Z2-7]{32}$/),
      otpauthUri: expect.stringMatching(/^otpauth:\/\/totp\//),
    })
    expect(mocks.transaction).toHaveBeenCalledOnce()
    expect(mocks.challengeDelete).toHaveBeenCalledWith({
      where: {
        userId: "admin-1",
        OR: [{ expiresAt: { lte: expect.any(Date) } }, { usedAt: { not: null } }],
      },
    })
    const stored = mocks.challengeCreate.mock.calls[0][0].data
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.tokenHash).not.toBe(result.challengeToken)
    expect(stored.enrollmentSecretCiphertext).toMatch(/^v1\./)
    expect(stored.enrollmentSecretCiphertext).not.toContain(result.manualKey)
    expect(result.otpauthUri).toContain("LOSPOR%3AAdmin.Primary")
    expect(result.otpauthUri).not.toContain("%40")
  })

  it("creates no replacement seed for an already-enrolled administrator", async () => {
    process.env.LOSPOR_MFA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64")
    delete process.env.LOSPOR_MFA_ENCRYPTION_KEY_FILE
    mocks.userFind.mockResolvedValue({
      mfaEnabledAt: new Date(),
      mfaTotpSecretCiphertext: "v1.existing",
    })
    const result = await beginAdministratorMfaLogin({
      userId: "admin-1",
      accountLabel: "Admin.Primary",
      clientType: "NATIVE",
      preferredLocale: "en",
      deviceLabel: "Phone",
    })
    expect(result).toEqual(expect.objectContaining({
      code: "MFA_REQUIRED",
      enrollmentRequired: false,
    }))
    expect(result).not.toHaveProperty("manualKey")
    expect(mocks.challengeCreate.mock.calls[0][0].data.enrollmentSecretCiphertext).toBeNull()
  })

  it("does not touch account state when key configuration is invalid", async () => {
    process.env.LOSPOR_MFA_ENCRYPTION_KEY = `${Buffer.alloc(32, 7).toString("base64")}junk`
    delete process.env.LOSPOR_MFA_ENCRYPTION_KEY_FILE
    await expect(beginAdministratorMfaLogin({
      userId: "admin-1",
      accountLabel: "Admin.Primary",
      clientType: "WEB",
      preferredLocale: "bg",
      deviceLabel: "Browser",
    })).rejects.toBeInstanceOf(Error)
    expect(mocks.userFind).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})
