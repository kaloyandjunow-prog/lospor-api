/**
 * Import local Athena/OMOP vocabulary CSV files into LOSPOR's local mapping tables.
 *
 * Usage:
 *   npx tsx scripts/seed-athena-vocabularies.ts --vocab-dir C:\path\to\athena
 *   npx tsx scripts/seed-athena-vocabularies.ts --vocab-dir C:\path\to\athena --replace
 *   npx tsx scripts/seed-athena-vocabularies.ts --vocab-dir C:\path\to\athena --filtered-lospor --replace-athena
 *
 * Expected files are the standard Athena CSV/TSV exports:
 * VOCABULARY.csv, DOMAIN.csv, CONCEPT.csv, CONCEPT_RELATIONSHIP.csv,
 * CONCEPT_ANCESTOR.csv, CONCEPT_SYNONYM.csv. Missing optional files are skipped.
 */
import "dotenv/config"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { randomUUID } from "node:crypto"
import { PrismaClient, Prisma } from "../src/generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) } satisfies Prisma.PrismaClientOptions)

const args = process.argv.slice(2)
const vocabDir = args[args.indexOf("--vocab-dir") + 1]
const replace = args.includes("--replace")
const filteredLospor = args.includes("--filtered-lospor")
const replaceAthena = replace || args.includes("--replace-athena")
const batchSize = Number(args[args.indexOf("--batch-size") + 1] ?? 5000)

if (!vocabDir || vocabDir.startsWith("--")) {
  console.error("Missing --vocab-dir <path-to-athena-csvs>")
  process.exit(1)
}

type Row = Record<string, string>

const VITAL_LOINC_CODES = [
  "8480-6",
  "8462-4",
  "8867-4",
  "59408-5",
  "19889-5",
  "8310-5",
  "9279-1",
  "2345-7",
]

function filePath(name: string) {
  const candidates = [name, name.toLowerCase(), name.toUpperCase()]
  for (const candidate of candidates) {
    const p = path.join(vocabDir, candidate)
    if (fs.existsSync(p)) return p
  }
  return null
}

function parseLine(line: string, delimiter: string): string[] {
  if (delimiter === "\t") return line.split("\t")
  const out: string[] = []
  let current = ""
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    const next = line[i + 1]
    if (ch === '"' && quoted && next === '"') {
      current += '"'
      i++
    } else if (ch === '"') {
      quoted = !quoted
    } else if (ch === delimiter && !quoted) {
      out.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  out.push(current)
  return out
}

function toInt(v: string | undefined): number | null {
  if (!v) return null
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : null
}

function toDate(v: string | undefined): Date | null {
  if (!v) return null
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(v)
  const d = compact ? new Date(`${compact[1]}-${compact[2]}-${compact[3]}T00:00:00.000Z`) : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

async function readRows(file: string, onBatch: (rows: Row[]) => Promise<void>) {
  const stream = fs.createReadStream(file, { encoding: "utf8" })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let headers: string[] | null = null
  let delimiter = "\t"
  let batch: Row[] = []

  for await (const lineRaw of rl) {
    const line = lineRaw.replace(/^\uFEFF/, "")
    if (!headers) {
      delimiter = line.includes("\t") ? "\t" : ","
      headers = parseLine(line, delimiter).map(h => h.trim().toLowerCase())
      continue
    }
    if (!line.trim()) continue
    const values = parseLine(line, delimiter)
    const row: Row = {}
    headers.forEach((h, i) => { row[h] = values[i] ?? "" })
    batch.push(row)
    if (batch.length >= batchSize) {
      await onBatch(batch)
      batch = []
    }
  }
  if (batch.length > 0) await onBatch(batch)
}

async function importFile<T>(name: string, mapper: (row: Row) => T, write: (rows: T[]) => Promise<number>) {
  const p = filePath(name)
  if (!p) {
    console.log(`Skipping missing ${name}`)
    return 0
  }
  let count = 0
  await readRows(p, async rows => {
    const mapped = rows.map(mapper).filter(Boolean) as T[]
    if (mapped.length === 0) return
    count += await write(mapped)
    console.log(`  ${name}: ${count}`)
  })
  return count
}

async function clearAthenaTables() {
  await prisma.$transaction([
    prisma.omopConceptSynonym.deleteMany(),
    prisma.omopConceptAncestor.deleteMany(),
    prisma.omopConceptRelationship.deleteMany(),
    prisma.omopConcept.deleteMany(),
    prisma.omopDomain.deleteMany(),
    prisma.omopVocabulary.deleteMany(),
  ])
}

async function importVocabularyAndDomains(importedTables: Record<string, number>) {
  importedTables.VOCABULARY = await importFile("VOCABULARY.csv", row => ({
    vocabularyId: row.vocabulary_id,
    vocabularyName: row.vocabulary_name || null,
    vocabularyReference: row.vocabulary_reference || null,
    vocabularyVersion: row.vocabulary_version || null,
    vocabularyConceptId: toInt(row.vocabulary_concept_id),
  }), async rows => (await prisma.omopVocabulary.createMany({ data: rows, skipDuplicates: true })).count)

  importedTables.DOMAIN = await importFile("DOMAIN.csv", row => ({
    domainId: row.domain_id,
    domainName: row.domain_name || null,
    domainConceptId: toInt(row.domain_concept_id),
  }), async rows => (await prisma.omopDomain.createMany({ data: rows, skipDuplicates: true })).count)
}

type ConceptImportRow = {
  conceptId: number
  conceptName: string
  domainId: string
  vocabularyId: string
  conceptClassId: string
  standardConcept: string | null
  conceptCode: string
  validStartDate: Date | null
  validEndDate: Date | null
  invalidReason: string | null
}

function mapConcept(row: Row): ConceptImportRow {
  return {
    conceptId: toInt(row.concept_id) ?? 0,
    conceptName: row.concept_name || "",
    domainId: row.domain_id || "",
    vocabularyId: row.vocabulary_id || "",
    conceptClassId: row.concept_class_id || "",
    standardConcept: row.standard_concept || null,
    conceptCode: row.concept_code || "",
    validStartDate: toDate(row.valid_start_date),
    validEndDate: toDate(row.valid_end_date),
    invalidReason: row.invalid_reason || null,
  }
}

async function importFilteredLosporConcepts(): Promise<{ count: number; sourceConceptIds: Set<number>; sourceConceptCount: number }> {
  const [labs, icd, atc] = await Promise.all([
    prisma.labLoinc.findMany({ select: { loincCode: true } }),
    prisma.icd10Code.findMany({ select: { code: true } }),
    prisma.atc.findMany({ select: { code: true } }),
  ])
  const requiredCodes = {
    LOINC: new Set([...labs.map(l => l.loincCode), ...VITAL_LOINC_CODES]),
    ICD10: new Set(icd.map(c => c.code)),
    ICD10CM: new Set(icd.map(c => c.code)),
    ATC: new Set(atc.map(c => c.code)),
  }

  const conceptFile = filePath("CONCEPT.csv")
  if (!conceptFile) throw new Error("CONCEPT.csv not found")

  let count = 0
  const sourceConceptIds = new Set<number>()
  await readRows(conceptFile, async rows => {
    const concepts = rows
      .map(mapConcept)
      .filter(c => c.conceptId > 0 && (
        (c.vocabularyId === "LOINC" && requiredCodes.LOINC.has(c.conceptCode)) ||
        (c.vocabularyId === "ICD10" && requiredCodes.ICD10.has(c.conceptCode)) ||
        (c.vocabularyId === "ICD10CM" && requiredCodes.ICD10CM.has(c.conceptCode)) ||
        (c.vocabularyId === "ATC" && requiredCodes.ATC.has(c.conceptCode))
      ))
    if (concepts.length === 0) return
    for (const concept of concepts) sourceConceptIds.add(concept.conceptId)
    count += (await prisma.omopConcept.createMany({ data: concepts, skipDuplicates: true })).count
    console.log(`  CONCEPT.csv filtered source concepts: ${count}`)
  })

  return { count, sourceConceptIds, sourceConceptCount: sourceConceptIds.size }
}

async function importFilteredMapsTo(sourceConceptIds: Set<number>): Promise<{ count: number; targetConceptIds: Set<number> }> {
  const relationshipFile = filePath("CONCEPT_RELATIONSHIP.csv")
  if (!relationshipFile) throw new Error("CONCEPT_RELATIONSHIP.csv not found")

  let count = 0
  const targetConceptIds = new Set<number>()
  await readRows(relationshipFile, async rows => {
    const relationships = rows
      .map(row => ({
        id: randomUUID(),
        conceptId1: toInt(row.concept_id_1) ?? 0,
        conceptId2: toInt(row.concept_id_2) ?? 0,
        relationshipId: row.relationship_id || "",
        validStartDate: toDate(row.valid_start_date),
        validEndDate: toDate(row.valid_end_date),
        invalidReason: row.invalid_reason || null,
      }))
      .filter(r =>
        r.conceptId1 > 0 &&
        r.conceptId2 > 0 &&
        r.relationshipId === "Maps to" &&
        r.invalidReason == null &&
        sourceConceptIds.has(r.conceptId1)
      )
    if (relationships.length === 0) return
    for (const relationship of relationships) targetConceptIds.add(relationship.conceptId2)
    count += (await prisma.omopConceptRelationship.createMany({ data: relationships, skipDuplicates: true })).count
    console.log(`  CONCEPT_RELATIONSHIP.csv filtered Maps to: ${count}`)
  })
  return { count, targetConceptIds }
}

async function importFilteredTargetConcepts(targetConceptIds: Set<number>): Promise<number> {
  if (targetConceptIds.size === 0) return 0
  const conceptFile = filePath("CONCEPT.csv")
  if (!conceptFile) throw new Error("CONCEPT.csv not found")

  let count = 0
  await readRows(conceptFile, async rows => {
    const concepts = rows
      .map(mapConcept)
      .filter(c => c.conceptId > 0 && targetConceptIds.has(c.conceptId))
    if (concepts.length === 0) return
    count += (await prisma.omopConcept.createMany({ data: concepts, skipDuplicates: true })).count
    console.log(`  CONCEPT.csv filtered target concepts: ${count}`)
  })
  return count
}

async function importFilteredLospor(importedTables: Record<string, number>) {
  await importVocabularyAndDomains(importedTables)
  const source = await importFilteredLosporConcepts()
  const mapsTo = await importFilteredMapsTo(source.sourceConceptIds)
  const targetConcepts = await importFilteredTargetConcepts(mapsTo.targetConceptIds)
  importedTables.CONCEPT = source.count + targetConcepts
  importedTables.CONCEPT_SOURCE_IDS = source.sourceConceptCount
  importedTables.CONCEPT_RELATIONSHIP = mapsTo.count
  importedTables.CONCEPT_TARGET_IDS = mapsTo.targetConceptIds.size
  importedTables.CONCEPT_ANCESTOR = 0
  importedTables.CONCEPT_SYNONYM = 0
}

async function main() {
  const started = await prisma.omopVocabularyImport.create({
    data: {
      sourceDirectory: path.resolve(vocabDir),
      importedTables: {},
      status: "started",
    },
  })

  const importedTables: Record<string, number> = {}
  try {
    if (replaceAthena) {
      await clearAthenaTables()
    }

    if (filteredLospor) {
      await importFilteredLospor(importedTables)
    } else {
      await importVocabularyAndDomains(importedTables)

      importedTables.CONCEPT = await importFile("CONCEPT.csv", mapConcept, async rows => (await prisma.omopConcept.createMany({ data: rows.filter(r => r.conceptId > 0), skipDuplicates: true })).count)

      importedTables.CONCEPT_RELATIONSHIP = await importFile("CONCEPT_RELATIONSHIP.csv", row => ({
        id: randomUUID(),
        conceptId1: toInt(row.concept_id_1) ?? 0,
        conceptId2: toInt(row.concept_id_2) ?? 0,
        relationshipId: row.relationship_id || "",
        validStartDate: toDate(row.valid_start_date),
        validEndDate: toDate(row.valid_end_date),
        invalidReason: row.invalid_reason || null,
      }), async rows => (await prisma.omopConceptRelationship.createMany({ data: rows.filter(r => r.conceptId1 > 0 && r.conceptId2 > 0 && r.relationshipId), skipDuplicates: true })).count)

      importedTables.CONCEPT_ANCESTOR = await importFile("CONCEPT_ANCESTOR.csv", row => ({
        id: randomUUID(),
        ancestorConceptId: toInt(row.ancestor_concept_id) ?? 0,
        descendantConceptId: toInt(row.descendant_concept_id) ?? 0,
        minLevelsOfSeparation: toInt(row.min_levels_of_separation),
        maxLevelsOfSeparation: toInt(row.max_levels_of_separation),
      }), async rows => (await prisma.omopConceptAncestor.createMany({ data: rows.filter(r => r.ancestorConceptId > 0 && r.descendantConceptId > 0), skipDuplicates: true })).count)

      importedTables.CONCEPT_SYNONYM = await importFile("CONCEPT_SYNONYM.csv", row => ({
        id: randomUUID(),
        conceptId: toInt(row.concept_id) ?? 0,
        conceptSynonymName: row.concept_synonym_name || "",
        languageConceptId: toInt(row.language_concept_id),
      }), async rows => (await prisma.omopConceptSynonym.createMany({ data: rows.filter(r => r.conceptId > 0 && r.conceptSynonymName), skipDuplicates: true })).count)
    }

    const latestVocabulary = await prisma.omopVocabulary.findFirst({
      where: { vocabularyVersion: { not: null } },
      orderBy: { importedAt: "desc" },
      select: { vocabularyVersion: true },
    })

    await prisma.omopVocabularyImport.update({
      where: { id: started.id },
      data: {
        importedTables,
        vocabularyVersion: latestVocabulary?.vocabularyVersion ?? null,
        completedAt: new Date(),
        status: "complete",
      },
    })

    console.log("Athena vocabulary import complete.")
    console.log(importedTables)
  } catch (error) {
    await prisma.omopVocabularyImport.update({
      where: { id: started.id },
      data: {
        importedTables,
        completedAt: new Date(),
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
    })
    throw error
  }
}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
