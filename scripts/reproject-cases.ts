/**
 * Re-derive every case's stored timetable projection.
 *
 *   npm run reproject:cases            # dry run — reports, changes nothing
 *   npm run reproject:cases -- --apply # actually rewrites keyEvents
 *
 * v5.3.0 changed what column 0 of the chart means. It used to be the earliest
 * charted event; it is now the start time the clinician entered, anchored to the
 * case's real day. Cases projected before that change still carry the old
 * origin, so their stored chart disagrees with what the apps now draw — the
 * "timetable starts at the wrong time" symptom, frozen into the data.
 *
 * Projections are derived data: CaseEvent rows are the source of truth and are
 * never touched here, so this is re-derivation rather than a migration, and it
 * is safe to run more than once.
 */
import "dotenv/config"
import { PrismaClient } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { rebuildProjection, resolveChartStart } from "../src/lib/case-events"

const adapter = new PrismaPg({ connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter })

const APPLY = process.argv.includes("--apply")

/** Wall-clock reading a projection currently starts from, for reporting. */
function firstEventTime(keyEvents: unknown): string | null {
  const log = (keyEvents as { log?: { ts?: string }[] } | null)?.log
  if (!Array.isArray(log) || log.length === 0) return null
  const earliest = log
    .map(e => e?.ts).filter(Boolean)
    .sort()[0]
  return earliest ? new Date(earliest).toISOString() : null
}

async function main() {
  console.log(APPLY ? "Reprojecting cases (APPLY)\n" : "Reprojecting cases — DRY RUN, nothing will change\n")

  const cases = await prisma.case.findMany({
    where:  { intraop: { isNot: null } },
    select: { id: true, caseCode: true, intraop: { select: { startedAt: true, startTime: true, createdAt: true, keyEvents: true } } },
    orderBy: { createdAt: "asc" },
  })
  console.log(`${cases.length} case(s) with an intraoperative record\n`)

  let changed = 0
  for (const c of cases) {
    const log = ((c.intraop?.keyEvents as { log?: unknown[] } | null)?.log ?? []) as Parameters<typeof resolveChartStart>[1]
    const anchor = resolveChartStart(c.intraop ? {
      startedAt: c.intraop.startedAt,
      startTime: c.intraop.startTime,
      createdAt: c.intraop.createdAt,
    } : null, log)
    const oldOrigin = firstEventTime(c.intraop?.keyEvents)
    const newOrigin = anchor?.toISOString() ?? null
    const differs = !!oldOrigin && !!newOrigin && oldOrigin !== newOrigin

    console.log(`${c.caseCode ?? c.id}`)
    console.log(`  chart started at : ${oldOrigin ?? "(no events)"}`)
    console.log(`  will start at    : ${newOrigin ?? "(no start time — unchanged)"}${differs ? "   <-- moves" : ""}`)

    if (APPLY) {
      try {
        await rebuildProjection(prisma, c.id)
        changed++
        console.log("  reprojected")
      } catch (e) {
        console.error(`  FAILED: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    console.log()
  }

  console.log(APPLY
    ? `Reprojected ${changed}/${cases.length} case(s).`
    : "Dry run complete. Re-run with --apply to write.")
  await prisma.$disconnect()
}

main().catch(async err => {
  console.error(err)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
