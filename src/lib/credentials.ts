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
  return user
}
