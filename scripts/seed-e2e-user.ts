// Seeds a single approved test user for Playwright E2E into whatever DATABASE_URL
// points at. GUARD: refuses to run against the production Supabase project so an
// E2E account can never be created in prod. Idempotent (upsert by email).
//
// Usage: npx tsx scripts/seed-e2e-user.ts   (uses .env DATABASE_URL = dev DB)
import "dotenv/config"
import bcrypt from "bcryptjs"
import {
  E2E_EMAIL, E2E_PASSWORD, E2E_RESEARCH_EMAIL,
  E2E_HOD_A_EMAIL, E2E_MEMBER_A_EMAIL, E2E_HOD_B_EMAIL, E2E_MEMBER_B_EMAIL,
  E2E_MEMBER_A2_EMAIL,
  E2E_INSTITUTION_B,
} from "../e2e/credentials"
// Every account belongs to an institution; a researcher with no department
// belongs to "Без институция" rather than to NULL.
import { NO_INSTITUTION_ID } from "../src/lib/institutions"

const PROD_PROJECT_REF = "yzqszvlvccyufrkbuhtv" // never seed E2E data here

// The client is created inside main() so the production guard runs before any
// database connection is opened.
async function openPrisma(connectionString: string) {
  const { PrismaClient } = await import("../src/generated/prisma/client")
  const { PrismaPg } = await import("@prisma/adapter-pg")
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  } as ConstructorParameters<typeof PrismaClient>[0])
}

async function main() {
  const url = process.env.DATABASE_URL ?? ""
  if (url.includes(PROD_PROJECT_REF)) {
    throw new Error("Refusing to seed E2E user: DATABASE_URL points at the production project.")
  }
  const prisma = await openPrisma(url)
  try {
    // E2E uses the exact release-owned adult-v2 and pediatric-v2 baselines.
    // This is intentionally separate from the test account and never attributes
    // release content to that login-capable administrator.
    const { provisionBundledClinicalBaselines } = await import(
      "../src/lib/clinical-rules/bundled-baseline-provisioner"
    )
    await provisionBundledClinicalBaselines(prisma)

    const passwordHash = await bcrypt.hash(E2E_PASSWORD, 10)
    const now = new Date()
    const email = E2E_EMAIL.trim().toLowerCase()
    // A real institution so created cases satisfy Case.institutionId's FK.
    const inst = await prisma.institution.upsert({
      where: { id: "e2e-institution" },
      update: {},
      create: { id: "e2e-institution", name: "E2E Test Hospital", city: "Sofia" },
    })
    const user = await prisma.user.upsert({
      where: { email },
      update: { passwordHash, activatedAt: now, emailVerifiedAt: now, acceptedTermsAt: now, acceptedPrivacyAt: now, role: "ADMIN", accountKind: "CLINICAL", institutionId: inst.id, preferences: { ui: { locale: "en" } } },
      create: {
        email, name: "E2E Tester", firstName: "E2E", lastName: "Tester", title: "Dr",
        passwordHash, role: "ADMIN", accountKind: "CLINICAL", activatedAt: now, emailVerifiedAt: now, acceptedTermsAt: now, acceptedPrivacyAt: now, termsVersion: "e2e",
        institutionId: inst.id, preferences: { ui: { locale: "en" } },
      },
    })
    console.log(`E2E user ready: ${user.email} (id ${user.id}, institution ${inst.id})`)

    const researchEmail = E2E_RESEARCH_EMAIL.trim().toLowerCase()
    const researcher = await prisma.user.upsert({
      where: { email: researchEmail },
      update: {
        passwordHash, activatedAt: now, emailVerifiedAt: now, acceptedTermsAt: now,
        acceptedPrivacyAt: now, role: "RESEARCHER", accountKind: "RESEARCH_ONLY", institutionId: NO_INSTITUTION_ID,
        preferences: { ui: { locale: "en" } },
      },
      create: {
        email: researchEmail, name: "E2E Aggregate Researcher", firstName: "Aggregate",
        lastName: "Researcher", title: "Dr", passwordHash, role: "RESEARCHER", accountKind: "RESEARCH_ONLY",
        activatedAt: now, emailVerifiedAt: now, acceptedTermsAt: now,
        acceptedPrivacyAt: now, termsVersion: "e2e",
        // Omitting this left the column NULL, which the invariant no longer
        // allows: every account belongs to an institution.
        institutionId: NO_INSTITUTION_ID, preferences: { ui: { locale: "en" } },
      },
    })
    await prisma.researchAccessGrant.deleteMany({ where: { userId: researcher.id } })
    await prisma.researchAccessGrant.create({ data: {
      userId: researcher.id,
      institutionId: inst.id,
      grantedById: user.id,
      canInspectCases: false,
      canExport: false,
      canExportOmop: false,
      expiresAt: new Date(now.getTime() + 90 * 86_400_000),
    } })
    console.log(`E2E aggregate researcher ready: ${researcher.email} (id ${researcher.id})`)

    // The cast. Institution, visibility and approval rules need more than one
    // person and more than one institution before they mean anything: a head of
    // department must have somebody to be head *of*, and "the other hospital's
    // head cannot see this" needs an other hospital.
    const instB = await prisma.institution.upsert({
      where: { id: E2E_INSTITUTION_B },
      update: {},
      create: { id: E2E_INSTITUTION_B, name: "E2E Second Hospital", city: "Plovdiv" },
    })

    const cast = [
      { email: E2E_HOD_A_EMAIL,    role: "HEAD_OF_DEPT", institutionId: inst.id,  first: "Hod",    last: "Alpha" },
      { email: E2E_MEMBER_A_EMAIL, role: "MEMBER",       institutionId: inst.id,  first: "Member", last: "Alpha" },
      { email: E2E_MEMBER_A2_EMAIL, role: "MEMBER",      institutionId: inst.id,  first: "Member", last: "Alpha Two" },
      { email: E2E_HOD_B_EMAIL,    role: "HEAD_OF_DEPT", institutionId: instB.id, first: "Hod",    last: "Beta"  },
      { email: E2E_MEMBER_B_EMAIL, role: "MEMBER",       institutionId: instB.id, first: "Member", last: "Beta"  },
    ] as const

    const castIds: string[] = []
    for (const person of cast) {
      const email = person.email.trim().toLowerCase()
      const seeded = await prisma.user.upsert({
        where: { email },
        // Reset role and institution on every run: a spec that moves somebody
        // between institutions must not leave the next run starting elsewhere.
        update: {
          passwordHash, role: person.role, accountKind: "CLINICAL", institutionId: person.institutionId,
          activatedAt: now, emailVerifiedAt: now, acceptedTermsAt: now, acceptedPrivacyAt: now,
          preferences: { ui: { locale: "en" } },
        },
        create: {
          email, name: `${person.first} ${person.last}`,
          firstName: person.first, lastName: person.last, title: "Dr",
          passwordHash, role: person.role, accountKind: "CLINICAL", institutionId: person.institutionId,
          activatedAt: now, emailVerifiedAt: now, acceptedTermsAt: now,
          acceptedPrivacyAt: now, termsVersion: "e2e",
          preferences: { ui: { locale: "en" } },
        },
      })
      // Likewise for anything a previous run left half-decided.
      await prisma.institutionChangeRequest.deleteMany({ where: { userId: seeded.id } })
      castIds.push(seeded.id)
      console.log(`E2E ${person.role} ready: ${seeded.email} (${person.institutionId})`)
    }

    // Most specs delete what they create, but one cannot: a finalised case is
    // undeletable by design, which is the point of finalising. Clearing the
    // cast's cases here rather than leaving them to accumulate is safe because
    // these four accounts exist only for Playwright — nobody records real work
    // as hod-a-e2e. The administrator and researcher are deliberately left
    // alone; those are also used for hand smoke-testing.
    if (castIds.length) {
      const { count } = await prisma.case.deleteMany({ where: { userId: { in: castIds } } })
      if (count) console.log(`E2E cases cleared: ${count}`)
    }

    // Same reason, different table: there is no delete-ruleset action, so the
    // scope-guard spec creates a departmental copy per run under an "e2e_" key
    // and leaves it. Anything with that prefix is a test artefact.
    const rulesets = await prisma.clinicalPreset.deleteMany({
      where: { key: { startsWith: "e2e_" }, status: "DRAFT" },
    })
    if (rulesets.count) console.log(`E2E rulesets cleared: ${rulesets.count}`)

    // Sign-in is rate limited two ways — 10 attempts per email and 50 per
    // client address in 15 minutes — and every suite run signs each of these
    // accounts in. Iterating on a spec therefore used to end in a locked-out
    // login page that looked like a broken login rather than the limiter doing
    // its job. The per-address counter was the tighter one in practice, because
    // it is shared across every account and both suites.
    //
    // Clearing the per-email counters is safe: they are keyed by these
    // addresses, which belong to nobody. Clearing the per-address counters is
    // safe here and only here — this script refuses to run against production,
    // so the only traffic these buckets ever held is the suite's own.
    const limitKeys = [
      email, researchEmail,
      ...cast.map(person => person.email.trim().toLowerCase()),
    ].map(address => `login:${address}`)
    const limits = await prisma.rateLimit.deleteMany({
      where: {
        OR: [
          { key: { in: limitKeys } },
          { key: { startsWith: "login-ip:" } },
          // The spec that proves the limiter works deliberately exhausts a
          // throwaway address on every run. Those buckets are litter.
          { key: { startsWith: "login:rate-limit-" } },
        ],
      },
    })
    if (limits.count) console.log(`E2E login rate limits cleared: ${limits.count}`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
