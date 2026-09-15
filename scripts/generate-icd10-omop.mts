/**
 * Build the bundled ICD-10 research numbers from an Athena download.
 *
 *   npx tsx scripts/generate-icd10-omop.mts --athena <unzipped Athena folder>
 *
 * ICD-10 is not a standard OMOP vocabulary: a diagnosis is exported under the
 * standard concept its code maps to, which is SNOMED CT (or, for a few codes,
 * OMOP Extension). SNOMED CT is licensed and Bulgaria is not a SNOMED
 * International member, so this file holds OMOP concept ids only -- integers
 * OHDSI assigns -- and no SNOMED code, name or description. That is all an
 * OMOP export needs: condition_concept_id is the number, and
 * condition_source_value keeps LOSPOR's ICD-10 code.
 *
 * Written to src/data/icd10-omop.json, for every ICD-10 code LOSPOR holds that
 * Athena has as an active ICD10 concept:
 *   maps[code]     every active standard target id of its "Maps to" rows,
 *                  ascending (one for most codes, several for a combination
 *                  such as E11.2, diabetes with kidney complication);
 *   vocabularies   the vocabulary of any target that is not SNOMED.
 * Codes Athena does not have (the NHIS national extensions) are absent.
 */

import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { icd10Rows } from "@lospor/core/vocabulary"

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const athena = argument("--athena")
if (!athena) throw new Error("Usage: generate-icd10-omop.mts --athena <unzipped Athena folder>")

const wanted = new Set(icd10Rows().map(row => row.code).filter(code => !code.includes("-")))

async function each(file: string, fn: (columns: string[]) => void) {
  const lines = readline.createInterface({ input: fs.createReadStream(path.join(athena!, file)), crlfDelay: Infinity })
  let header = true
  for await (const line of lines) {
    if (header) { header = false; continue }
    fn(line.split("\t"))
  }
}

const vocabularyLine = fs.readFileSync(path.join(athena, "VOCABULARY.csv"), "utf8")
  .split(/\r?\n/).find(line => line.startsWith("ICD10\t"))
if (!vocabularyLine) throw new Error("This Athena download has no ICD10 vocabulary")
const version = vocabularyLine.split("\t")[3]

// CONCEPT.csv: concept_id, name, domain, vocabulary, class, standard, code, start, end, invalid
const source = new Map<string, string>()
await each("CONCEPT.csv", c => {
  if (c[3] === "ICD10" && !c[9] && wanted.has(c[6])) source.set(c[0], c[6])
})

const mapsTo = new Map<string, Set<string>>()
await each("CONCEPT_RELATIONSHIP.csv", r => {
  if (r[2] !== "Maps to" || r[5] || !source.has(r[0]) || r[0] === r[1]) return
  const targets = mapsTo.get(r[0]) ?? new Set<string>()
  targets.add(r[1])
  mapsTo.set(r[0], targets)
})

const targetIds = new Set([...mapsTo.values()].flatMap(targets => [...targets]))
const targets = new Map<string, string>()
await each("CONCEPT.csv", c => {
  if (targetIds.has(c[0]) && c[5] === "S" && !c[9]) targets.set(c[0], c[3])
})

const maps: Record<string, number[]> = {}
const vocabularies: Record<string, string> = {}
const counts = { one: 0, several: 0, noStandardTarget: 0, notInAthena: wanted.size - new Set(source.values()).size }
for (const [id, code] of source) {
  const standard = [...(mapsTo.get(id) ?? [])].filter(target => targets.has(target))
  if (standard.length === 0) { counts.noStandardTarget++; continue }
  const ids = [...new Set([...(maps[code] ?? []), ...standard.map(Number)])].sort((a, b) => a - b)
  maps[code] = ids
  for (const target of standard) {
    const vocabulary = targets.get(target)!
    if (vocabulary !== "SNOMED") vocabularies[target] = vocabulary
  }
}
for (const ids of Object.values(maps)) counts[ids.length === 1 ? "one" : "several"]++

const output = {
  source: `OHDSI Athena, ICD10 ${version}`,
  note: "OMOP concept ids only; no SNOMED CT codes or descriptions.",
  defaultVocabulary: "SNOMED",
  maps: Object.fromEntries(Object.entries(maps).sort(([a], [b]) => a.localeCompare(b))),
  vocabularies,
}
fs.writeFileSync(path.join(process.cwd(), "src", "data", "icd10-omop.json"), `${JSON.stringify(output)}\n`)
console.log(`ICD10 ${version}:`, counts)
