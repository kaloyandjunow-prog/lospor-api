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
 *                (Core's medication list, NHIS CL009 plus BDA) -- the home
 *                medications and allergies;
 *   combinations[ATC|ingredients]  a combination product's own RxNorm Clinical
 *                Drug Form ({concept}) or, where none fits, its ingredients
 *                ({ingredients}, one drug_exposure row each).
 */

import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { CLINICAL_CATALOG, INTRAOP_DRUG_CODE_ENTRIES, PREMED_ATC_CODES } from "@lospor/core/catalog"
import { medicationRows } from "@lospor/core/vocabulary/medications"
import { normalizeAtcCode } from "../src/lib/atc"
import { combinationKey, innComponents } from "../src/lib/medication-combination"

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
const drugListCodes = new Set(medicationRows().map(drug => normalizeAtcCode(drug.atc)).filter((code): code is string => !!code))
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

// ── Combination products ─────────────────────────────────────────────────────
//
// OMOP maps a drug to its most specific standard RxNorm concept. For a
// combination that is the combination's Clinical Drug Form ("hydrochlorothiazide
// / valsartan Oral Tablet"), and where no single one fits, one row per
// ingredient. An ATC code alone cannot say which (C09DA03's "Maps to" is
// valsartan only), so the key is the ATC code with the product's ingredients.

// The list's pharmaceutical forms (EDQM standard terms) and the RxNorm dose
// forms each may be. A form not here never picks a combination concept: the
// product's ingredients are exported instead, which is never wrong.
const DOSE_FORMS: Record<string, string[]> = {
  "tablet": ["Oral Tablet"],
  "film-coated tablet": ["Oral Tablet"],
  "coated tablet": ["Oral Tablet"],
  "modified-release tablet": ["Extended Release Oral Tablet"],
  "prolonged-release tablet": ["Extended Release Oral Tablet"],
  "gastro-resistant tablet": ["Delayed Release Oral Tablet"],
  "effervescent tablet": ["Effervescent Oral Tablet"],
  "chewable tablet": ["Chewable Tablet"],
  "orodispersible tablet": ["Disintegrating Oral Tablet"],
  "capsule": ["Oral Capsule"],
  "capsule, hard": ["Oral Capsule"],
  "capsule, soft": ["Oral Capsule"],
  "modified-release capsule, hard": ["Extended Release Oral Capsule"],
  "prolonged-release capsule, hard": ["Extended Release Oral Capsule"],
  "gastro-resistant capsule, hard": ["Delayed Release Oral Capsule"],
  "gastro-resistant capsule, soft": ["Delayed Release Oral Capsule"],
  "oral solution": ["Oral Solution"],
  "oral drops, solution": ["Oral Solution"],
  "syrup": ["Oral Solution"],
  "oral suspension": ["Oral Suspension"],
  "oral suspension in sachet": ["Oral Suspension"],
  "powder for oral solution": ["Powder for Oral Solution"],
  "powder for oral suspension": ["Powder for Oral Suspension"],
  "granules for oral suspension": ["Powder for Oral Suspension"],
  "solution for injection": ["Injectable Solution", "Injection"],
  "solution for infusion": ["Injectable Solution", "Injection"],
  "concentrate for solution for infusion": ["Injectable Solution", "Injection"],
  "powder for solution for injection": ["Injectable Solution", "Injection"],
  "powder for solution for infusion": ["Injectable Solution", "Injection"],
  "powder for solution for injection/infusion": ["Injectable Solution", "Injection"],
  "powder and solvent for solution for injection": ["Injectable Solution", "Injection"],
  "suspension for injection": ["Injectable Suspension", "Injection"],
  "suspension for injection in pre-filled syringe": ["Injectable Suspension", "Injection", "Prefilled Syringe"],
  "powder and solvent for suspension for injection": ["Injectable Suspension", "Injection"],
  "eye drops, solution": ["Ophthalmic Solution"],
  "eye drops, suspension": ["Ophthalmic Suspension"],
  "eye ointment": ["Ophthalmic Ointment"],
  "ear drops, solution": ["Otic Solution"],
  "cream": ["Topical Cream"],
  "ointment": ["Topical Ointment"],
  "gel": ["Topical Gel"],
  "cutaneous solution": ["Topical Solution"],
  "cutaneous spray, solution": ["Topical Spray"],
  "cutaneous spray, suspension": ["Topical Spray"],
  "nasal spray, solution": ["Nasal Spray"],
  "nasal spray, suspension": ["Nasal Spray"],
  "lozenge": ["Lozenge"],
  "compressed lozenge": ["Lozenge"],
  "pastille": ["Lozenge"],
  "rectal solution": ["Rectal Solution"],
  "rectal cream": ["Rectal Cream"],
  "suppository": ["Rectal Suppository"],
  "vaginal tablet": ["Vaginal Tablet"],
  "inhalation powder": ["Dry Powder Inhaler", "Inhalant Powder"],
  "inhalation powder, pre-dispensed": ["Dry Powder Inhaler", "Inhalant Powder"],
  "pressurised inhalation, suspension": ["Metered Dose Inhaler"],
  "pressurised inhalation, solution": ["Metered Dose Inhaler"],
  "transdermal patch": ["Transdermal System"],
}

// INN names RxNorm spells differently (it follows USAN).
const INGREDIENT_ALIASES: Record<string, string> = {
  "paracetamol": "acetaminophen",
  "acetylsalicylic acid": "aspirin",
  "salbutamol": "albuterol",
  "glibenclamide": "glyburide",
  "noradrenaline": "norepinephrine",
  "adrenaline": "epinephrine",
  "beclometasone": "beclomethasone",
  "colecalciferol": "cholecalciferol",
  "ciclosporin": "cyclosporine",
  "clavulanic acid": "clavulanate",
  "ethinylestradiol": "ethinyl estradiol",
  "chlorphenamine": "chlorpheniramine",
  "levomenthol": "menthol",
  "simeticone": "simethicone",
  "dimeticone": "dimethicone",
  "phenoxymethylpenicillin": "penicillin v",
  "benzylpenicillin": "penicillin g",
  "flumetasone": "flumethasone",
  "hydrocortisone butyrate": "hydrocortisone",
  "neomycin sulfate": "neomycin",
  "norethisterone": "norethindrone",
  "norethisterone acetate": "norethindrone",
  "metamizole": "dipyrone",
  "metamizole sodium": "dipyrone",
  "metronidazol": "metronidazole",
  "dextromethorphane": "dextromethorphan",
  "hydricortizone": "hydrocortisone",
  "ascorbinic acid": "ascorbic acid",
  "aclidinum bromide": "aclidinium",
  "benfotiamin": "benfotiamine",
  "melitracene": "melitracen",
  "cholecaliferol": "cholecalciferol",
  "lidocaine hydrochloride monohydrate": "lidocaine",
  "calcipotriol": "calcipotriene",
  "cyanocobalamin": "vitamin b12",
  // Spellings as the register has them.
  "hydrochlorithiazide": "hydrochlorothiazide",
  "polymixin b": "polymyxin b",
  "phenilephrine": "phenylephrine",
  "cinnarizin": "cinnarizine",
  "metamizol": "dipyrone",
  "aciclovir": "acyclovir",
  "hydrocort isone": "hydrocortisone",
  "tetryzoline": "tetrahydrozoline",
  "sodium hydrogen carbonate": "sodium bicarbonate",
  "ferrous sulphate": "ferrous sulfate",
  "hydrochlorthiazide": "hydrochlorothiazide",
  "nicotinamide": "niacinamide",
}
// Salt and ester words RxNorm leaves off an ingredient name.
const SALT_WORDS = /\b(hydrochloride|dihydrochloride|hydrobromide|sodium|potassium|besilate|besylate|maleate|hydrogen maleate|fumarate|succinate|tartrate|bitartrate|mesilate|mesylate|medoxomil|cilexetil|sulfate|sulphate|phosphate|acetate|dipropionate|acetonide|propionate|pivalate|valerate|furoate|butyrate|citrate|lactate|arginine|erbumine|tert-butylamine|bromide|nitrate|benzoate|dihydrate|monohydrate|hemihydrate|trihydrate|sesquihydrate|anhydrous)\b/g
const fold = (value: string) => value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim()

type Combination = { atc: string; components: string[]; forms: Set<string>; inn: string }
const combinationProducts = new Map<string, Combination>()
for (const drug of medicationRows()) {
  const key = combinationKey(drug.atc, drug.inn)
  if (!key) continue
  const entry = combinationProducts.get(key) ?? { atc: normalizeAtcCode(drug.atc)!, components: innComponents(drug.inn), forms: new Set<string>(), inn: drug.inn }
  entry.forms.add(fold(drug.form))
  combinationProducts.set(key, entry)
}
const wantedDoseForms = new Set(Object.values(DOSE_FORMS).flat())

// Standard ingredients by name (and synonym), Clinical Drug Forms, dose forms.
const ingredientByName = new Map<string, { id: string; rxnorm: boolean }[]>()
const addIngredientName = (name: string, id: string, rxnorm: boolean) => {
  const key = fold(name)
  const list = ingredientByName.get(key) ?? []
  if (!list.some(entry => entry.id === id)) list.push({ id, rxnorm })
  ingredientByName.set(key, list)
}
const ingredientIds = new Map<string, boolean>()
const drugForms = new Map<string, boolean>()
const doseFormName = new Map<string, string>()
await each("CONCEPT.csv", c => {
  if (c[9] || !c[3].startsWith("RxNorm")) return
  if (c[4] === "Dose Form" && wantedDoseForms.has(c[1])) doseFormName.set(c[0], c[1])
  if (c[5] !== "S") return
  if (c[4] === "Ingredient") { ingredientIds.set(c[0], c[3] === "RxNorm"); addIngredientName(c[1], c[0], c[3] === "RxNorm") }
  if (c[4] === "Clinical Drug Form") drugForms.set(c[0], c[3] === "RxNorm")
})
await each("CONCEPT_SYNONYM.csv", s => {
  if (ingredientIds.has(s[0])) addIngredientName(s[1], s[0], ingredientIds.get(s[0])!)
})
const missingDoseForms = [...wantedDoseForms].filter(name => ![...doseFormName.values()].includes(name))

const formIngredients = new Map<string, Set<string>>()
const formDoseForm = new Map<string, string>()
await each("CONCEPT_RELATIONSHIP.csv", r => {
  if (r[5] || !drugForms.has(r[0])) return
  if (r[2] === "RxNorm has ing" && ingredientIds.has(r[1])) formIngredients.set(r[0], (formIngredients.get(r[0]) ?? new Set()).add(r[1]))
  if (r[2] === "RxNorm has dose form" && doseFormName.has(r[1])) formDoseForm.set(r[0], doseFormName.get(r[1])!)
})
const formsByIngredients = new Map<string, string[]>()
for (const [form, ingredients] of formIngredients) {
  const key = [...ingredients].sort().join("+")
  formsByIngredients.set(key, [...(formsByIngredients.get(key) ?? []), form])
}

function ingredientFor(component: string): string | undefined {
  const pick = (name: string) => {
    const found = ingredientByName.get(name) ?? []
    const rxnorm = found.filter(entry => entry.rxnorm)
    const chosen = rxnorm.length ? rxnorm : found
    return chosen.length === 1 ? chosen[0].id : undefined
  }
  const aliased = INGREDIENT_ALIASES[component] ?? component
  const stripped = aliased.replace(SALT_WORDS, "").replace(/\s+/g, " ").trim()
  return pick(aliased) ?? pick(stripped) ?? pick(INGREDIENT_ALIASES[stripped] ?? stripped)
}

const combinations: Record<string, { concept: number } | { ingredients: number[] } | { unmapped: true }> = {}
const unresolved: string[] = []
let precoordinated = 0
let partial = 0
for (const [key, product] of combinationProducts) {
  const resolved = product.components.map(ingredientFor)
  const ingredients = [...new Set(resolved.filter((id): id is string => !!id))].sort()
  if (resolved.some(id => !id) || ingredients.length !== product.components.length) {
    // Two ingredients found and another not: a real combination we cannot
    // name whole. Concept 0 rather than part of it -- the ATC code's single
    // "Maps to" would claim one ingredient for the lot. With one or none
    // found it is usually one substance whose name has a comma (a vaccine,
    // an extract) or "X, combinations", and the ATC code decides as before.
    if (ingredients.length >= 2) { combinations[key] = { unmapped: true }; partial++ }
    unresolved.push(`${ingredients.length >= 2 ? "0\t" : "atc\t"}${key} (${product.inn})`)
    continue
  }
  // A combination concept only when every product under the key allows it.
  const allowed = [...product.forms].map(form => new Set(DOSE_FORMS[form] ?? []))
  const candidates = (formsByIngredients.get(ingredients.join("+")) ?? [])
    .filter(form => allowed.every(names => names.has(formDoseForm.get(form) ?? "")))
  const rxnorm = candidates.filter(form => drugForms.get(form))
  const chosen = rxnorm.length ? rxnorm : candidates
  if (chosen.length === 1) {
    combinations[key] = { concept: Number(chosen[0]) }
    precoordinated++
  } else {
    combinations[key] = { ingredients: ingredients.map(Number).sort((a, b) => a - b) }
  }
}

const sorted = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
fs.writeFileSync(path.join(process.cwd(), "src", "data", "lab-drug-omop.json"), `${JSON.stringify({
  source: `OHDSI Athena, LOINC ${versionOf("LOINC")}, ATC ${versionOf("ATC")}, RxNorm ${versionOf("RxNorm")}`,
  loinc: sorted(loinc),
  atc: sorted(atc),
  combinations: sorted(combinations),
})}\n`)
console.log(`Combination products: ${combinationProducts.size} ingredient sets; ${precoordinated} to a combination concept, ${Object.keys(combinations).length - precoordinated - partial} to one row per ingredient, ${partial} partly named (concept 0), ${unresolved.length - partial} left to the ATC code.`)
if (missingDoseForms.length) console.log(`Dose forms not found in Athena: ${missingDoseForms.join(", ")}`)
// --list-unresolved prints each ingredient set not named whole, to review the aliases.
if (process.argv.includes("--list-unresolved")) console.log(unresolved.join("\n"))
const missingLoinc = [...loincCodes].filter(code => !loinc[code])
const missingAtc = [...catalogCodes].filter(code => !atc[code])
const drugList = [...drugListCodes]
const several = drugList.filter(code => (atc[code]?.length ?? 0) > 1).length
const none = drugList.filter(code => !atc[code]).length
console.log(`LOINC ${Object.keys(loinc).length}/${loincCodes.size} (missing ${missingLoinc.join(" ") || "none"}); catalogue ATC ${catalogCodes.size - missingAtc.length}/${catalogCodes.size} (no RxNorm target: ${missingAtc.join(" ") || "none"}); drug list ATC ${drugList.length - none}/${drugList.length} with a target (${several} with several, left unmapped; ${none} with none)`)
