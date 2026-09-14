/**
 * Build the bundled ICD-10-PCS research codes from an Athena download.
 *
 *   npx tsx scripts/generate-icd10pcs-omop.mts --athena <unzipped Athena folder>
 *
 * A planned procedure recorded as an exact ICD-10-PCS operation needs its OMOP
 * concept id to reach the research export and Central. ICD-10-PCS is a US
 * public-domain classification and its concepts are standard OMOP procedure
 * concepts, so the ids for LOSPOR's 82,121 codes can ship with the release
 * rather than wait for a site's licensed terminology import.
 *
 * Written to src/data/icd10pcs-omop.json:
 *   - a code whose own concept is standard carries that id;
 *   - a code Athena maps to exactly one standard RxNorm or RxNorm Extension
 *     concept (drug administrations) carries that target;
 *   - codes mapping to SNOMED, to several targets, or to nothing are left out,
 *     and stay source-only until a site's import resolves them.
 */

import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const athena = argument("--athena")
if (!athena) throw new Error("Usage: generate-icd10pcs-omop.mts --athena <unzipped Athena folder>")

const BUNDLE_TARGETS = new Set(["RxNorm", "RxNorm Extension"])
const pcs = JSON.parse(fs.readFileSync(path.join(process.cwd(), "src", "data", "pcs.json"), "utf8")) as { code: string }[]
const wanted = new Set(pcs.map(row => row.code))

async function each(file: string, fn: (columns: string[]) => void) {
  const lines = readline.createInterface({ input: fs.createReadStream(path.join(athena!, file)), crlfDelay: Infinity })
  let header = true
  for await (const line of lines) {
    if (header) { header = false; continue }
    fn(line.split("\t"))
  }
}

const vocabularyLine = fs.readFileSync(path.join(athena, "VOCABULARY.csv"), "utf8")
  .split(/\r?\n/).find(line => line.startsWith("ICD10PCS\t"))
if (!vocabularyLine) throw new Error("This Athena download has no ICD10PCS vocabulary")
const version = vocabularyLine.split("\t")[3]

// CONCEPT.csv: concept_id, name, domain, vocabulary, class, standard, code, start, end, invalid
const source = new Map<string, { code: string; standard: boolean }>()
await each("CONCEPT.csv", c => {
  if (c[3] === "ICD10PCS" && !c[9] && wanted.has(c[6])) source.set(c[0], { code: c[6], standard: c[5] === "S" })
})

const mapsTo = new Map<string, string[]>()
await each("CONCEPT_RELATIONSHIP.csv", r => {
  const from = source.get(r[0])
  if (!from || from.standard || r[2] !== "Maps to" || r[5] || r[0] === r[1]) return
  mapsTo.set(r[0], [...(mapsTo.get(r[0]) ?? []), r[1]])
})

const targetIds = new Set([...mapsTo.values()].flat())
const targets = new Map<string, { vocabulary: string; standard: boolean }>()
await each("CONCEPT.csv", c => {
  if (targetIds.has(c[0])) targets.set(c[0], { vocabulary: c[3], standard: c[5] === "S" && !c[9] })
})

const concepts: Record<string, number> = {}
const mapped: Record<string, { conceptId: number; vocabulary: string }> = {}
const left = { snomedOrOther: 0, several: 0, none: 0, notInAthena: wanted.size - source.size }
for (const [id, row] of source) {
  if (row.standard) { concepts[row.code] = Number(id); continue }
  const standard = (mapsTo.get(id) ?? []).filter(target => targets.get(target)?.standard)
  if (standard.length === 0) { left.none++; continue }
  if (standard.length > 1) { left.several++; continue }
  const vocabulary = targets.get(standard[0])!.vocabulary
  if (!BUNDLE_TARGETS.has(vocabulary)) { left.snomedOrOther++; continue }
  mapped[row.code] = { conceptId: Number(standard[0]), vocabulary }
}

const sorted = <T,>(record: Record<string, T>) =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
const output = {
  source: `OHDSI Athena, ${version}`,
  standardVocabulary: "ICD10PCS",
  concepts: sorted(concepts),
  mapsTo: sorted(mapped),
}
fs.writeFileSync(path.join(process.cwd(), "src", "data", "icd10pcs-omop.json"), `${JSON.stringify(output)}\n`)
console.log(`${version}: ${Object.keys(concepts).length} standard, ${Object.keys(mapped).length} mapped to RxNorm; left out`, left)
