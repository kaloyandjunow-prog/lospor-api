/**
 * One-off backfill: convert existing IntraoperativeRecord.keyEvents.log JSON
 * entries into immutable CaseEvent rows. Idempotent (upsert by idempotencyKey),
 * so it is safe to re-run. Run against the DEV database:
 *
 *   npx tsx scripts/backfill-case-events.ts
 */
import "dotenv/config"
import { PrismaClient, Prisma } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import type { LegacyKeyEvents } from "../src/types/timetable"

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! })
const prisma = new PrismaClient({ adapter } satisfies Prisma.PrismaClientOptions)

function inferSource(entryId: unknown): string {
  return typeof entryId === "string" && entryId.startsWith("web-") ? "web" : "mobile"
}

async function main() {
  const records = await prisma.intraoperativeRecord.findMany({
    select: { caseId: true, keyEvents: true, case: { select: { userId: true } } },
  })

  let cases = 0
  let inserted = 0
  let skipped = 0

  for (const rec of records) {
    const keyEvents = (rec.keyEvents as LegacyKeyEvents | null) ?? {}
    const log = Array.isArray(keyEvents.log) ? keyEvents.log : []
    if (log.length === 0) continue
    cases += 1

    for (let i = 0; i < log.length; i++) {
      const ev = log[i]
      if (!ev || typeof ev !== "object") { skipped += 1; continue }

      const entryId = typeof ev.id === "string" ? ev.id : `idx${i}`
      const idempotencyKey = `${rec.caseId}:${entryId}`
      const primary = ev.dose ?? ev.value ?? ev.rate ?? ev.volume
      const ts = ev.ts && !Number.isNaN(new Date(ev.ts).getTime()) ? new Date(ev.ts) : new Date()

      const res = await prisma.caseEvent.upsert({
        where:  { idempotencyKey },
        create: {
          caseId:         rec.caseId,
          userId:         rec.case?.userId ?? null,
          type:           typeof ev.type === "string" ? ev.type : "unknown",
          timestamp:      ts,
          label:          (ev.label ?? ev.name ?? null) as string | null,
          value:          primary != null ? String(primary) : null,
          unit:           typeof ev.unit === "string" ? ev.unit : null,
          metadataJson:   ev,
          source:         inferSource(ev.id),
          idempotencyKey,
        },
        update: {},
        select: { createdAt: true, updatedAt: true },
      })
      // createdAt === updatedAt means a fresh insert
      if (res.createdAt.getTime() === res.updatedAt.getTime()) inserted += 1
    }
  }

  console.log(`Backfill complete: ${cases} cases scanned, ${inserted} CaseEvent rows inserted, ${skipped} entries skipped.`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
