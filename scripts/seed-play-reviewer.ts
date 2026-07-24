// Seeds the Google Play review account (Play Console "App access" declaration)
// into whatever DATABASE_URL points at: a dedicated demo institution + a
// pre-verified, terms-accepted MEMBER user so reviewers log straight in.
// Idempotent (upsert by email / institution id).
//
// The password is NEVER hardcoded — pass it via PLAY_REVIEWER_PASSWORD.
// Running against the production project must be acknowledged explicitly
// with SEED_TARGET=prod (mirror of seed-e2e-user.ts's guard, but opt-in
// instead of hard refusal, because this account is meant to exist in prod).
//
// Usage:
//   dev : PLAY_REVIEWER_PASSWORD=... npx tsx scripts/seed-play-reviewer.ts
//   prod: SEED_TARGET=prod DATABASE_URL=<prod pooler URI> PLAY_REVIEWER_PASSWORD=... npx tsx scripts/seed-play-reviewer.ts
import "dotenv/config"
import bcrypt from "bcryptjs"

const PROD_PROJECT_REF = "yzqszvlvccyufrkbuhtv"
const REVIEWER_EMAIL = "playreview@lospor.org"

async function main() {
  const url = process.env.DATABASE_URL ?? ""
  const password = process.env.PLAY_REVIEWER_PASSWORD ?? ""
  if (!password) throw new Error("PLAY_REVIEWER_PASSWORD is required (never hardcode it).")
  if (url.includes(PROD_PROJECT_REF) && process.env.SEED_TARGET !== "prod") {
    throw new Error("DATABASE_URL points at production — set SEED_TARGET=prod to confirm.")
  }
  const { PrismaClient } = await import("../src/generated/prisma/client")
  const { PrismaPg } = await import("@prisma/adapter-pg")
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) } as ConstructorParameters<typeof PrismaClient>[0])
  try {
    const passwordHash = await bcrypt.hash(password, 10)
    const now = new Date()
    // Dedicated demo institution: the reviewer account must never share an
    // institution with real clinical data.
    const inst = await prisma.institution.upsert({
      where: { id: "play-review-clinic" },
      update: {},
      create: { id: "play-review-clinic", name: "Play Review Demo Clinic", city: "Sofia" },
    })
    const user = await prisma.user.upsert({
      where: { email: REVIEWER_EMAIL },
      update: { passwordHash, approvedAt: now, emailVerifiedAt: now, acceptedTermsAt: now, acceptedPrivacyAt: now, role: "MEMBER", institutionId: inst.id },
      create: {
        email: REVIEWER_EMAIL, name: "Play Reviewer", firstName: "Play", lastName: "Reviewer", title: "Dr",
        passwordHash, role: "MEMBER", approvedAt: now, emailVerifiedAt: now, acceptedTermsAt: now, acceptedPrivacyAt: now, termsVersion: "4.0",
        institutionId: inst.id,
      },
    })
    const target = url.includes(PROD_PROJECT_REF) ? "PRODUCTION" : "dev"
    console.log(`Play reviewer ready on ${target}: ${user.email} (id ${user.id}, institution ${inst.id}, role ${user.role})`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
