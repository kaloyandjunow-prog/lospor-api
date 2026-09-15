import fs from "fs"
import path from "path"
import type { ProcedureSearchRow } from "@lospor/core/search"

let cache: ProcedureSearchRow[] | null = null

/**
 * The full ICD-10-PCS table with its PRCCSR groups, read once per process.
 *
 * Shared by the group search and the exact-operation list, so both answer from
 * the same rows.
 */
export function procedureRowsFromData(): ProcedureSearchRow[] {
  if (cache) return cache
  const rows = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "src", "data", "pcs.json"),
    "utf8",
  )) as ProcedureSearchRow[]
  // Bulgarian words for each group, from the national procedure names that
  // crosswalk to it, so a clinician can search in Bulgarian. Every row of a
  // group shares the one string, as the offline copy's single row does.
  const bg = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), "src", "data", "procedure-terms-bg.json"),
    "utf8",
  )) as { terms: Record<string, string> }
  cache = rows.map(row => bg.terms[row.group] ? { ...row, terms: bg.terms[row.group] } : row)
  return cache
}
