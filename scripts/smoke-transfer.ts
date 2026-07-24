/**
 * Case-transfer smoke test.
 *
 *   npm run smoke:transfer
 *
 * Guards the finding that was "close to guaranteed on first real use": case
 * codes are per-user sequences that both start at 0001, so any two clinicians
 * who each opened a case this year both hold "2026-0001". Transferring one
 * between them tripped `@@unique([userId, caseCode])` and returned a 500.
 *
 * Runs against the real database on purpose — the bug only exists because of a
 * database constraint, so a mocked test could not have caught it. Creates its
 * own throwaway users and cases and removes them again.
 */
import "dotenv/config"
import { PrismaClient } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { transferCaseOwnership } from "../src/lib/case-transfer"

// Own client: @/lib/prisma is server-only and cannot load outside Next.
const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

let failures = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  PASS  ${name}`)
  else { failures++; console.error(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`) }
}

const TAG = `smoke-transfer-${Date.now()}`

async function main() {
  console.log("Case-transfer smoke test (real database)\n")

  const instA = await prisma.institution.create({ data: { name: `${TAG}-A`, city: "Sofia" } })
  const instB = await prisma.institution.create({ data: { name: `${TAG}-B`, city: "Plovdiv" } })

  const mkUser = (suffix: string, institutionId: string) => prisma.user.create({
    data: {
      email: `${TAG}-${suffix}@lospor.invalid`,
      name: `Smoke ${suffix}`, firstName: "Smoke", lastName: suffix, title: "Dr",
      passwordHash: "x", role: "MEMBER", institutionId,
    },
  })
  const userA = await mkUser("a", instA.id)
  const userB = await mkUser("b", instB.id)

  // The collision: both clinicians hold the same code in their own sequence.
  const sharedCode = `${new Date().getFullYear()}-0001`
  const caseA = await prisma.case.create({
    data: { userId: userA.id, institutionId: instA.id, caseCode: sharedCode, status: "IN_PROGRESS" },
  })
  await prisma.case.create({
    data: { userId: userB.id, institutionId: instB.id, caseCode: sharedCode, status: "IN_PROGRESS" },
  })
  console.log(`both users hold ${sharedCode}; moving A's case to B\n`)

  try {
    // ── the transfer that used to 500 ────────────────────────────────────────
    const outcome = await transferCaseOwnership(prisma, caseA.id, userB.id, { supersedePending: true })
    check("transfer completes instead of throwing P2002", true)

    const moved = await prisma.case.findUniqueOrThrow({
      where: { id: caseA.id },
      select: { userId: true, institutionId: true, caseCode: true },
    })

    check("case now belongs to the recipient", moved.userId === userB.id, moved.userId)
    check("institution travelled with the case", moved.institutionId === instB.id, moved.institutionId)
    check("case was renumbered out of the clash", moved.caseCode !== sharedCode, moved.caseCode)
    check("the previous code was recorded", outcome.previousCaseCode === sharedCode, outcome.previousCaseCode)
    check("new code is in the recipient's year sequence",
      !!moved.caseCode?.startsWith(`${new Date().getFullYear()}-`), moved.caseCode)

    // The recipient's own case must be untouched by the renumbering.
    const recipientOriginal = await prisma.case.findFirst({
      where: { userId: userB.id, caseCode: sharedCode }, select: { id: true },
    })
    check("recipient's existing case kept its code", !!recipientOriginal)

    // ── a transfer with no clash must NOT renumber ───────────────────────────
    // The code is written on the printed record by hand, so it must only change
    // when it genuinely has to.
    const userC = await mkUser("c", instA.id)
    const caseC = await prisma.case.create({
      data: { userId: userA.id, institutionId: instA.id, caseCode: `${new Date().getFullYear()}-0777`, status: "IN_PROGRESS" },
    })
    const clean = await transferCaseOwnership(prisma, caseC.id, userC.id, { supersedePending: true })
    const movedC = await prisma.case.findUniqueOrThrow({ where: { id: caseC.id }, select: { caseCode: true } })
    check("an unclashing transfer keeps its original code", movedC.caseCode === `${new Date().getFullYear()}-0777`, movedC.caseCode)
    check("and records no previous code", clean.previousCaseCode === null, clean.previousCaseCode)
  } finally {
    // Throwaway data must not linger in the register.
    await prisma.caseTransfer.deleteMany({ where: { case: { user: { email: { startsWith: TAG } } } } }).catch(() => {})
    await prisma.case.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {})
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {})
    await prisma.institution.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {})
    await prisma.$disconnect()
  }

  console.log(failures === 0 ? "\nAll transfer smoke checks passed." : `\n${failures} check(s) FAILED.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async err => {
  console.error("\nTransfer smoke test threw:", err)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
