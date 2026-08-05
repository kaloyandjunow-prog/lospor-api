import "dotenv/config"
import bcrypt from "bcryptjs"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "../src/generated/prisma/client"
import { normalizeEmail } from "../src/lib/auth-email-tokens"
import { passwordSchema } from "../src/lib/password-policy"

/**
 * Creates the first administrator on a fresh installation.
 *
 * Without this there is no way in. Registration produces a MEMBER with
 * approvedAt and emailVerifiedAt both null; only an existing ADMIN can approve
 * or promote anyone; and the seed creates institutions and nothing else. The
 * documented escape was to set the `role` column to ADMIN by hand in the
 * Supabase table editor, which fails twice over: a hospital running its own
 * database has no Supabase, and setting `role` alone leaves the account
 * unverified, so it still cannot sign in.
 *
 * Everything the account needs is set together, which is the part that was
 * easy to get wrong by hand: the role, a verified address, and approval.
 *
 * Usage:
 *     LOSPOR_BOOTSTRAP_ADMIN_EMAIL=... \
 *     LOSPOR_BOOTSTRAP_ADMIN_PASSWORD=... \
 *     LOSPOR_BOOTSTRAP_ADMIN_FIRST_NAME=... \
 *     LOSPOR_BOOTSTRAP_ADMIN_LAST_NAME=... \
 *     npm run bootstrap:admin
 *
 * It refuses to run once any administrator exists, so it cannot be used to
 * quietly mint a second one on a live system.
 */

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function main() {
  const databaseUrl = required("DATABASE_URL")
  const email = normalizeEmail(required("LOSPOR_BOOTSTRAP_ADMIN_EMAIL"))
  // Held to the same policy as a password chosen through the app; a bootstrap
  // account is the most privileged one on the installation.
  const password = passwordSchema.parse(required("LOSPOR_BOOTSTRAP_ADMIN_PASSWORD"))
  const firstName = required("LOSPOR_BOOTSTRAP_ADMIN_FIRST_NAME")
  const lastName = required("LOSPOR_BOOTSTRAP_ADMIN_LAST_NAME")
  const institutionName = process.env.LOSPOR_BOOTSTRAP_INSTITUTION_NAME?.trim()

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  })

  try {
    const existingAdmin = await prisma.user.findFirst({
      where: { role: "ADMIN", deletedAt: null },
      select: { email: true },
    })
    if (existingAdmin) {
      console.error(
        `This installation already has an administrator (${existingAdmin.email}).\n`
        + "Use the admin console to add another; this script is for the first one only.",
      )
      process.exitCode = 1
      return
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    })
    if (existingUser) {
      console.error(
        `${email} is already registered. Promote that account from the admin console `
        + "instead, or bootstrap with an address that has not been used.",
      )
      process.exitCode = 1
      return
    }

    const institution = institutionName
      ? await prisma.institution.findFirst({ where: { name: institutionName } })
      : null
    if (institutionName && !institution) {
      console.error(`No institution named "${institutionName}". Seed institutions first.`)
      process.exitCode = 1
      return
    }

    const now = new Date()
    await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(password, 12),
        firstName,
        lastName,
        name: `${firstName} ${lastName}`,
        role: "ADMIN",
        institutionId: institution?.id ?? null,
        // All three together. Signing in needs a verified address; approval is
        // what lets this account approve and promote others.
        approvedAt: now,
        emailVerifiedAt: now,
      },
    })

    console.log(`Created administrator: ${email}`)
    if (institution) console.log(`Institution: ${institution.name} (${institution.id})`)
    console.log("Sign in and create the remaining accounts from the admin console.")
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
