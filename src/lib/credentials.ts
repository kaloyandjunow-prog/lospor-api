import "server-only"
import bcrypt from "bcryptjs"
import { prisma } from "@/lib/prisma"
import type { AuthenticationIdentifier } from "@/lib/authentication-identity"

const DUMMY_HASH =
  "$2b$12$8Hgfmzh/eT3wO6GKKkEPoeC6rP9R5wI8M97v53FtBfe8chBgTrHpy"

export async function verifyCredentials(identifier: AuthenticationIdentifier, password: string) {
  const user = await prisma.user.findUnique({
    where: identifier.kind === "EMAIL"
      ? { email: identifier.canonical }
      : { usernameCanonical: identifier.canonical },
    include: {
      institution: true,
      legalAcceptances: { orderBy: { acceptedAt: "desc" } },
    },
  })

  const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH)
  if (
    !user
    || !valid
    // A Hospital contact address can never become a public email-login
    // fallback, even if deployment configuration is later changed.
    || (identifier.kind === "EMAIL" && user.usernameCanonical !== null)
    || !user.activatedAt
    || user.deletedAt
    || user.suspendedAt
    || user.recoveryRequiredAt
    || user.anonymizedAt
  ) return null
  // Activation is deployment-neutral: public verification sets activatedAt
  // together with emailVerifiedAt, while Hospital administrators activate an
  // appliance username without turning optional contact email into identity.
  return user
}

/**
 * Re-authenticate an already signed-in account for a sensitive operation.
 *
 * Looking the account up by the authenticated id prevents an entered email
 * address from changing which identity authorizes the operation. The dummy
 * comparison keeps the missing-account path broadly equivalent without
 * revealing account state through timing.
 */
export async function verifyCurrentPassword(userId: string, password: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      passwordHash: true,
      activatedAt: true,
      deletedAt: true,
      suspendedAt: true,
      recoveryRequiredAt: true,
      anonymizedAt: true,
    },
  })
  const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH)
  return Boolean(
    user
    && valid
    && user.activatedAt
    && !user.deletedAt
    && !user.suspendedAt
    && !user.recoveryRequiredAt
    && !user.anonymizedAt
  )
}
