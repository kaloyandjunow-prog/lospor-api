/**
 * Removes superseded clinical rulesets, keeping only the current published
 * platform pair (adult v2 + pediatric v2).
 *
 * Deliberately narrow and guarded:
 *   - refuses to run against a production-like environment
 *   - requires an explicit env var, and --apply to write
 *   - never deletes a preset that is SELECTED, or that any CaseEvent references
 *     as dose provenance (deleting those would break the audit trail that makes
 *     a recorded dose reproducible)
 *   - never deletes a preset with institution overrides attached
 *   - reports exactly what it will remove before removing it
 *
 * Preset rules cascade with the preset (ClinicalPresetRule.onDelete: Cascade).
 *
 * Dry-run:
 *   $env:PRUNE_CLINICAL_RULESETS="YES"; npm run clinical-rules:prune
 * Apply:
 *   npm run clinical-rules:prune -- --apply
 */
import "dotenv/config"
import { Prisma, PrismaClient } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

if (process.env.PRUNE_CLINICAL_RULESETS !== "YES") {
  throw new Error('Refusing to run. Set PRUNE_CLINICAL_RULESETS="YES" explicitly.')
}
if (process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production") {
  throw new Error("Refusing to delete rulesets in a production-like environment.")
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")

/** The only presets that survive. */
const KEEP = new Set(["lospor-adults-v2", "lospor-pediatrics-v2"])

const apply = process.argv.includes("--apply")
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
} satisfies Prisma.PrismaClientOptions)

async function main() {
  const presets = await prisma.clinicalPreset.findMany({
    select: {
      id: true, key: true, clinicalMode: true, status: true, version: true,
      _count: { select: { rules: true } },
    },
    orderBy: [{ clinicalMode: "asc" }, { version: "desc" }],
  })

  const selected = new Set([
    ...(await prisma.platformClinicalPresetSelection.findMany()).map(s => s.presetId),
    ...(await prisma.institutionClinicalPresetSelection.findMany()).map(s => s.presetId),
    ...(await prisma.userClinicalPresetSelection.findMany()).map(s => s.presetId),
  ])

  const doomed: typeof presets = []
  for (const preset of presets) {
    if (KEEP.has(preset.id)) continue

    // Safety checks — any hit means this preset is load-bearing.
    if (selected.has(preset.id)) {
      throw new Error(`Refusing: ${preset.id} is currently selected`)
    }
    const events = await prisma.caseEvent.count({ where: { clinicalPresetId: preset.id } })
    if (events > 0) {
      throw new Error(
        `Refusing: ${preset.id} is cited by ${events} recorded event(s) as dose provenance`,
      )
    }
    const overrides = await prisma.institutionClinicalRuleOverride.count({
      where: { presetId: preset.id },
    })
    if (overrides > 0) {
      throw new Error(`Refusing: ${preset.id} has ${overrides} institution override(s)`)
    }
    doomed.push(preset)
  }

  console.log("KEEP:")
  for (const preset of presets.filter(p => KEEP.has(p.id))) {
    console.log(`  ${preset.id} (${preset.clinicalMode} ${preset.status} v${preset.version}, ${preset._count.rules} rules)`)
  }
  console.log("\nDELETE:")
  if (!doomed.length) console.log("  (nothing)")
  for (const preset of doomed) {
    console.log(`  ${preset.id} (${preset.clinicalMode} ${preset.status} v${preset.version}, ${preset._count.rules} rules)`)
  }

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to delete.")
    return
  }
  if (!doomed.length) return

  await prisma.$transaction(async tx => {
    for (const preset of doomed) {
      await tx.clinicalPreset.delete({ where: { id: preset.id } })
    }
  })

  const after = await prisma.clinicalPreset.findMany({
    select: { id: true, clinicalMode: true, status: true, version: true },
    orderBy: [{ clinicalMode: "asc" }, { version: "desc" }],
  })
  console.log("\nRemaining:")
  after.forEach(p => console.log(`  ${p.id} (${p.clinicalMode} ${p.status} v${p.version})`))
}

main()
  .catch(error => { console.error(error); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
