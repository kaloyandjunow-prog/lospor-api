import "server-only"
import { createHash, randomBytes } from "crypto"
import { z } from "zod"
import { normalizeEmail } from "@lospor/core/account"

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000

export function createAuthToken(): string {
  return randomBytes(32).toString("base64url")
}

export function hashAuthToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export function tokenExpiry(ttlMs: number): Date {
  return new Date(Date.now() + ttlMs)
}

// User.email is a case-sensitive unique column; every auth path must look up,
// create, and rate-limit with the same canonical form or casing variants
// become distinct accounts / rate-limit buckets.
export { normalizeEmail }

// Normalize BEFORE validating so "  Doctor@X.com " is accepted and parsed
// to its canonical form instead of rejected for the padding.
export const emailSchema = z.string().transform(normalizeEmail).pipe(z.string().email())
