/**
 * Build the bundled English diagnosis synonyms from an Athena download.
 *
 *   npx tsx scripts/generate-icd10-synonyms.mts --athena <unzipped Athena folder>
 *
 * Diagnosis search matches a typed word against the ICD-10 label and against
 * Icd10Synonym. That table was filled only by a site's terminology import
 * (seed-vocabularies.ts), so without one "heart attack" or "gallstones" found
 * nothing. The words come from ICD-10-CM, which the US National Center for
 * Health Statistics publishes into the public domain, so they ship with the
 * release and seed-icd10-from-bundle.ts loads them.
 *
 * Same rule as the terminology import: an ICD-10-CM code belongs to the longest
 * WHO ICD-10 code it starts with (J18.90 -> J18.9, A00.01 -> A00.0), and both
 * its name and its English synonyms become synonyms of that code. A word that
 * only repeats the code's own English label is left out.
 *
 * Written to src/data/icd10-synonyms.json:
 *   synonyms[code]  the distinct words for one ICD-10 code, sorted.
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
if (!athena) throw new Error("Usage: generate-icd10-synonyms.mts --athena <unzipped Athena folder>")

const ENGLISH = "4180186"

async function each(file: string, fn: (columns: string[]) => void) {
  const lines = readline.createInterface({ input: fs.createReadStream(path.join(athena!, file)), crlfDelay: Infinity })
  let header = true
  for await (const line of lines) {
    if (header) { header = false; continue }
    fn(line.split("\t"))
  }
}

const labels = new Map(icd10Rows().map(row => [row.code, row.labelEn.trim().toLowerCase()]))
const icdCodeOf = (cmCode: string) => {
  for (let length = cmCode.length; length >= 3; length--) {
    const prefix = cmCode.slice(0, length)
    if (labels.has(prefix)) return prefix
  }
  return undefined
}

const words = new Map<string, Set<string>>()
const add = (code: string, word: string) => {
  const text = word.trim().replace(/\s+/g, " ")
  if (!text || text.toLowerCase() === labels.get(code)) return
  words.set(code, (words.get(code) ?? new Set()).add(text))
}

// CONCEPT.csv: concept_id, name, domain, vocabulary, class, standard, code, start, end, invalid
const cmConcepts = new Map<string, string>()
await each("CONCEPT.csv", c => {
  if (c[3] !== "ICD10CM" || c[9]) return
  const code = icdCodeOf(c[6])
  if (!code) return
  cmConcepts.set(c[0], code)
  add(code, c[1])
})
// CONCEPT_SYNONYM.csv: concept_id, synonym, language
await each("CONCEPT_SYNONYM.csv", s => {
  const code = cmConcepts.get(s[0])
  if (code && s[2] === ENGLISH) add(code, s[1])
})

const version = fs.readFileSync(path.join(athena, "VOCABULARY.csv"), "utf8")
  .split(/\r?\n/).find(line => line.startsWith("ICD10CM\t"))?.split("\t")[3] ?? "unknown"
const synonyms = Object.fromEntries([...words]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([code, set]) => [code, [...set].sort((a, b) => a.localeCompare(b))]))
fs.writeFileSync(path.join(process.cwd(), "src", "data", "icd10-synonyms.json"), `${JSON.stringify({
  source: `OHDSI Athena, ${version}`,
  note: "ICD-10-CM code descriptions (US NCHS, public domain), grouped under the WHO ICD-10 code each extends.",
  synonyms,
})}\n`)
const total = Object.values(synonyms).reduce((sum, list) => sum + list.length, 0)
console.log(`${total} synonyms for ${Object.keys(synonyms).length} of ${labels.size} ICD-10 codes, from ${cmConcepts.size} ICD-10-CM concepts.`)
