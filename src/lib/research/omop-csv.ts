import { OMOP_COLUMNS, type OmopTableName } from "@/lib/omop-columns"
import { csvCell } from "@/lib/csv-cell"

/**
 * CSV serialization for the OMOP tables in a research export.
 *
 * Split out of exports.ts, which otherwise mixes three lifetimes in one file:
 * the request-side export record CRUD, the background worker that claims and
 * writes an export, and this -- pure text emission with no database, no
 * streams and no lease. It is what a researcher actually downloads, and it is
 * the piece with a regression test pointed straight at it.
 */

export type { OmopTableName }

/**
 * Every table the mapper emits, in the order a loader wants them (the dimension first, then the person and their
 * visits). It used to be a hand-kept list of eight: care_site, device_exposure (the airway devices and blood units) and
 * death were produced by the mapper and quietly left out of every research export. A table is now added here in the
 * same change that adds it to OMOP_COLUMNS, and a test holds the two together.
 */
export const OMOP_TABLES: OmopTableName[] = [
  "care_site",
  "person",
  "observation_period",
  "visit_occurrence",
  "condition_occurrence",
  "drug_exposure",
  "measurement",
  "procedure_occurrence",
  "device_exposure",
  "observation",
  "death",
]

/**
 * The header line and the value lines are produced from one list, so a header
 * can never describe a column the rows do not carry, or omit one they do.
 * Exported for the regression test, which asserts against the text a researcher
 * actually downloads rather than against the declaration above.
 */
export function omopCsvHeaderLine(table: OmopTableName): string {
  return `${OMOP_COLUMNS[table].join(",")}\n`
}

export function omopCsvValueLine(
  table: OmopTableName,
  row: Record<string, unknown>,
): string {
  return `${OMOP_COLUMNS[table].map(column => csvCell(row[column])).join(",")}\n`
}

/** The declared column set, for tests that hold it against the mapper output. */
export function omopCsvColumns(table: OmopTableName): readonly string[] {
  return OMOP_COLUMNS[table]
}
