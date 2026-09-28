/**
 * A combination product's key into the bundled combination mappings (9.13.3).
 *
 * OMOP maps a medication to its most specific standard RxNorm concept. For a
 * combination product that is the combination's own concept (valsartan with
 * hydrochlorothiazide oral tablet), and where none fits, one row per
 * ingredient. The ATC code alone cannot say which: C09DA03 is valsartan with
 * any diuretic, and Athena's "Maps to" for it names valsartan only. The key is
 * therefore the ATC code together with the product's ingredients, which a
 * saved home medication carries as its INN ("Valsartan, Hydrochlorothiazide").
 *
 * The generator (scripts/generate-lab-drug-omop.mts) and the save path
 * (relational-sync) both build keys here, so they cannot disagree.
 */

export const COMBINATION_SOURCE_VOCABULARY = "LOSPOR_DRUG_COMBINATION"

const fold = (value: string) => value
  .normalize("NFKD")
  .replace(/[̀-ͯ]/g, "")
  .toLowerCase()
  .replace(/\s+/g, " ")
  .trim()

/** The ingredients an INN names, folded; one entry for a single substance. */
export function innComponents(inn: string | null | undefined): string[] {
  return [...new Set((inn ?? "").split(/\s*[,/+]\s*/).map(fold).filter(Boolean))].sort()
}

/** The key for a product of this ATC code and INN, or null if it is not a combination. */
export function combinationKey(atcCode: string | null | undefined, inn: string | null | undefined): string | null {
  const atc = (atcCode ?? "").trim().toUpperCase().replace(/\s+/g, "")
  const components = innComponents(inn)
  return atc && components.length > 1 ? `${atc}|${components.join("+")}` : null
}
