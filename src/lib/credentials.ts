import "server-only"
import bcrypt from "bcryptjs"
import { prisma } from "@/lib/prisma"
import { normalizeEmail } from "@/lib/auth-email-tokens"

const DUMMY_HASH =
  "$2b$12$8Hgfmzh/eT3wO6GKKkEPoeC6rP9R5wI8M97v53FtBfe8chBgTrHpy"

export async function verifyCredentials(emailInput: string, password: string) {
  const email = normalizeEmail(emailInput)
  const user = await prisma.user.findUnique({
    where: { email },
    include: { institution: true },
  })

  const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH)
  if (!user || !valid || !user.emailVerifiedAt || user.deletedAt) return null
  // Approval is a separate gate from email verification. Verifying an address
  // proves the address; it does not establish that this person belongs to the
  // department whose cases they would be able to see. Registration leaves
  // approvedAt null and an administrator sets it, but nothing enforced it here,
  // so the approval queue governed only whether someone appeared in colleague
  // lists — not whether they could sign in.
  if (!user.approvedAt) return null
  return user
}
