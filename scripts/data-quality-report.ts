/**
 * Non-destructive research data quality report.
 *
 * It reports problems and coverage gaps only. Run deterministic repair/backfill
 * scripts separately after reviewing this output.
 */
import "dotenv/config"
import { PrismaClient, Prisma } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } satisfies Prisma.PrismaClientOptions)

type JsonItem = Record<string, unknown>
const arr = (v: unknown): JsonItem[] => Array.isArray(v) ? v as JsonItem[] : []

function rowsFromDrugList(raw: unknown): number {
  if (Array.isArray(raw)) return raw.length
  if (typeof raw !== "string" || !raw.trim()) return 0
  const trimmed = raw.trim()
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed)
      return Array.isArray(parsed) ? parsed.length : 0
    } catch {
      return 0
    }
  }
  return trimmed.split(/[,\n]+/).map(s => s.trim()).filter(Boolean).length
}

function rowsFromComplications(raw: unknown): number {
  return typeof raw === "string" && raw.trim()
    ? raw.split(";").map(s => s.trim()).filter(Boolean).length
    : 0
}

function rowsFromPremed(raw: unknown): number {
  return typeof raw === "string" && raw.trim()
    ? raw.split(/[;\n]+/).map(s => s.trim()).filter(Boolean).length
    : 0
}

async function driftReport() {
  const cases = await prisma.case.findMany({
    select: {
      id: true,
      preop: {
        select: {
          id: true,
          diagnosesJson: true,
          proceduresJson: true,
          comorbidities: true,
          labResults: true,
          currentMedications: true,
          allergyDetails: true,
          _count: { select: { diagnoses: true, procedureRows: true, comorbidityRows: true, labRows: true, medications: true } },
        },
      },
      intraop: {
        select: {
          id: true,
          vascularAccesses: true,
          premedicationEvening: true,
          premedicationMorning: true,
          complications: true,
          _count: { select: { vascularAccessRows: true, premedicationRows: true } },
        },
      },
      postop: { select: { complications: true } },
      _count: { select: { complications: true, selections: true, fieldStatuses: true } },
    },
  })

  const drift: string[] = []
  for (const c of cases) {
    if (c.preop) {
      const expectedMeds = rowsFromDrugList(c.preop.currentMedications) + rowsFromDrugList(c.preop.allergyDetails)
      if (arr(c.preop.diagnosesJson).length !== c.preop._count.diagnoses) drift.push(`${c.id}: diagnoses JSON=${arr(c.preop.diagnosesJson).length} rows=${c.preop._count.diagnoses}`)
      if (arr(c.preop.proceduresJson).length !== c.preop._count.procedureRows) drift.push(`${c.id}: procedures JSON=${arr(c.preop.proceduresJson).length} rows=${c.preop._count.procedureRows}`)
      if (arr(c.preop.comorbidities).length !== c.preop._count.comorbidityRows) drift.push(`${c.id}: comorbidities JSON=${arr(c.preop.comorbidities).length} rows=${c.preop._count.comorbidityRows}`)
      if (arr(c.preop.labResults).filter(l => l.test != null).length !== c.preop._count.labRows) drift.push(`${c.id}: labs JSON=${arr(c.preop.labResults).length} rows=${c.preop._count.labRows}`)
      if (expectedMeds !== c.preop._count.medications) drift.push(`${c.id}: medications parsed=${expectedMeds} rows=${c.preop._count.medications}`)
    }
    if (c.intraop) {
      const expectedPremed = rowsFromPremed(c.intraop.premedicationEvening) + rowsFromPremed(c.intraop.premedicationMorning)
      if (arr(c.intraop.vascularAccesses).length !== c.intraop._count.vascularAccessRows) drift.push(`${c.id}: vascular JSON=${arr(c.intraop.vascularAccesses).length} rows=${c.intraop._count.vascularAccessRows}`)
      if (expectedPremed !== c.intraop._count.premedicationRows) drift.push(`${c.id}: premed parsed=${expectedPremed} rows=${c.intraop._count.premedicationRows}`)
    }
    const expectedComp = rowsFromComplications(c.intraop?.complications) + rowsFromComplications(c.postop?.complications)
    if (expectedComp !== c._count.complications) drift.push(`${c.id}: complications parsed=${expectedComp} rows=${c._count.complications}`)
    if (c._count.fieldStatuses === 0) drift.push(`${c.id}: no ClinicalFieldStatus rows`)
  }

  return drift
}

async function main() {
  const [
    caseCount,
    athenaImport,
    athenaConcepts,
    conceptTotal,
    conceptMapped,
    conceptSourceOnly,
    conceptUnmapped,
    conceptReviewed,
    rowSourceOnly,
    rowUnmapped,
    missing,
    invalidFio2,
    invalidBgl,
    futureEvents,
    exactEventTimestamps,
    complicationNotes,
    institutionLinkedCases,
    drift,
  ] = await Promise.all([
    prisma.case.count(),
    prisma.omopVocabularyImport.findFirst({
      where: { status: "complete" },
      orderBy: { completedAt: "desc" },
      select: { vocabularyVersion: true, completedAt: true, importedTables: true },
    }),
    prisma.omopConcept.count(),
    prisma.conceptMap.count({ where: { active: true } }),
    prisma.conceptMap.count({ where: { active: true, mappingStatus: "MAPPED" } }),
    prisma.conceptMap.count({ where: { active: true, mappingStatus: "SOURCE_ONLY" } }),
    prisma.conceptMap.count({ where: { active: true, mappingStatus: "UNMAPPED" } }),
    prisma.conceptMap.count({ where: { active: true, reviewed: true } }),
    Promise.all([
      prisma.preopDiagnosis.count({ where: { mappingStatus: "SOURCE_ONLY" } }),
      prisma.preopProcedure.count({ where: { mappingStatus: "SOURCE_ONLY" } }),
      prisma.comorbidity.count({ where: { mappingStatus: "SOURCE_ONLY" } }),
      prisma.labResult.count({ where: { mappingStatus: "SOURCE_ONLY" } }),
      prisma.medication.count({ where: { mappingStatus: "SOURCE_ONLY" } }),
      prisma.vascularAccess.count({ where: { mappingStatus: "SOURCE_ONLY" } }),
      prisma.premedicationAdministration.count({ where: { mappingStatus: "SOURCE_ONLY" } }),
      prisma.caseComplication.count({ where: { mappingStatus: "SOURCE_ONLY" } }),
      prisma.caseSelection.count({ where: { mappingStatus: "SOURCE_ONLY" } }),
    ]).then(xs => xs.reduce((a, b) => a + b, 0)),
    Promise.all([
      prisma.preopDiagnosis.count({ where: { mappingStatus: "UNMAPPED" } }),
      prisma.preopProcedure.count({ where: { mappingStatus: "UNMAPPED" } }),
      prisma.comorbidity.count({ where: { mappingStatus: "UNMAPPED" } }),
      prisma.labResult.count({ where: { mappingStatus: "UNMAPPED" } }),
      prisma.medication.count({ where: { mappingStatus: "UNMAPPED" } }),
      prisma.vascularAccess.count({ where: { mappingStatus: "UNMAPPED" } }),
      prisma.premedicationAdministration.count({ where: { mappingStatus: "UNMAPPED" } }),
      prisma.caseComplication.count({ where: { mappingStatus: "UNMAPPED" } }),
      prisma.caseSelection.count({ where: { mappingStatus: "UNMAPPED" } }),
    ]).then(xs => xs.reduce((a, b) => a + b, 0)),
    prisma.clinicalFieldStatus.groupBy({ by: ["presence"], _count: true }),
    prisma.caseEvent.count({ where: { OR: [{ fio2Percent: { lt: 21 } }, { fio2Percent: { gt: 100 } }] } }),
    prisma.caseEvent.count({ where: { OR: [{ bgl: { lt: 0 } }, { bgl: { gt: 60 } }] } }),
    prisma.caseEvent.count({ where: { timestamp: { gt: new Date(Date.now() + 24 * 60 * 60 * 1000) } } }),
    prisma.caseEvent.count({ where: { status: "active" } }),
    prisma.caseComplication.count({ where: { note: { not: null } } }),
    prisma.case.count({ where: { OR: [{ institutionId: { not: null } }, { user: { institutionId: { not: null } } }] } }),
    driftReport(),
  ])

  console.log("LOSPOR data quality report")
  console.log(`Cases: ${caseCount}`)
  console.log(`Athena import: concepts=${athenaConcepts} latest=${athenaImport?.vocabularyVersion ?? "none"} completed=${athenaImport?.completedAt?.toISOString() ?? "never"}`)
  console.log(`ConceptMap active: total=${conceptTotal} mapped=${conceptMapped} source_only=${conceptSourceOnly} unmapped=${conceptUnmapped} reviewed=${conceptReviewed}`)
  console.log(`Normalized row mappings: source_only=${rowSourceOnly} unmapped=${rowUnmapped}`)
  console.log("ClinicalFieldStatus:")
  for (const row of missing) console.log(`  ${row.presence}: ${row._count}`)
  console.log(`Invalid FiO2 rows: ${invalidFio2}`)
  console.log(`Invalid BGL rows: ${invalidBgl}`)
  console.log(`Future CaseEvent rows (>24h): ${futureEvents}`)
  console.log(`Exact active event timestamps retained: ${exactEventTimestamps}`)
  console.log(`Complication rows with notes requiring redaction review: ${complicationNotes}`)
  console.log(`Cases with institution/care-site linkage: ${institutionLinkedCases}`)
  console.log(`Relational drift findings: ${drift.length}`)
  for (const line of drift.slice(0, 50)) console.log(`  ${line}`)
  if (drift.length > 50) console.log(`  ...${drift.length - 50} more`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
