import "dotenv/config"
import bcrypt from "bcryptjs"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "../src/generated/prisma/client"
import { emailSchema, normalizeEmail } from "../src/lib/auth-email-tokens"
import { passwordSchema } from "../src/lib/password-policy"
import type { AuditActionCode } from "../src/lib/audit-actions"
import { authenticationDeploymentMode } from "../src/lib/deployment-capabilities"
import { normalizeRequiredUsername } from "../src/lib/username-identity"

/**
 * Creates the first administrator on a fresh installation.
 *
 * Without this there is no way in. Public registration produces an inactive
 * MEMBER, while Hospital appliances deliberately expose no self-registration;
 * the seed creates institutions and nothing else. The
 * documented escape was to set the `role` column to ADMIN by hand in the
 * Supabase table editor, which fails twice over: a hospital running its own
 * database has no Supabase, and setting `role` alone leaves the account
 * unverified, so it still cannot sign in.
 *
 * Everything the account needs is set together: role, activation, and the
 * identity selected by the trusted deployment mode.
 *
 * Usage:
 *     LOSPOR_BOOTSTRAP_ADMIN_EMAIL=...                 # public, optional in Hospital \
 *     LOSPOR_BOOTSTRAP_ADMIN_USERNAME=...              # Hospital only \
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

function requiredRaw(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

async function main() {
  const databaseUrl = required("DATABASE_URL")
  const authenticationMode = authenticationDeploymentMode()
  if (authenticationMode === "UNAVAILABLE") {
    throw new Error("Authentication deployment configuration is incomplete or unsupported")
  }
  const configuredEmail = process.env.LOSPOR_BOOTSTRAP_ADMIN_EMAIL?.trim()
  const email = authenticationMode === "PUBLIC"
    ? emailSchema.parse(required("LOSPOR_BOOTSTRAP_ADMIN_EMAIL"))
    : configuredEmail
      ? emailSchema.parse(normalizeEmail(configuredEmail))
      : null
  const hospitalUsername = authenticationMode === "HOSPITAL"
    ? normalizeRequiredUsername(requiredRaw("LOSPOR_BOOTSTRAP_ADMIN_USERNAME"))
    : null
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
      select: { email: true, username: true },
    })
    if (existingAdmin) {
      console.error(
        `This installation already has an administrator (${existingAdmin.username ?? existingAdmin.email ?? "unknown identity"}).\n`
        + "Use the admin console to add another; this script is for the first one only.",
      )
      process.exitCode = 1
      return
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          ...(email ? [{ email }] : []),
          ...(hospitalUsername ? [{ usernameCanonical: hospitalUsername.usernameCanonical }] : []),
        ],
      },
      select: { id: true },
    })
    if (existingUser) {
      const identity = hospitalUsername?.username ?? email
      console.error(
        `${identity} is already registered. Promote that account from the admin console `
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
    const provisionAction = "ACCOUNT_PROVISION" satisfies AuditActionCode
    await prisma.$transaction(async transaction => {
      const created = await transaction.user.create({
        data: {
          email,
          username: hospitalUsername?.username ?? null,
          usernameCanonical: hospitalUsername?.usernameCanonical ?? null,
          passwordHash: await bcrypt.hash(password, 12),
          firstName,
          lastName,
          name: `${firstName} ${lastName}`,
          role: "ADMIN",
          accountKind: "CLINICAL",
          institutionId: institution?.id ?? null,
          activatedAt: now,
          emailVerifiedAt: authenticationMode === "PUBLIC" ? now : null,
        },
      })
      await transaction.auditLog.create({
        data: {
          userId: created.id,
          action: provisionAction,
          entityId: created.id,
          detail: {
            provisioningChannel: "BOOTSTRAP_ADMIN",
            institutionId: institution?.id ?? null,
            role: "ADMIN",
            accountKind: "CLINICAL",
          },
        },
      })
    })

    console.log(`Created administrator: ${hospitalUsername?.username ?? email}`)
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
