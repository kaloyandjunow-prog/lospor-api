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
  E2E_INSTITUTION_B,
} from "../e2e/credentials"
// Every account belongs to an institution; a researcher with no department
// belongs to "Без институция" rather than to NULL.
import { NO_INSTITUTION_ID } from "../src/lib/institutions"
// Type-only, so the generated client is still loaded lazily inside main().
import type { Prisma } from "../src/generated/prisma/client"

const PROD_PROJECT_REF = "yzqszvlvccyufrkbuhtv" // never seed E2E data here

// The client is created inside main() so the production guard runs first; this
// gives the helpers below its type without hoisting the connection.
async function openPrisma(connectionString: string) {
  const { PrismaClient } = await import("../src/generated/prisma/client")
  const { PrismaPg } = await import("@prisma/adapter-pg")
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  } as ConstructorParameters<typeof PrismaClient>[0])
}

/**
 * Makes sure a published platform ruleset exists for each clinical mode.
 *
 * A freshly migrated database has none. The only preset the migrations ever
 * created was a placeholder, and 20260804000000 deliberately deletes it —
 * correctly, because an empty published ruleset silently resolved to "no doses"
 * while every health check reported success. The real ones are promoted by an
 * administrator after install.
 *
 * That leaves the release gate, which builds a database from migrations alone,
 * with no rules at all: the paediatric drug profiles come back empty and there
 * is nothing for a department to copy, so the specs that cover dosing and the
 * authoring scope guard fail for want of provisioning rather than for a defect.
 *
 * Built from the same bundled drafts the promotion scripts use, so CI exercises
 * the real clinical content.
 *
 * The condition is deliberately "no PUBLISHED platform ruleset exists for this
 * mode at all" — not "no selection exists". Keying on the selection was wrong
 * and did real damage on the development database: an adult ruleset was
 * published and curated there but never selected, so this ran, overwrote its
 * publication timestamp and publisher, and pointed the platform selection at
 * it. A published-but-unselected ruleset is somebody's decision, not a gap to
 * be filled by a seed script.
 *
 * It also never touches an existing preset. If there is nothing published, it
 * creates and selects one; otherwise it does nothing at all.
 */
async function ensurePlatformRulesets(
  prisma: Awaited<ReturnType<typeof openPrisma>>,
  publisherId: string,
): Promise<void> {
  const {
    createLosporAdultV2Draft,
    createLosporPediatricPlatformDraft,
  } = await import("@lospor/core/platform-clinical-drafts")
  const { clinicalRuleKey } = await import("@lospor/core/clinical-rules")

  for (const draft of [createLosporAdultV2Draft(), createLosporPediatricPlatformDraft()]) {
    const published = await prisma.clinicalPreset.count({
      where: { scope: "PLATFORM", clinicalMode: draft.clinicalMode, status: "PUBLISHED" },
    })
    if (published > 0) continue

    // A distinct id, so this can never be mistaken for — or collide with — a
    // curated ruleset promoted through the real path.
    const id = `e2e-platform-${draft.clinicalMode.toLowerCase()}`
    const now = new Date()
    await prisma.clinicalPreset.create({
      data: {
        id,
        key: `E2E_${draft.key}`,
        name: `${draft.name} (end-to-end provisioning)`,
        description: draft.description,
        clinicalMode: draft.clinicalMode,
        scope: "PLATFORM",
        version: draft.version,
        status: "PUBLISHED",
        publishedAt: now,
        publishedById: publisherId,
        createdById: publisherId,
        rules: {
          create: draft.rules.map(rule => ({
            ruleKey: clinicalRuleKey(rule.payload),
            ruleVersion: `${draft.key}.v${draft.version}.e2e`,
            payload: rule.payload as Prisma.InputJsonValue,
            sourceRefs: rule.sourceRefs as Prisma.InputJsonValue,
          })),
        },
      },
    })
    await prisma.platformClinicalPresetSelection.upsert({
      where: { clinicalMode: draft.clinicalMode },
      update: { presetId: id, selectedById: publisherId },
      create: { clinicalMode: draft.clinicalMode, presetId: id, selectedById: publisherId },
    })
    console.log(`E2E platform ruleset provisioned: ${draft.clinicalMode} -> ${id} (${draft.rules.length} rules)`)
  }
}

async function main() {
  const url = process.env.DATABASE_URL ?? ""
  if (url.includes(PROD_PROJECT_REF)) {
    throw new Error("Refusing to seed E2E user: DATABASE_URL points at the production project.")
  }
  const prisma = await openPrisma(url)
  try {
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
      update: { passwordHash, approvedAt: now, emailVerifiedAt: now, acceptedTermsAt: now, acceptedPrivacyAt: now, role: "ADMIN", institutionId: inst.id },
      create: {
        email, name: "E2E Tester", firstName: "E2E", lastName: "Tester", title: "Dr",
        passwordHash, role: "ADMIN", approvedAt: now, emailVerifiedAt: now, acceptedTermsAt: now, acceptedPrivacyAt: now, termsVersion: "e2e",
        institutionId: inst.id,
      },
    })
    console.log(`E2E user ready: ${user.email} (id ${user.id}, institution ${inst.id})`)

    // Needs an administrator to attribute the publication to, so it runs here
    // rather than at the top. A no-op wherever the rulesets already exist.
    await ensurePlatformRulesets(prisma, user.id)
    const researchEmail = E2E_RESEARCH_EMAIL.trim().toLowerCase()
    const researcher = await prisma.user.upsert({
      where: { email: researchEmail },
      update: {
        passwordHash, approvedAt: now, emailVerifiedAt: now, acceptedTermsAt: now,
        acceptedPrivacyAt: now, role: "RESEARCHER", institutionId: NO_INSTITUTION_ID,
      },
      create: {
        email: researchEmail, name: "E2E Aggregate Researcher", firstName: "Aggregate",
        lastName: "Researcher", title: "Dr", passwordHash, role: "RESEARCHER",
        approvedAt: now, emailVerifiedAt: now, acceptedTermsAt: now,
        acceptedPrivacyAt: now, termsVersion: "e2e",
        // Omitting this left the column NULL, which the invariant no longer
        // allows: every account belongs to an institution.
        institutionId: NO_INSTITUTION_ID,
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
          passwordHash, role: person.role, institutionId: person.institutionId,
          approvedAt: now, emailVerifiedAt: now, acceptedTermsAt: now, acceptedPrivacyAt: now,
        },
        create: {
          email, name: `${person.first} ${person.last}`,
          firstName: person.first, lastName: person.last, title: "Dr",
          passwordHash, role: person.role, institutionId: person.institutionId,
          approvedAt: now, emailVerifiedAt: now, acceptedTermsAt: now,
          acceptedPrivacyAt: now, termsVersion: "e2e",
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
      where: { key: { startsWith: "e2e_" } },
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
