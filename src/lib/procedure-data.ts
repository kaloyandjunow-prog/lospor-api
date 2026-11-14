import fs from "fs"
import path from "path"
import type { ProcedureSearchRow } from "@lospor/core/search"

let cache: ProcedureSearchRow[] | null = null

type BulgarianProcedureNames = {
  groups: Record<string, string>
  domains: Record<string, string>
  /** Lower-case clinical words per group, in both languages (search only). */
  groupTerms: Record<string, string>
  /** Every ICD-10-PCS code's Bulgarian name. */
  labels: Record<string, string>
  /** Lower-case search words beyond the label (clinical names, abbreviations). */
  synonyms: Record<string, string>
}

const readJson = <T>(file: string): T =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), "src", "data", file), "utf8")) as T

/**
 * The full ICD-10-PCS table with its PRCCSR groups, read once per process.
 *
 * Shared by the group search and the exact-operation list, so both answer from
 * the same rows. Every row also carries its Bulgarian names (hisbg-nomenclatures,
 * 2026-11-14): the group, the section, the operation, and the words a Bulgarian
 * query is matched against. The English fields are unchanged, so a client that
 * ignores the Bulgarian ones sees exactly what it always did.
 */
export function procedureRowsFromData(): ProcedureSearchRow[] {
  if (cache) return cache
  const rows = readJson<ProcedureSearchRow[]>("pcs.json")
  // Bulgarian words for each group, from the national procedure names that
  // crosswalk to it, so a clinician can search in Bulgarian. Every row of a
  // group shares the one string, as the offline copy's single row does.
  const crosswalk = readJson<{ terms: Record<string, string> }>("procedure-terms-bg.json")
  const bg = readJson<BulgarianProcedureNames>("procedure-labels-bg.json")
  cache = rows.map(row => {
    const descriptionBg = bg.labels[row.code]
    const searchBg = [bg.groups[row.group], bg.domains[row.domain], descriptionBg, bg.synonyms[row.code], crosswalk.terms[row.group]]
      .filter(Boolean).join(" ").toLowerCase()
    return {
      ...row,
      ...(crosswalk.terms[row.group] ? { terms: crosswalk.terms[row.group] } : {}),
      ...(bg.groups[row.group] ? { groupBg: bg.groups[row.group] } : {}),
      ...(bg.domains[row.domain] ? { domainBg: bg.domains[row.domain] } : {}),
      ...(descriptionBg ? { descriptionBg } : {}),
      ...(searchBg ? { searchBg } : {}),
      ...(bg.groupTerms[row.group] ? { groupTerms: bg.groupTerms[row.group] } : {}),
    }
  })
  return cache
}
