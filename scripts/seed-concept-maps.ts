/**
 * Seed LOSPOR's local concept map.
 *
 * This preserves LOSPOR's local source vocabularies and enriches them with
 * OMOP standard concept IDs when a local Athena import can resolve a confident
 * mapping. Without Athena imported, rows remain explicit SOURCE_ONLY maps.
 */
import "dotenv/config"
import { INTRAOP_DRUG_CODE_ENTRIES } from "@lospor/core/catalog"
import { PrismaClient, Prisma, ConceptMappingStatus } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import fs from "fs"
import path from "path"

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } satisfies Prisma.PrismaClientOptions)
const SOURCE_VERSION = "local-bilingual-map-v2"

const KNOWN_VITALS = [
  { code: "8480-6", label: "Systolic blood pressure", conceptId: 3004249 },
  { code: "8462-4", label: "Diastolic blood pressure", conceptId: 3012888 },
  { code: "8867-4", label: "Heart rate", conceptId: 3027018 },
  { code: "59408-5", label: "Oxygen saturation in Arterial blood by Pulse oximetry", conceptId: 3016502 },
  { code: "19889-5", label: "Carbon dioxide [Partial pressure] in Exhaled gas", conceptId: 3020892 },
  { code: "8310-5", label: "Body temperature", conceptId: 3020891 },
  { code: "9279-1", label: "Respiratory rate", conceptId: 3024171 },
]

type ConceptSeed = {
  domain: string
  sourceVocabulary: string
  sourceCode: string
  sourceLabelEn?: string | null
  sourceLabelBg?: string | null
  standardVocabulary?: string | null
  standardConceptId?: number | null
  standardLabel?: string | null
  mappingStatus: ConceptMappingStatus
  mappingMethod?: string | null
  mappingConfidence?: number | null
  reviewed?: boolean
  mappingNotes?: string | null
  athenaVersion?: string | null
}

async function upsertConcept(row: ConceptSeed) {
  await prisma.conceptMap.upsert({
    where: {
      domain_sourceVocabulary_sourceCode: {
        domain: row.domain,
        sourceVocabulary: row.sourceVocabulary,
        sourceCode: row.sourceCode,
      },
    },
    update: {
      sourceLabelEn: row.sourceLabelEn ?? null,
      sourceLabelBg: row.sourceLabelBg ?? null,
      standardVocabulary: row.standardVocabulary ?? null,
      standardConceptId: row.standardConceptId ?? null,
      standardLabel: row.standardLabel ?? null,
      mappingStatus: row.mappingStatus,
      sourceVersion: SOURCE_VERSION,
      mappingMethod: row.mappingMethod ?? null,
      mappingConfidence: row.mappingConfidence ?? null,
      reviewed: row.reviewed ?? false,
      mappingNotes: row.mappingNotes ?? null,
      athenaVersion: row.athenaVersion ?? null,
      active: true,
    },
    create: {
      ...row,
      sourceLabelEn: row.sourceLabelEn ?? null,
      sourceLabelBg: row.sourceLabelBg ?? null,
      standardVocabulary: row.standardVocabulary ?? null,
      standardConceptId: row.standardConceptId ?? null,
      standardLabel: row.standardLabel ?? null,
      sourceVersion: SOURCE_VERSION,
      mappingMethod: row.mappingMethod ?? null,
      mappingConfidence: row.mappingConfidence ?? null,
      reviewed: row.reviewed ?? false,
      mappingNotes: row.mappingNotes ?? null,
      athenaVersion: row.athenaVersion ?? null,
      active: true,
    },
  })
}

async function createManyConcepts(rows: ConceptSeed[]) {
  const insertBatchSize = 1000
  const updateBatchSize = 500
  let written = 0
  for (let i = 0; i < rows.length; i += insertBatchSize) {
    const batch = rows.slice(i, i + insertBatchSize).map(row => ({
      domain: row.domain,
      sourceVocabulary: row.sourceVocabulary,
      sourceCode: row.sourceCode,
      sourceLabelEn: row.sourceLabelEn ?? null,
      sourceLabelBg: row.sourceLabelBg ?? null,
      standardVocabulary: row.standardVocabulary ?? null,
      standardConceptId: row.standardConceptId ?? null,
      standardLabel: row.standardLabel ?? null,
      mappingStatus: row.mappingStatus,
      sourceVersion: SOURCE_VERSION,
      mappingMethod: row.mappingMethod ?? null,
      mappingConfidence: row.mappingConfidence ?? null,
      reviewed: row.reviewed ?? false,
      mappingNotes: row.mappingNotes ?? null,
      athenaVersion: row.athenaVersion ?? null,
      active: true,
    }))
    const result = await prisma.conceptMap.createMany({ data: batch, skipDuplicates: true })
    written += result.count
    console.log(`  concept maps inserted ${Math.min(i + insertBatchSize, rows.length)}/${rows.length}`)
  }

  const mappedRows = rows.filter(row => row.mappingStatus === ConceptMappingStatus.MAPPED)
  for (let i = 0; i < mappedRows.length; i += updateBatchSize) {
    const batch = mappedRows.slice(i, i + updateBatchSize)
    await prisma.$executeRaw`
      UPDATE "ConceptMap" AS cm
      SET
        "sourceLabelEn" = v."sourceLabelEn",
        "sourceLabelBg" = v."sourceLabelBg",
        "standardVocabulary" = v."standardVocabulary",
        "standardConceptId" = v."standardConceptId"::integer,
        "standardLabel" = v."standardLabel",
        "mappingStatus" = v."mappingStatus"::"ConceptMappingStatus",
        "sourceVersion" = ${SOURCE_VERSION},
        "mappingMethod" = v."mappingMethod",
        "mappingConfidence" = v."mappingConfidence"::double precision,
        "reviewed" = v."reviewed"::boolean,
        "mappingNotes" = v."mappingNotes",
        "athenaVersion" = v."athenaVersion",
        "active" = true
      FROM (VALUES ${Prisma.join(batch.map(row => Prisma.sql`(
        ${row.domain},
        ${row.sourceVocabulary},
        ${row.sourceCode},
        ${row.sourceLabelEn ?? null},
        ${row.sourceLabelBg ?? null},
        ${row.standardVocabulary ?? null},
        ${row.standardConceptId ?? null},
        ${row.standardLabel ?? null},
        ${row.mappingStatus},
        ${row.mappingMethod ?? null},
        ${row.mappingConfidence ?? null},
        ${row.reviewed ?? false},
        ${row.mappingNotes ?? null},
        ${row.athenaVersion ?? null}
      )`))})
      AS v(
        "domain",
        "sourceVocabulary",
        "sourceCode",
        "sourceLabelEn",
        "sourceLabelBg",
        "standardVocabulary",
        "standardConceptId",
        "standardLabel",
        "mappingStatus",
        "mappingMethod",
        "mappingConfidence",
        "reviewed",
        "mappingNotes",
        "athenaVersion"
      )
      WHERE
        cm."domain" = v."domain" AND
        cm."sourceVocabulary" = v."sourceVocabulary" AND
        cm."sourceCode" = v."sourceCode"
    `
    written += batch.length
    console.log(`  mapped concept maps updated ${Math.min(i + updateBatchSize, mappedRows.length)}/${mappedRows.length}`)
  }

  await prisma.conceptMap.updateMany({
    where: {
      active: true,
      mappingStatus: ConceptMappingStatus.SOURCE_ONLY,
      mappingMethod: null,
    },
    data: {
      mappingMethod: "source-code-preserved",
      sourceVersion: SOURCE_VERSION,
      reviewed: false,
    },
  })
  return written
}

type StandardConcept = {
  standardVocabulary: string
  standardConceptId: number
  standardLabel: string
  mappingMethod: string
  mappingConfidence: number
  athenaVersion: string | null
}

async function latestAthenaVersion() {
  const imported = await prisma.omopVocabularyImport.findFirst({
    where: { status: "complete" },
    orderBy: { completedAt: "desc" },
    select: { vocabularyVersion: true },
  })
  if (imported?.vocabularyVersion) return imported.vocabularyVersion
  const vocab = await prisma.omopVocabulary.findFirst({
    where: { vocabularyVersion: { not: null } },
    orderBy: { importedAt: "desc" },
    select: { vocabularyVersion: true },
  })
  return vocab?.vocabularyVersion ?? null
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function resolveStandardMap(vocabularyId: string, codes: string[], athenaVersion: string | null): Promise<Map<string, StandardConcept>> {
  const uniqueCodes = [...new Set(codes.filter(Boolean))]
  const out = new Map<string, StandardConcept>()
  if (uniqueCodes.length === 0) return out

  const sourceConcepts = []
  for (const codeChunk of chunk(uniqueCodes, 1000)) {
    sourceConcepts.push(...await prisma.omopConcept.findMany({
      where: {
        vocabularyId,
        conceptCode: { in: codeChunk },
        invalidReason: null,
      },
      select: {
        conceptId: true,
        conceptCode: true,
        conceptName: true,
        vocabularyId: true,
        standardConcept: true,
      },
    }))
  }

  const nonStandardIds: number[] = []
  const sourceById = new Map<number, { conceptCode: string }>()
  for (const concept of sourceConcepts) {
    if (concept.standardConcept === "S") {
      out.set(concept.conceptCode, {
        standardVocabulary: concept.vocabularyId,
        standardConceptId: concept.conceptId,
        standardLabel: concept.conceptName,
        mappingMethod: "athena-exact-standard-code",
        mappingConfidence: 1,
        athenaVersion,
      })
    } else {
      nonStandardIds.push(concept.conceptId)
      sourceById.set(concept.conceptId, { conceptCode: concept.conceptCode })
    }
  }

  if (nonStandardIds.length === 0) return out
  const relationships = []
  for (const idChunk of chunk(nonStandardIds, 1000)) {
    relationships.push(...await prisma.omopConceptRelationship.findMany({
      where: {
        conceptId1: { in: idChunk },
        relationshipId: "Maps to",
        invalidReason: null,
      },
      select: { conceptId1: true, conceptId2: true },
    }))
  }

  const targetIds = [...new Set(relationships.map(r => r.conceptId2))]
  const targets = new Map<number, { conceptId: number; conceptName: string; vocabularyId: string }>()
  for (const idChunk of chunk(targetIds, 1000)) {
    const rows = await prisma.omopConcept.findMany({
      where: {
        conceptId: { in: idChunk },
        standardConcept: "S",
        invalidReason: null,
      },
      select: { conceptId: true, conceptName: true, vocabularyId: true },
    })
    for (const row of rows) targets.set(row.conceptId, row)
  }

  for (const rel of relationships) {
    const source = sourceById.get(rel.conceptId1)
    const target = targets.get(rel.conceptId2)
    if (!source || !target || out.has(source.conceptCode)) continue
    out.set(source.conceptCode, {
      standardVocabulary: target.vocabularyId,
      standardConceptId: target.conceptId,
      standardLabel: target.conceptName,
      mappingMethod: "athena-exact-code-maps-to",
      mappingConfidence: 0.95,
      athenaVersion,
    })
  }
  return out
}

function withStandard(seed: Omit<ConceptSeed, "mappingStatus">, standard: StandardConcept | undefined): ConceptSeed {
  if (!standard) {
    return {
      ...seed,
      mappingStatus: ConceptMappingStatus.SOURCE_ONLY,
      mappingMethod: "source-code-preserved",
      mappingConfidence: null,
      reviewed: false,
    }
  }
  return {
    ...seed,
    standardVocabulary: standard.standardVocabulary,
    standardConceptId: standard.standardConceptId,
    standardLabel: standard.standardLabel,
    mappingStatus: ConceptMappingStatus.MAPPED,
    mappingMethod: standard.mappingMethod,
    mappingConfidence: standard.mappingConfidence,
    reviewed: false,
    athenaVersion: standard.athenaVersion,
  }
}

async function main() {
  let count = 0
  const seeds: ConceptSeed[] = []
  const athenaVersion = await latestAthenaVersion()

  for (const vital of KNOWN_VITALS) {
    await upsertConcept({
      domain: "measurement",
      sourceVocabulary: "LOINC",
      sourceCode: vital.code,
      sourceLabelEn: vital.label,
      standardVocabulary: "LOINC",
      standardConceptId: vital.conceptId,
      standardLabel: vital.label,
      mappingStatus: ConceptMappingStatus.MAPPED,
      mappingMethod: "curated-vital-loinc",
      mappingConfidence: 1,
      reviewed: true,
      athenaVersion,
    })
    count++
  }

  const labs = await prisma.labLoinc.findMany()
  const labStandards = await resolveStandardMap("LOINC", labs.map(l => l.loincCode), athenaVersion)
  for (const lab of labs) {
    seeds.push(withStandard({
      domain: "measurement",
      sourceVocabulary: "LOINC",
      sourceCode: lab.loincCode,
      sourceLabelEn: lab.name,
    }, labStandards.get(lab.loincCode)))
  }

  const icd = await prisma.icd10Code.findMany()
  const icdStandards = await resolveStandardMap("ICD10", icd.map(c => c.code), athenaVersion)
  for (const code of icd) {
    seeds.push(withStandard({
      domain: "condition",
      sourceVocabulary: "ICD10",
      sourceCode: code.code,
      sourceLabelEn: code.labelEn,
      sourceLabelBg: code.labelBg,
    }, icdStandards.get(code.code)))
  }

  const atc = await prisma.atc.findMany()
  const atcStandards = await resolveStandardMap("ATC", atc.map(c => c.code), athenaVersion)
  for (const code of atc) {
    seeds.push(withStandard({
      domain: "drug",
      sourceVocabulary: "ATC",
      sourceCode: code.code,
      sourceLabelEn: code.name,
    }, atcStandards.get(code.code)))
  }

  // Intraoperative drugs, infusions, fluids and volatile agents. These are the
  // substances the register produces from its own buttons, and the one drug
  // source it never seeded: the ATC block above walks the Atc table, which
  // exists only where an Athena CONCEPT.csv has been imported, and the raw-name
  // fallback vocabulary had no rows at all. Both gaps are filled here from the
  // catalog itself, so the mapping of what is given during a case is reviewable
  // as a whole list rather than one discovered row at a time.
  const atcCodes = new Set(atc.map(code => code.code))
  const catalogAtc = INTRAOP_DRUG_CODE_ENTRIES
    .filter((entry): entry is { name: string; atcCode: string } => !!entry.atcCode)
    .filter(entry => !atcCodes.has(entry.atcCode))
  const catalogAtcStandards = await resolveStandardMap("ATC", catalogAtc.map(e => e.atcCode), athenaVersion)
  for (const entry of catalogAtc) {
    seeds.push(withStandard({
      domain: "drug",
      sourceVocabulary: "ATC",
      sourceCode: entry.atcCode,
      sourceLabelEn: entry.name,
    }, catalogAtcStandards.get(entry.atcCode)))
  }

  // The raw-name fallback. `resolveDrugConcept` reaches for this only when an
  // event carries no ATC code, so these rows can never override a coded drug —
  // which is what keeps one substance on one concept. They are seeded without
  // a concept because a drug name is not evidence of one; what they add is a
  // row to look at, so an unmapped intraoperative drug is a visible backlog
  // item rather than a silent absence.
  for (const entry of INTRAOP_DRUG_CODE_ENTRIES) {
    seeds.push({
      domain: "drug",
      sourceVocabulary: "LOSPOR_DRUG_RAW",
      sourceCode: entry.name,
      sourceLabelEn: entry.name,
      mappingStatus: ConceptMappingStatus.SOURCE_ONLY,
      mappingMethod: "source-code-preserved",
      reviewed: false,
      mappingNotes: entry.atcCode
        ? `Catalog drug; normally resolved through ATC ${entry.atcCode}. This row applies only to an event recorded without a code.`
        : "Catalog drug with no WHO ATC code. Left unmapped deliberately rather than coded to an approximate substance.",
    })
  }

  const drugs = await prisma.drug.findMany({
    where: { inn: { not: null } },
    select: { inn: true, name: true },
    distinct: ["inn"],
  })
  for (const drug of drugs) {
    if (!drug.inn) continue
    seeds.push({
      domain: "drug",
      sourceVocabulary: "INN",
      sourceCode: drug.inn,
      sourceLabelEn: drug.name,
      mappingStatus: ConceptMappingStatus.SOURCE_ONLY,
      mappingMethod: "source-code-preserved",
      reviewed: false,
      mappingNotes: "INN retained as source vocabulary; no automatic exact-code OMOP mapping is assumed.",
    })
  }

  // Procedures. The catalogue is a static ICD-10-PCS file rather than a table,
  // and it was the one vocabulary this script never seeded -- so every planned
  // procedure fell through `concept()` to an implicit SOURCE_ONLY with no row
  // behind it. The mapping existed only as an absence: nothing to audit,
  // nothing to review, and nothing for a later Athena import to fill in.
  //
  // The key must match what relational-sync writes, which uses the entry's
  // `domain` as the source vocabulary and falls back to LOSPOR_PROCEDURE.
  //
  // Standard resolution is attempted against ICD10PCS. That vocabulary is not
  // in the local Athena import today, so these stay SOURCE_ONLY; when it is
  // imported, re-running this script fills them in without touching any case.
  const pcs = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "src", "data", "pcs.json"), "utf8"),
  ) as { code: string; description?: string; group?: string; domain?: string }[]
  const pcsStandards = await resolveStandardMap("ICD10PCS", pcs.map(p => p.code), athenaVersion)
  for (const proc of pcs) {
    seeds.push(withStandard({
      domain: "procedure",
      sourceVocabulary: proc.domain || "LOSPOR_PROCEDURE",
      sourceCode: proc.code,
      sourceLabelEn: proc.group || proc.description || proc.code,
    }, pcsStandards.get(proc.code)))
  }

  const options = await prisma.optionLibrary.findMany({ where: { active: true } })
  for (const option of options) {
    seeds.push({
      domain: "observation",
      sourceVocabulary: "LOSPOR_OPTION",
      sourceCode: `${option.category}:${option.value}`,
      sourceLabelEn: option.labelEn,
      sourceLabelBg: option.labelBg,
      mappingStatus: ConceptMappingStatus.SOURCE_ONLY,
      mappingMethod: "source-code-preserved",
      reviewed: false,
    })
    seeds.push({
      domain: "observation",
      sourceVocabulary: "LOSPOR_OPTION",
      sourceCode: `${option.category.toLowerCase()}:${option.value}`,
      sourceLabelEn: option.labelEn,
      sourceLabelBg: option.labelBg,
      mappingStatus: ConceptMappingStatus.SOURCE_ONLY,
      mappingMethod: "source-code-preserved",
      reviewed: false,
    })
  }

  count += await createManyConcepts(seeds)

  const [total, mapped, curated, rejected, sourceOnly, unmapped] = await Promise.all([
    prisma.conceptMap.count({ where: { active: true } }),
    prisma.conceptMap.count({ where: { active: true, mappingStatus: ConceptMappingStatus.MAPPED } }),
    prisma.conceptMap.count({ where: { active: true, mappingStatus: ConceptMappingStatus.MANUALLY_CURATED } }),
    prisma.conceptMap.count({ where: { active: true, mappingStatus: ConceptMappingStatus.REJECTED } }),
    prisma.conceptMap.count({ where: { active: true, mappingStatus: ConceptMappingStatus.SOURCE_ONLY } }),
    prisma.conceptMap.count({ where: { active: true, mappingStatus: ConceptMappingStatus.UNMAPPED } }),
  ])

  console.log(`Seeded/updated ${count} local concept map rows.`)
  console.log(`Active concept maps: total=${total} mapped=${mapped} manually_curated=${curated} rejected=${rejected} source_only=${sourceOnly} unmapped=${unmapped}`)
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
