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
 *   vocabularies   the vocabulary of any target that is not SNOMED;
 *   deprecated     the codes mapped through a concept WHO has since retired;
 *   viaParent      code -> the parent code it was mapped through.
 *
 * A code Athena does not have maps through its nearest parent that it does
 * (2026-11-15, replacing the decision of 2026-09-14 that left them at 0). NHIS
 * uses WHO's optional subdivisions -- the place and activity of an external
 * cause (W37.48: place 4, activity 8), the site of a musculoskeletal disorder
 * (M15.81: shoulder) -- and OMOP's ICD10 stops one level short of them. The
 * full code stays in condition_source_value, so the subdivision is not lost; the
 * concept says what the vocabulary can, the parent's diagnosis. A code Athena
 * holds but does not map (C77, a block range) is not lifted to a parent.
 *
 * A retired code still counts (2026-11-15). NHIS keeps codes from older WHO
 * revisions -- K35.0, appendicitis with generalised peritonitis, was replaced in
 * 2010 -- and Athena keeps them too, deprecated, with their "Maps to" still
 * valid. Only an active concept used to count, so 64 such codes went out as
 * concept 0 with a perfectly good SNOMED target sitting in the vocabulary. An
 * active concept for the same code still wins over a retired one.
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
const active = new Map<string, string>()
const retired = new Map<string, string>()
await each("CONCEPT.csv", c => {
  if (c[3] === "ICD10" && wanted.has(c[6])) (c[9] ? retired : active).set(c[0], c[6])
})
const activeCodes = new Set(active.values())
const source = new Map([...active, ...[...retired].filter(([, code]) => !activeCodes.has(code))])
const retiredIds = new Set([...retired.keys()].filter(id => source.has(id)))

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
const deprecated = new Set<string>()
const viaParent: Record<string, string> = {}
const counts = { one: 0, several: 0, noStandardTarget: 0, notInAthena: wanted.size - new Set(source.values()).size, retired: 0 }
for (const [id, code] of source) {
  const standard = [...(mapsTo.get(id) ?? [])].filter(target => targets.has(target))
  if (standard.length === 0) { counts.noStandardTarget++; continue }
  const ids = [...new Set([...(maps[code] ?? []), ...standard.map(Number)])].sort((a, b) => a - b)
  maps[code] = ids
  if (retiredIds.has(id)) deprecated.add(code)
  for (const target of standard) {
    const vocabulary = targets.get(target)!
    if (vocabulary !== "SNOMED") vocabularies[target] = vocabulary
  }
}
// The nearest parent Athena maps, for a code Athena does not hold at all:
// W37.48 -> W37.4 -> W37, M15.81 -> M15.8.
const inAthena = new Set(source.values())
const parentsOf = (code: string) => [
  ...(/^[A-Z]\d{2}\.\d{2,}$/.test(code) ? [code.slice(0, 5)] : []),
  ...(/^[A-Z]\d{2}\.\d+$/.test(code) ? [code.slice(0, 3)] : []),
]
let lifted = 0
for (const code of wanted) {
  if (inAthena.has(code) || maps[code]) continue
  // Only a parent the vocabulary itself holds: the note names the code the
  // concept really came from (W37, not the equally absent W37.4).
  const parent = parentsOf(code).find(candidate => inAthena.has(candidate) && maps[candidate])
  if (!parent) continue
  maps[code] = maps[parent]
  viaParent[code] = parent
  lifted++
}
for (const ids of Object.values(maps)) counts[ids.length === 1 ? "one" : "several"]++
counts.retired = deprecated.size
;(counts as Record<string, number>).viaParent = lifted

const output = {
  source: `OHDSI Athena, ICD10 ${version}`,
  note: "OMOP concept ids only; no SNOMED CT codes or descriptions.",
  defaultVocabulary: "SNOMED",
  maps: Object.fromEntries(Object.entries(maps).sort(([a], [b]) => a.localeCompare(b))),
  vocabularies,
  deprecated: [...deprecated].sort((a, b) => a.localeCompare(b)),
  viaParent: Object.fromEntries(Object.entries(viaParent).sort(([a], [b]) => a.localeCompare(b))),
}
fs.writeFileSync(path.join(process.cwd(), "src", "data", "icd10-omop.json"), `${JSON.stringify(output)}\n`)
console.log(`ICD10 ${version}:`, counts)
