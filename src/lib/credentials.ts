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
  // Approval is deliberately not a condition of signing in.
  //
  // It was, briefly, and it deadlocked every fresh installation: the first user
  // registers as a MEMBER with approvedAt null, only an existing ADMIN can
  // approve, and the seed creates institutions and no administrator. Nobody
  // could sign in to approve anybody.
  //
  // Making approval the gate also protected less than it appeared to. What a
  // signed-in user can see is decided by role, not by approval
  // (see caseWhereForUser): a MEMBER sees only their own cases. The department
  // boundary is HEAD_OF_DEPT, and elevation to it still requires approval, as
  // does moving to another institution. So approval now gates what a verified
  // account may become and where it may belong — not whether it may exist.
  //
  // The remaining gates are the ones that mean something here: the password,
  // a verified address, and an account that has not been deleted.
  return user
}
