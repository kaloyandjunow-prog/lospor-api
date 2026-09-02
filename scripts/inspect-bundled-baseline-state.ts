import "dotenv/config"
import { PrismaPg } from "@prisma/adapter-pg"
import { Prisma, PrismaClient } from "../src/generated/prisma/client"
import { LOSPOR_BUNDLED_BASELINE_RELEASE } from "../src/lib/clinical-rules/bundled-baseline-contract"

/**
 * Say what a deployment actually holds of the bundled baselines. Reads only.
 *
 * The provisioner refuses to touch a state it does not recognise, and reports
 * only which rule was broken — `BUNDLED_BASELINE_PARTIAL_STATE` means one of
 * four counts is wrong, without saying which, because at that point it is
 * inside a transaction it is about to abandon.
 *
 * That refusal is right. Guessing at what to repair from the outside is not, so
 * this prints the four counts and the rows behind them. It writes nothing, and
 * the one shape that must never be repaired blindly is a selection that points
 * somewhere else: a deployment may have chosen its own ruleset deliberately,
 * and that choice is governed, not incidental.
 */
const principal = LOSPOR_BUNDLED_BASELINE_RELEASE.technicalPrincipal
const EXPECTED_PRESETS = ["lospor-adults-v2", "lospor-pediatrics-v2"]

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error("DATABASE_URL is required")
  const host = /@([^/?]+)/.exec(connectionString)?.[1] ?? "unknown"
  console.log(`Reading (no writes) from ${host}\n`)

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  } satisfies Prisma.PrismaClientOptions)

  try {
    const [principals, presets, selections, audits, account, session] = await Promise.all([
      prisma.technicalPrincipal.findMany(),
      prisma.clinicalPreset.findMany({
        where: { scope: "PLATFORM" },
        select: {
          id: true, key: true, clinicalMode: true, version: true, status: true,
          createdByTechnicalPrincipalId: true, _count: { select: { rules: true } },
        },
        orderBy: { id: "asc" },
      }),
      prisma.platformClinicalPresetSelection.findMany({ orderBy: { clinicalMode: "asc" } }),
      prisma.auditLog.findMany({
        where: {
          OR: [
            { userId: principal.id },
            { entityId: { in: EXPECTED_PRESETS } },
          ],
        },
        select: { id: true, action: true, entityId: true, userId: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.user.count({ where: { id: principal.id } }),
      prisma.authSession.count({ where: { userId: principal.id } }),
    ])

    // The four counts verifyCompleteState checks, each against what it wants.
    console.log("What the provisioner requires, and what is there:")
    console.log(`  technical principals   want 1  have ${principals.length}`)
    console.log(`  bundled presets        want 2  have ${presets.filter(p => EXPECTED_PRESETS.includes(p.id)).length}`)
    console.log(`  platform selections    want 2  have ${selections.length}`)
    console.log(`  audit rows             want 2  have ${audits.length}`)
    console.log(`  login-capable collision  want 0  have ${account + session}`)

    console.log("\nTechnical principals:")
    for (const p of principals) console.log(`  ${p.id} | ${p.kind} | release ${p.releaseVersion}`)
    if (principals.length === 0) console.log("  (none)")

    console.log("\nPlatform presets:")
    for (const p of presets) {
      console.log(`  ${p.id} | ${p.clinicalMode} | v${p.version} | ${p.status} | ${p._count.rules} rules | by ${p.createdByTechnicalPrincipalId ?? "a person"}`)
    }
    if (presets.length === 0) console.log("  (none)")

    console.log("\nPlatform selections:")
    for (const s of selections) {
      const expected = s.clinicalMode === "ADULT" ? EXPECTED_PRESETS[0] : EXPECTED_PRESETS[1]
      console.log(`  ${s.clinicalMode} -> ${s.presetId}${s.presetId === expected ? "" : "   <-- NOT the bundled baseline; a deliberate choice must not be overwritten"}`)
    }
    if (selections.length === 0) console.log("  (none) — no ruleset is in force for any mode")

    console.log("\nAudit rows the provisioner counts:")
    for (const a of audits) console.log(`  ${a.createdAt.toISOString()} | ${a.action} | ${a.entityId} | by ${a.userId}`)
    if (audits.length === 0) console.log("  (none)")
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
