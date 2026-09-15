/**
 * Build the bundled laboratory and drug research numbers from an Athena download.
 *
 *   npx tsx scripts/generate-lab-drug-omop.mts --athena <unzipped Athena folder>
 *
 * A LOINC code is itself a standard OMOP concept, and a catalogue drug's ATC
 * code maps to a standard RxNorm ingredient, but in both cases the export needs
 * OMOP's number for it. Those numbers came only from a site's terminology
 * import, so on an appliance without one every lab and drug exported concept 0.
 * LOINC (free, with its notice) and RxNorm (US NLM, public) carry no licence
 * decision, so the numbers ship with the release.
 *
 * Written to src/data/lab-drug-omop.json:
 *   loinc[code]  the concept id of every LOINC code LOSPOR records;
 *   atc[code]    the standard RxNorm/RxNorm Extension ids an ATC code maps to,
 *                ascending (the concept map applies only a single one), for
 *                every catalogue drug and every drug in the Bulgarian drug list
 *                (src/data/drugs.json) -- the home medications and allergies.
 */

import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { CLINICAL_CATALOG, INTRAOP_DRUG_CODE_ENTRIES, PREMED_ATC_CODES } from "@lospor/core/catalog"
import { normalizeAtcCode } from "../src/lib/atc"

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const athena = argument("--athena")
if (!athena) throw new Error("Usage: generate-lab-drug-omop.mts --athena <unzipped Athena folder>")

// Every LOINC code the register can record: the lab library's seed, the
// reviewed NHIS CL024 targets, and the vital signs and other LOINC columns the
// exporter writes.
const LOINC_SOURCES = [
  "scripts/seed-lab-loinc.ts",
  "scripts/nhis-cl024-lab-mappings.ts",
  "scripts/seed-concept-maps.ts",
  "src/lib/omop-mapper/concepts.ts",
]
const loincCodes = new Set(LOINC_SOURCES.flatMap(file =>
  fs.readFileSync(path.join(process.cwd(), file), "utf8").match(/"(\d{1,6}-\d)"/g)?.map(match => match.slice(1, -1)) ?? []))

// Every ATC code a catalogue carries: intraoperative drugs, infusions, fluids,
// agents, and any option (such as premedication) that names one.
const catalogAtc = JSON.stringify(CLINICAL_CATALOG).match(/"atcCode":"([A-Z][0-9]{2}[A-Z]{2}[0-9]{2})"/g)
  ?.map(match => match.slice(11, -1)) ?? []
const catalogCodes = new Set([
  ...INTRAOP_DRUG_CODE_ENTRIES.map(entry => entry.atcCode).filter((code): code is string => !!code),
  ...Object.values(PREMED_ATC_CODES),
  ...catalogAtc,
])
// The drug list a clinician picks home medications and allergies from.
const drugListCodes = new Set((JSON.parse(fs.readFileSync(path.join(process.cwd(), "src", "data", "drugs.json"), "utf8")) as { atc: string }[])
  .map(drug => normalizeAtcCode(drug.atc)).filter((code): code is string => !!code))
const atcCodes = new Set([...catalogCodes, ...drugListCodes])

async function each(file: string, fn: (columns: string[]) => void) {
  const lines = readline.createInterface({ input: fs.createReadStream(path.join(athena!, file)), crlfDelay: Infinity })
  let header = true
  for await (const line of lines) {
    if (header) { header = false; continue }
    fn(line.split("\t"))
  }
}

const versionOf = (vocabulary: string) => fs.readFileSync(path.join(athena, "VOCABULARY.csv"), "utf8")
  .split(/\r?\n/).find(line => line.startsWith(`${vocabulary}\t`))?.split("\t")[3] ?? "unknown"

// CONCEPT.csv: concept_id, name, domain, vocabulary, class, standard, code, start, end, invalid
const loinc: Record<string, number> = {}
const atcSource = new Map<string, string>()
await each("CONCEPT.csv", c => {
  if (c[9]) return
  if (c[3] === "LOINC" && c[5] === "S" && loincCodes.has(c[6])) loinc[c[6]] = Number(c[0])
  if (c[3] === "ATC" && atcCodes.has(c[6])) atcSource.set(c[0], c[6])
})

const mapsTo = new Map<string, Set<string>>()
await each("CONCEPT_RELATIONSHIP.csv", r => {
  if (r[2] !== "Maps to" || r[5] || !atcSource.has(r[0]) || r[0] === r[1]) return
  mapsTo.set(r[0], (mapsTo.get(r[0]) ?? new Set()).add(r[1]))
})
const targetIds = new Set([...mapsTo.values()].flatMap(targets => [...targets]))
const standardDrug = new Set<string>()
await each("CONCEPT.csv", c => {
  if (targetIds.has(c[0]) && c[5] === "S" && !c[9] && c[3].startsWith("RxNorm")) standardDrug.add(c[0])
})

const atc: Record<string, number[]> = {}
for (const [id, code] of atcSource) {
  const ids = [...(mapsTo.get(id) ?? [])].filter(target => standardDrug.has(target)).map(Number).sort((a, b) => a - b)
  if (ids.length) atc[code] = ids
}

const sorted = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
fs.writeFileSync(path.join(process.cwd(), "src", "data", "lab-drug-omop.json"), `${JSON.stringify({
  source: `OHDSI Athena, LOINC ${versionOf("LOINC")}, ATC ${versionOf("ATC")}, RxNorm ${versionOf("RxNorm")}`,
  loinc: sorted(loinc),
  atc: sorted(atc),
})}\n`)
const missingLoinc = [...loincCodes].filter(code => !loinc[code])
const missingAtc = [...catalogCodes].filter(code => !atc[code])
const drugList = [...drugListCodes]
const several = drugList.filter(code => (atc[code]?.length ?? 0) > 1).length
const none = drugList.filter(code => !atc[code]).length
console.log(`LOINC ${Object.keys(loinc).length}/${loincCodes.size} (missing ${missingLoinc.join(" ") || "none"}); catalogue ATC ${catalogCodes.size - missingAtc.length}/${catalogCodes.size} (no RxNorm target: ${missingAtc.join(" ") || "none"}); drug list ATC ${drugList.length - none}/${drugList.length} with a target (${several} with several, left unmapped; ${none} with none)`)
