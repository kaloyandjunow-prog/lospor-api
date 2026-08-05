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

const PROD_PROJECT_REF = "yzqszvlvccyufrkbuhtv" // never seed E2E data here

async function main() {
  const url = process.env.DATABASE_URL ?? ""
  if (url.includes(PROD_PROJECT_REF)) {
    throw new Error("Refusing to seed E2E user: DATABASE_URL points at the production project.")
  }
  const { PrismaClient } = await import("../src/generated/prisma/client")
  const { PrismaPg } = await import("@prisma/adapter-pg")
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) } as ConstructorParameters<typeof PrismaClient>[0])
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
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
