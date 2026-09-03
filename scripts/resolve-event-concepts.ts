import "dotenv/config"
import { PrismaClient } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { DRUG_EXPOSURE_EVENT_TYPES, resolveDrugExposureConcepts } from "../src/lib/relational-sync"

/**
 * Re-resolve the standard concept on stored intraoperative drug events.
 *
 * Drug events resolve their concept when they are written, so the export is a
 * pure function of the stored record: the same case exported twice produces the
 * same file. The cost of that choice is that a row keeps whatever the
 * vocabulary said on the day it was recorded — including rows written before
 * the concept was stored at all, which carry SOURCE_ONLY and no concept.
 *
 * This is the deliberate correction. Run it after a vocabulary update, or once
 * to bring historic rows forward. It is an action someone takes on a date, not
 * a lookup that happens invisibly on every export, so a dataset never shifts
 * under a researcher between two runs of the same query.
 *
 * Reports by default and changes nothing. Pass --apply to write.
 *
 *   npm run resolve:event-concepts            # what would change
 *   npm run resolve:event-concepts -- --apply # change it
 */

const adapter = new PrismaPg({
  connectionString: process.env.DIRECT_URL ?? process.env.DATABASE_URL!,
})
const prisma = new PrismaClient({ adapter })

type Change = {
  eventId: string
  caseId: string
  label: string | null
  atcCode: string | null
  from: { standardConceptId: number | null; mappingStatus: string }
  to: { standardConceptId: number | null; mappingStatus: string }
}

async function collectChanges(): Promise<Change[]> {
  // Every kind of event the export turns into a drug_exposure row, not just
  // boluses: an infusion, a fluid and a volatile agent are administrations too,
  // and were never resolved at all.
  //
  // Active rows only. Superseded rows are history: rewriting them would change
  // what an earlier export is expected to have contained.
  const events = await prisma.caseEvent.findMany({
    where: { type: { in: [...DRUG_EXPOSURE_EVENT_TYPES] }, status: "active" },
    select: {
      id: true, caseId: true, type: true, label: true, atcCode: true, inn: true,
      standardConceptId: true, mappingStatus: true,
    },
  })

  const changes: Change[] = []
  for (const event of events) {
    // Resolving through the same helper the write paths use means a historic
    // row lands on exactly the concept it would have got had it been recorded
    // today, including the catalog name lookup for rows stored before the ATC
    // codes existed.
    const candidate: Record<string, unknown> = {
      type: event.type, label: event.label, atcCode: event.atcCode, inn: event.inn,
    }
    await resolveDrugExposureConcepts(prisma, [candidate])
    const standardConceptId = (candidate.standardConceptId as number | null | undefined) ?? null
    const mappingStatus = String(candidate.mappingStatus ?? event.mappingStatus)
    const atcCode = (candidate.atcCode as string | null | undefined) ?? null
    const sameConcept = standardConceptId === (event.standardConceptId ?? null)
    const sameStatus = mappingStatus === String(event.mappingStatus)
    const sameAtc = atcCode === (event.atcCode ?? null)
    if (sameConcept && sameStatus && sameAtc) continue
    changes.push({
      eventId: event.id,
      caseId: event.caseId,
      label: event.label,
      atcCode,
      from: { standardConceptId: event.standardConceptId, mappingStatus: String(event.mappingStatus) },
      to: { standardConceptId, mappingStatus },
    })
  }
  return changes
}

async function main() {
  const apply = process.argv.includes("--apply")
  const changes = await collectChanges()

  if (changes.length === 0) {
    console.log("Every active drug event already matches the current vocabulary. Nothing to do.")
    return
  }

  // Grouped so a reviewer sees the shape of the change rather than a wall of
  // rows: "these 40 fentanyl events gain this concept" is checkable, 40
  // individual lines are not.
  const grouped = new Map<string, { count: number; example: Change }>()
  for (const change of changes) {
    const key = `${change.atcCode ?? "no-atc"}|${change.from.standardConceptId ?? "none"}→${change.to.standardConceptId ?? "none"}`
    const entry = grouped.get(key)
    if (entry) entry.count += 1
    else grouped.set(key, { count: 1, example: change })
  }

  console.log(`${changes.length} event(s) would change, in ${grouped.size} group(s):\n`)
  for (const [, { count, example }] of grouped) {
    console.log(
      `  ${String(count).padStart(5)} × ${example.label ?? "(unlabelled)"}`
      + ` [${example.atcCode ?? "no ATC"}]`
      + ` ${example.from.standardConceptId ?? "none"} (${example.from.mappingStatus})`
      + ` → ${example.to.standardConceptId ?? "none"} (${example.to.mappingStatus})`,
    )
  }

  if (!apply) {
    console.log("\nNo data changed. Re-run with --apply to write these.")
    return
  }

  // Grouped updates: every event resolving to the same concept is one
  // statement rather than one per row. The ATC is part of the key because a
  // row that had none until the catalog supplied one must have it written
  // too — it is what the export shows as the drug's source value, and what a
  // future re-resolution reads before falling back to the name.
  const byTarget = new Map<string, { ids: string[]; to: Change["to"]; atcCode: string | null }>()
  for (const change of changes) {
    const key = `${change.to.standardConceptId ?? "none"}|${change.to.mappingStatus}|${change.atcCode ?? "none"}`
    const entry = byTarget.get(key)
    if (entry) entry.ids.push(change.eventId)
    else byTarget.set(key, { ids: [change.eventId], to: change.to, atcCode: change.atcCode })
  }

  let written = 0
  for (const [, { ids, to, atcCode }] of byTarget) {
    const result = await prisma.caseEvent.updateMany({
      where: { id: { in: ids } },
      data: {
        atcCode,
        standardConceptId: to.standardConceptId,
        mappingStatus: to.mappingStatus as never,
      },
    })
    written += result.count
  }
  console.log(`\nUpdated ${written} event(s) at ${new Date().toISOString()}.`)
  console.log("Exports taken from now on will carry these concepts; earlier exports are unchanged.")
}

main()
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
