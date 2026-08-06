/**
 * Proves the bundled offline vocabulary returns exactly what the live search
 * endpoints return, for a corpus of realistic queries.
 *
 * The point of moving ranking into core was that offline results should be
 * identical, not merely similar. This is the check that makes that claim
 * testable rather than hopeful. Run after regenerating the vocabulary:
 *   npx tsx scripts/verify-vocabulary-parity.mts
 */
import fs from "node:fs"
import path from "node:path"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient } from "../src/generated/prisma/client"
import {
  ICD10_CODE_CONFIDENCE,
  ICD10_CODE_TAKE,
  ICD10_LABEL_PREFIX_MAX_LENGTH,
  ICD10_LABEL_TAKE,
  isIcd10CodeLikeQuery,
  mergeIcd10Results,
  searchIcd10,
  searchProcedures,
  type Icd10SearchRow,
  type ProcedureSearchRow,
} from "@lospor/core/search"
import { icd10Rows, procedureRows } from "@lospor/core/vocabulary"

const ICD10_QUERIES = [
  "I2", "I21", "I50", "J44", "E11", "N18", "C34", "K80", "S72", "O82",
  "diabetes", "hypertension", "asthma", "fracture", "pneumonia", "sepsis",
  "carcinoma", "failure", "obstruct", "anaemia",
  "диабет", "хипертония", "астма", "фрактура", "пневмония", "инфаркт",
  "сепсис", "недостатъчност", "карцином", "анемия",
]

const PROCEDURE_QUERIES = [
  "chole", "cholecystectomy", "append", "colectomy", "hernia", "hip",
  "knee", "caesarean", "hysterectomy", "craniotomy", "cataract",
  "bypass", "valve", "nephrectomy", "thyroid", "mastectomy",
  "amputation", "laminectomy", "resection", "graft",
]

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
})

/** The route's exact query plan, run against the real database. */
async function liveIcd10(q: string, locale: "en" | "bg") {
  const useBg = locale === "bg"
  const term = q.toLowerCase()
  const byCode = await prisma.icd10Code.findMany({
    where: { code: { startsWith: q.toUpperCase() } },
    orderBy: { code: "asc" },
    take: ICD10_CODE_TAKE,
  })
  if (isIcd10CodeLikeQuery(q) || byCode.length >= ICD10_CODE_CONFIDENCE) {
    return mergeIcd10Results([byCode], useBg)
  }
  const labelFilter =
    q.length < ICD10_LABEL_PREFIX_MAX_LENGTH
      ? { startsWith: term, mode: "insensitive" as const }
      : { contains: term, mode: "insensitive" as const }
  const [byBgLabel, byEnLabel] = await Promise.all([
    useBg
      ? prisma.icd10Code.findMany({
          where: { labelBg: labelFilter }, orderBy: { code: "asc" }, take: ICD10_LABEL_TAKE,
        })
      : Promise.resolve([] as Icd10SearchRow[]),
    prisma.icd10Code.findMany({
      where: { labelEn: labelFilter }, orderBy: { code: "asc" }, take: ICD10_LABEL_TAKE,
    }),
  ])
  return mergeIcd10Results([byBgLabel, byCode, byEnLabel], useBg)
}

let checked = 0
let mismatches = 0
let emptyBoth = 0

for (const locale of ["en", "bg"] as const) {
  for (const query of ICD10_QUERIES) {
    const live = await liveIcd10(query, locale)
    const offline = searchIcd10(icd10Rows(), query, locale)
    checked += 1
    if (live.length === 0 && offline.length === 0) emptyBoth += 1
    if (JSON.stringify(live) !== JSON.stringify(offline)) {
      mismatches += 1
      console.log(`\nICD-10 MISMATCH  "${query}" (${locale})`)
      console.log(`  live:    ${live.map(r => r.code).join(", ") || "(none)"}`)
      console.log(`  offline: ${offline.map(r => r.code).join(", ") || "(none)"}`)
    }
  }
}

// Procedures: the server searches every PCS row, the bundle one row per group.
// Compare the GROUPS returned — that is what the picker displays and stores.
const pcs = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "src", "data", "pcs.json"), "utf8"),
) as ProcedureSearchRow[]

let procChecked = 0
let procGroupMismatch = 0

for (const query of PROCEDURE_QUERIES) {
  const live = searchProcedures(pcs, query).map(r => r.group)
  const offline = searchProcedures(procedureRows(), query).map(r => r.group)
  procChecked += 1
  if (JSON.stringify(live) !== JSON.stringify(offline)) {
    procGroupMismatch += 1
    const missing = live.filter(g => !offline.includes(g))
    const extra = offline.filter(g => !live.includes(g))
    console.log(`\nPROCEDURE DIFF   "${query}"`)
    console.log(`  live ${live.length} groups, offline ${offline.length}`)
    if (missing.length) console.log(`  only online:  ${missing.slice(0, 5).join(" | ")}`)
    if (extra.length) console.log(`  only offline: ${extra.slice(0, 5).join(" | ")}`)
  }
}

console.log(`\n─── parity ───────────────────────────────`)
console.log(`ICD-10:     ${checked - mismatches}/${checked} identical  (${emptyBoth} empty on both sides)`)
console.log(`Procedures: ${procChecked - procGroupMismatch}/${procChecked} identical group lists`)
console.log(`vocabulary: ${icd10Rows().length} codes, ${procedureRows().length} groups`)

await prisma.$disconnect()
process.exit(mismatches > 0 ? 1 : 0)
