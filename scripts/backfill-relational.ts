/**
 * One-off backfill for relational normalisation. Idempotent; safe to re-run.
 *   npx tsx scripts/backfill-relational.ts
 *
 * 1. Rebuilds normalised child rows from each case's current section data.
 * 2. Populates typed CaseEvent query columns from metadataJson.
 */
import "dotenv/config"
import { gasFractions } from "@lospor/core/intraop-engine"
import { PrismaClient, Prisma } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { syncCaseRelational } from "../src/lib/relational-sync"

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } satisfies Prisma.PrismaClientOptions)

async function backfillCaseRows() {
  const cases = await prisma.case.findMany({ select: { id: true } })
  let done = 0, failed = 0
  for (const c of cases) {
    try { await syncCaseRelational(prisma, c.id) }
    catch (e) { failed++; console.error("  case", c.id, e) }
    if (++done % 50 === 0) console.log(`  ...${done}/${cases.length} cases`)
  }
  console.log(`Relational rows synced for ${done} cases (${failed} failed).`)
}

async function backfillEventColumns() {
  const numI = (v: unknown) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Math.round(Number(v)))
  const numF = (v: unknown) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v))
  let cursor: string | null = null
  let total = 0

  for (;;) {
    const args: Prisma.CaseEventFindManyArgs = {
      take: 500,
      orderBy: { id: "asc" },
      select: { id: true, type: true, metadataJson: true },
    }
    if (cursor) { args.skip = 1; args.cursor = { id: cursor } }
    const batch = await prisma.caseEvent.findMany(args) as Array<{ id: string; type: string; metadataJson: unknown }>
    if (batch.length === 0) break

    for (const ev of batch) {
      const m = (ev.metadataJson as Record<string, unknown>) ?? {}
      const isVital = ev.type === "vital"
      const isGas = ev.type === "gas_start" || ev.type === "gas_change"
      const isAgent = ev.type === "agent_start"
      const isClinicalEvent = ev.type === "clinical_event" || ev.type === "event"
      const carrierGas = typeof m.carrierGas === "string" ? m.carrierGas : null
      const gas = isGas ? gasFractions(carrierGas, numF(m.fio2)) : null
      const bgl = isVital ? numF(m.bgl) : null

      await prisma.caseEvent.update({
        where: { id: ev.id },
        data: {
          systolic: isVital ? numI(m.systolic) : null,
          diastolic: isVital ? numI(m.diastolic) : null,
          heartRate: isVital ? numI(m.heartRate) : null,
          spO2: isVital ? numF(m.spO2) : null,
          etco2: isVital ? numF(m.etco2) : null,
          temp: isVital ? numF(m.temp) : null,
          bgl,
          bglLoincCode: bgl != null ? "2345-7" : null,
          bglUnitCanon: bgl != null ? "mmol/L" : null,
          fgfLitersPerMin: isGas ? numF(m.fgf) : null,
          carrierGas: isGas ? carrierGas : null,
          fio2Percent: gas?.fio2 ?? null,
          fiAirPercent: gas?.fiAir ?? null,
          fiN2OPercent: gas?.fiN2O ?? null,
          infId: typeof m.infId === "string" ? m.infId : null,
          fluidId: typeof m.fluidId === "string" ? m.fluidId : null,
          rate: m.rate != null ? String(m.rate) : null,
          concentration: typeof m.concentration === "string" ? m.concentration : null,
          volume: m.volume != null ? String(m.volume) : null,
          fluidCategory: typeof m.category === "string" ? m.category : null,
          agentPercent: isAgent ? numF(m.value) : null,
          clinicalEventCode: isClinicalEvent && typeof m.value === "string" ? m.value : null,
          sourceVersion: "backfill-relational-v1",
          schemaVersion: "3.0.0",
        },
      })
    }

    total += batch.length
    cursor = batch[batch.length - 1].id
    console.log(`  ...events ${total}`)
  }

  console.log(`Typed CaseEvent columns backfilled on ${total} events.`)
}

async function main() {
  console.log("1/2 - case relational rows...")
  await backfillCaseRows()
  console.log("2/2 - CaseEvent typed columns...")
  await backfillEventColumns()

  const [diag, proc, com, lab, vasc, sel, prem, comp, fields, concepts] = await Promise.all([
    prisma.preopDiagnosis.count(),
    prisma.preopProcedure.count(),
    prisma.comorbidity.count(),
    prisma.labResult.count(),
    prisma.vascularAccess.count(),
    prisma.caseSelection.count(),
    prisma.premedicationAdministration.count(),
    prisma.caseComplication.count(),
    prisma.clinicalFieldStatus.count(),
    prisma.conceptMap.count({ where: { active: true } }),
  ])
  console.log(`Rows: diagnoses=${diag} procedures=${proc} comorbidities=${com} labs=${lab} vascular=${vasc} selections=${sel} premed=${prem} complications=${comp} field_statuses=${fields} active_concepts=${concepts}`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
