import "server-only"
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto"
import { readFileSync } from "node:fs"
import { prisma } from "@/lib/prisma"
import type { AuthSessionClient } from "@/lib/auth-sessions"

export const MFA_CHALLENGE_TTL_SECONDS = 5 * 60
export const MFA_RECOVERY_CODE_COUNT = 10
export const MFA_TOTP_PERIOD_SECONDS = 30
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export class MfaConfigurationError extends Error {
  readonly code = "MFA_CONFIGURATION_UNAVAILABLE"
}

export function administratorMfaRequired(role: string): boolean {
  return process.env.LOSPOR_ADMIN_MFA_REQUIRED === "true" && role === "ADMIN"
}

function configuredKeyText(): string {
  const file = process.env.LOSPOR_MFA_ENCRYPTION_KEY_FILE?.trim()
  if (file) {
    try {
      return readFileSync(file, "utf8").trim()
    } catch {
      throw new MfaConfigurationError("Administrator MFA encryption key file is unavailable")
    }
  }
  const value = process.env.LOSPOR_MFA_ENCRYPTION_KEY?.trim()
  if (!value) throw new MfaConfigurationError("Administrator MFA encryption key is unavailable")
  return value
}

export function administratorMfaKeyIsReady(): boolean {
  try {
    mfaEncryptionKey()
    return true
  } catch {
    return false
  }
}

function mfaEncryptionKey(): Buffer {
  const encoded = configuredKeyText()
  // Buffer.from(value, "base64") is intentionally permissive: it ignores
  // invalid characters and accepts missing padding. Configuration secrets must
  // not be repaired silently, because a typo could otherwise appear healthy
  // while selecting bytes the operator did not intend.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new MfaConfigurationError("Administrator MFA encryption key must be canonical base64")
  }
  const key = Buffer.from(encoded, "base64")
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new MfaConfigurationError("Administrator MFA encryption key must decode to 32 bytes")
  }
  return key
}

export function encryptTotpSecret(secret: Buffer): string {
  if (secret.length < 20) throw new Error("TOTP secret is too short")
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", mfaEncryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()])
  const tag = cipher.getAuthTag()
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".")
}

export function decryptTotpSecret(value: string): Buffer {
  const [version, ivText, tagText, ciphertextText, extra] = value.split(".")
  if (version !== "v1" || !ivText || !tagText || !ciphertextText || extra !== undefined) {
    throw new MfaConfigurationError("Stored administrator MFA secret has an unsupported format")
  }
  try {
    const decode = (encoded: string, expectedLength?: number) => {
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("non-canonical base64url")
      const decoded = Buffer.from(encoded, "base64url")
      if (
        decoded.toString("base64url") !== encoded
        || (expectedLength !== undefined && decoded.length !== expectedLength)
      ) throw new Error("invalid base64url length")
      return decoded
    }
    const iv = decode(ivText, 12)
    const tag = decode(tagText, 16)
    const ciphertext = decode(ciphertextText)
    if (ciphertext.length < 20) throw new Error("ciphertext too short")
    const decipher = createDecipheriv("aes-256-gcm", mfaEncryptionKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ])
  } catch {
    throw new MfaConfigurationError("Stored administrator MFA secret cannot be opened")
  }
}

export function base32Encode(value: Buffer): string {
  let bits = 0
  let accumulator = 0
  let output = ""
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32[(accumulator >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += BASE32[(accumulator << (5 - bits)) & 31]
  return output
}

function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac("sha1", secret).update(message).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  )
  return String(binary % 1_000_000).padStart(6, "0")
}

function equalCode(expected: string, actual: string): boolean {
  const left = Buffer.from(expected)
  const right = Buffer.from(actual)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function verifyTotpCode(
  secret: Buffer,
  input: string,
  nowMs = Date.now(),
): number | null {
  const code = input.replace(/[\s-]/g, "")
  if (!/^\d{6}$/.test(code)) return null
  const currentStep = Math.floor(nowMs / 1000 / MFA_TOTP_PERIOD_SECONDS)
  for (const offset of [-1, 0, 1]) {
    const step = currentStep + offset
    if (step >= 0 && equalCode(hotp(secret, step), code)) return step
  }
  return null
}

export function normalizeRecoveryCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z2-7]/g, "")
}

export function recoveryCodeHash(userId: string, code: string): string {
  return createHash("sha256")
    .update("lospor-mfa-recovery-v1\0")
    .update(userId)
    .update("\0")
    .update(normalizeRecoveryCode(code))
    .digest("hex")
}

export function generateRecoveryCodes(): string[] {
  return Array.from({ length: MFA_RECOVERY_CODE_COUNT }, () => {
    const raw = base32Encode(randomBytes(10))
    return raw.match(/.{1,4}/g)!.join("-")
  })
}

export function challengeTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export type MfaChallengeStart = {
  code: "MFA_REQUIRED" | "MFA_ENROLLMENT_REQUIRED"
  challengeToken: string
  expiresIn: number
  enrollmentRequired: boolean
  manualKey?: string
  otpauthUri?: string
}

export async function beginAdministratorMfaLogin(input: {
  userId: string
  accountLabel: string
  clientType: AuthSessionClient
  preferredLocale: "bg" | "en"
  deviceLabel: string
}): Promise<MfaChallengeStart> {
  // Validate the key before creating a continuation that cannot be completed.
  mfaEncryptionKey()
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { mfaEnabledAt: true, mfaTotpSecretCiphertext: true },
  })
  if (!user) throw new Error("MFA_ACCOUNT_NOT_FOUND")

  const enrollmentRequired = !user.mfaEnabledAt || !user.mfaTotpSecretCiphertext
  const secret = enrollmentRequired ? randomBytes(20) : null
  const secretCiphertext = secret ? encryptTotpSecret(secret) : null
  const rawToken = randomBytes(32).toString("base64url")
  const now = new Date()
  const expiresAt = new Date(now.getTime() + MFA_CHALLENGE_TTL_SECONDS * 1000)

  await prisma.$transaction(async transaction => {
    await transaction.mfaLoginChallenge.deleteMany({
      where: {
        userId: input.userId,
        OR: [{ expiresAt: { lte: now } }, { usedAt: { not: null } }],
      },
    })
    await transaction.mfaLoginChallenge.create({
      data: {
        tokenHash: challengeTokenHash(rawToken),
        userId: input.userId,
        clientType: input.clientType,
        preferredLocale: input.preferredLocale,
        deviceLabel: input.deviceLabel,
        enrollmentSecretCiphertext: secretCiphertext,
        expiresAt,
      },
    })
  })

  if (!secret) {
    return {
      code: "MFA_REQUIRED",
      challengeToken: rawToken,
      expiresIn: MFA_CHALLENGE_TTL_SECONDS,
      enrollmentRequired: false,
    }
  }

  const manualKey = base32Encode(secret)
  const issuer = "LOSPOR"
  const label = `${issuer}:${input.accountLabel}`
  const otpauthUri = `otpauth://totp/${encodeURIComponent(label)}?secret=${manualKey}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${MFA_TOTP_PERIOD_SECONDS}`
  return {
    code: "MFA_ENROLLMENT_REQUIRED",
    challengeToken: rawToken,
    expiresIn: MFA_CHALLENGE_TTL_SECONDS,
    enrollmentRequired: true,
    manualKey,
    otpauthUri,
  }
}
