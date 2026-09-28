/**
 * Build Core's medication list: lospor-core/src/vocabulary/medications.ts.
 *
 *   npx tsx scripts/generate-medication-catalog.mts --athena <unzipped Athena folder>
 *
 * The list a clinician picks home medications and allergies from, used by the
 * API's search, the Drug table seed, the concept-map seed, the bundled OMOP
 * numbers, Status's medication mapping and the phone's offline search -- one
 * list, so none of them can disagree.
 *
 * Sources, both in data/:
 *  - nhis/CL009.json: the national register of medicinal products (NHIS
 *    nomenclature CL009), downloaded from the NHIS API with a public C001
 *    request. Its codes are the ones a hospital system sends for a home
 *    medication. Every row is kept: CL009 lists each pack size under its own
 *    code, and an import must be able to resolve every one of them.
 *  - bda/drugs.json: LOSPOR's earlier list, scraped from the BDA register
 *    (scripts/scrape-bda.mjs). Only the products CL009 lacks are kept, and only
 *    those the scrape read correctly.
 *
 * ATC codes are checked against WHO ATC in Athena: one that is not a WHO code
 * is dropped (the product stays, uncoded), never guessed at.
 */
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { createHash } from "node:crypto"
import { normalizeAtcCode } from "../src/lib/atc"

const argument = (name: string) => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const athena = argument("--athena")
if (!athena) throw new Error("Usage: generate-medication-catalog.mts --athena <unzipped Athena folder>")

type Row = [id: string, name: string, inn: string, atc: string, form: string, strength: string, nhisCode: string | null]

const clean = (value: unknown) => String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim()
const fold = (value: string) => value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

// WHO ATC codes Athena holds as valid.
const validAtc = new Set<string>()
let atcVersion = ""
for await (const line of readline.createInterface({ input: fs.createReadStream(path.join(athena, "CONCEPT.csv"), "utf8"), crlfDelay: Infinity })) {
  const c = line.split("\t")
  if (c[3] === "ATC" && !c[9]) validAtc.add(c[6])
}
for (const line of fs.readFileSync(path.join(athena, "VOCABULARY.csv"), "utf8").split(/\r?\n/)) {
  const c = line.split("\t")
  if (c[0] === "ATC") atcVersion = c[3]
}
let droppedAtc = 0
const atcOf = (value: unknown) => {
  const code = normalizeAtcCode(value)
  if (!code) return ""
  if (!validAtc.has(code)) { droppedAtc++; return "" }
  return code
}

type Bda = { name: string; inn: string; form: string; strength: string; atc: string }
const bda = JSON.parse(fs.readFileSync(path.join("data", "bda", "drugs.json"), "utf8")) as Bda[]

// The BDA list's code for a product, when it gives one valid WHO code for that
// name. Used only where CL009 gives the product no ATC at all (Hexoral Spray,
// Arilin tablets): a CL009 code, when there is one, always stands.
const bdaAtcByName = new Map<string, Set<string>>()
for (const drug of bda) {
  const code = normalizeAtcCode(drug.atc)
  if (!code || !validAtc.has(code)) continue
  const key = fold(clean(drug.name))
  bdaAtcByName.set(key, (bdaAtcByName.get(key) ?? new Set()).add(code))
}
let filledFromBda = 0

// ── CL009 ─────────────────────────────────────────────────────────────────────
type Cl009 = { retrievedAt: string; responseSha256: string; environment: string; entries: { key: string; description: string; meta?: Record<string, string> }[] }
const cl009 = JSON.parse(fs.readFileSync(path.join("data", "nhis", "CL009.json"), "utf8")) as Cl009
const national: Row[] = cl009.entries
  .filter(entry => entry.meta?.["inn code"])
  .map(entry => {
    const meta = entry.meta!
    const name = clean(entry.description.split(",")[0])
    const strength = [clean(meta.quantity), clean(meta.units)].filter(Boolean).join(" ")
    let atc = atcOf(meta.atc)
    if (!atc) {
      const fromBda = bdaAtcByName.get(fold(name))
      if (fromBda?.size === 1) { atc = [...fromBda][0]; filledFromBda++ }
    }
    return [`cl009:${entry.key}`, name, clean(meta["inn code"]), atc, clean(meta.form), strength, entry.key] as Row
  })
  .sort((a, b) => a[1].localeCompare(b[1]) || a[6]!.localeCompare(b[6]!, undefined, { numeric: true }))
const nationalNames = new Set(national.map(row => fold(row[1])))

// ── BDA products CL009 lacks ──────────────────────────────────────────────────
let misread = 0
const extraIds = new Set<string>()
const extras: Row[] = []
for (const drug of bda) {
  const name = clean(drug.name)
  const inn = clean(drug.inn)
  if (!name || nationalNames.has(fold(name))) continue
  // The scrape read some register pages wrongly: the manufacturer heading
  // landed in the INN, or no substance at all. Those products are not kept.
  if (!inn || /производител|manufacturer/i.test(inn) || inn.endsWith(":")) { misread++; continue }
  const row: Row = ["", name, inn, atcOf(drug.atc), clean(drug.form), clean(drug.strength), null]
  const id = `bda:${createHash("sha256").update(row.slice(1, 6).join("|")).digest("hex").slice(0, 12)}`
  if (extraIds.has(id)) continue
  extraIds.add(id)
  row[0] = id
  extras.push(row)
}
extras.sort((a, b) => a[1].localeCompare(b[1]))

const rows = [...national, ...extras]
const version = cl009.retrievedAt.slice(0, 10)
const source = `NHIS CL009 (${cl009.environment}, retrieved ${cl009.retrievedAt}, sha256 ${cl009.responseSha256}), `
  + `${national.length} rows (${filledFromBda} given the BDA code where CL009 has no ATC); plus ${extras.length} BDA products CL009 lacks; ATC checked against ${atcVersion}`

const file = `// GENERATED by lospor-api/scripts/generate-medication-catalog.mts — do not edit.
// ${rows.length} medications: ${national.length} from NHIS CL009, ${extras.length} from LOSPOR's earlier BDA list.
// Medication list version: ${version}

import type { MedicationRow } from "../medications"

const ROWS: [string, string, string, string, string, string, string | null][] = [
${rows.map(row => `  ${JSON.stringify(row)},`).join("\n")}
]

let expanded: MedicationRow[] | null = null

export function medicationRows(): MedicationRow[] {
  if (!expanded) {
    expanded = ROWS.map(([id, name, inn, atc, form, strength, nhisCode]) => ({
      id, name, inn, atc, form, strength, nhisCode,
    }))
  }
  return expanded
}

export const MEDICATION_ROW_COUNT = ${rows.length}

/** Stamped on a medication chosen from the offline copy, as the other vocabularies are. */
export const MEDICATION_LIST_VERSION = ${JSON.stringify(version)}

export const MEDICATION_LIST_SOURCE = ${JSON.stringify(source)}
`
const out = path.join("..", "lospor-core", "src", "vocabulary", "medications.ts")
fs.writeFileSync(out, file)
console.log(`Wrote ${out}: ${rows.length} rows (${national.length} CL009, ${extras.length} BDA extras; ${misread} misread BDA rows left out; ${droppedAtc} non-WHO ATC codes dropped; ${filledFromBda} CL009 rows without ATC given the BDA code).`)
