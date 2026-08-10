import { describe, expect, it } from "vitest"
import { DATA_DICTIONARY, DICTIONARY_VERSION, type DictionaryEntry } from "@/lib/data-dictionary"
import { mapCasesToOmop } from "@/lib/omop-mapper"
import { completeCaseFixture } from "./fixtures/complete-case"
import { pediatricCaseFixture } from "./fixtures/pediatric-case"

/**
 * The data dictionary is the published definition of a research export: what
 * each column means, its unit, its allowed values, and what a missing value
 * means. Researchers read it to interpret a dataset they have downloaded.
 *
 * Nothing checked it against the export it describes. The dictionary is a
 * hand-maintained list and the mapper is code, so the two drift apart silently:
 * a column gets renamed or a concept retired, the dictionary keeps the old
 * entry, and someone analyses a variable under the wrong definition. That
 * failure is invisible at the point it happens and surfaces, if ever, in
 * somebody's results.
 *
 * These tests compare the two directly. They are deliberately about the
 * *shape* of the contract — table names, concept codes, versions — rather than
 * about any one column, so adding a column to the export does not break them
 * unless it was added without being documented.
 */

/** "observation.value_as_number (LOINC:8302-2)" → table, column, concept. */
function parseExportName(entry: DictionaryEntry): {
  table: string
  column: string
  concept: string | null
} {
  const [, table, column] = /^([a-z_]+)\.([a-zA-Z_]+)/.exec(entry.exportName) ?? []
  // The namespace may itself contain an underscore, as POSTOP_LOINC does.
  const concept = /\(([A-Z_]+:[A-Za-z0-9_-]+)\)/.exec(entry.exportName)?.[1] ?? null
  return { table: table ?? "", column: column ?? "", concept }
}

// Both fixtures, because an adult case emits none of the paediatric scores:
// a check run against one alone would pass while every POVOC, COLDS, PAED and
// pain-scale variable went undocumented. A fixture gap and a documentation gap
// are indistinguishable from inside the test, so the fixture has to be as wide
// as the export.
const bundle = mapCasesToOmop([completeCaseFixture() as never, pediatricCaseFixture() as never], {
  exportId: "export-dictionary-check",
  userId: "user-1",
  userRole: "RESEARCHER",
  statusFilter: ["COMPLETE"],
  excludedCaseCount: 0,
  gitCommit: "test",
  forcedOverride: false,
})

describe("the dictionary describes the export it ships with", () => {
  it("documents something at all", () => {
    expect(DATA_DICTIONARY.length).toBeGreaterThan(50)
  })

  it("stamps its own version into every export", () => {
    // A dataset whose dictionary version is unknown cannot be interpreted
    // later, once the dictionary has moved on.
    expect(bundle.metadata.data_dictionary_version).toBe(DICTIONARY_VERSION)
  })

  it("names only tables the export actually contains", () => {
    const tables = new Set(Object.keys(bundle).filter(key => key !== "metadata"))
    const unknown = DATA_DICTIONARY
      .map(entry => ({ entry, parsed: parseExportName(entry) }))
      .filter(({ parsed }) => parsed.table && !tables.has(parsed.table))
      .map(({ entry, parsed }) => `${entry.name} → ${parsed.table}`)

    expect(unknown, "documented under a table the export does not produce").toEqual([])
  })

  it("gives every entry a parseable export name", () => {
    const unparseable = DATA_DICTIONARY
      .filter(entry => !parseExportName(entry).table)
      .map(entry => entry.name)

    expect(unparseable, "exportName must read as table.column").toEqual([])
  })

  it("gives every entry a meaning and a missingness rule", () => {
    // Missingness is the one a researcher gets wrong most easily: whether a
    // blank means "not measured", "measured as zero", or "not applicable".
    const incomplete = DATA_DICTIONARY
      .filter(entry => !entry.meaning?.trim() || !entry.missingnessRule?.trim())
      .map(entry => entry.name)

    expect(incomplete).toEqual([])
  })

  it("names each variable once", () => {
    // Uniqueness is on the dictionary's own key, not on the export name: one
    // LOINC concept legitimately appears more than once, because a systolic
    // pressure recorded before surgery and one recorded during it are the same
    // measurement in different contexts.
    const seen = new Map<string, number>()
    for (const entry of DATA_DICTIONARY) {
      seen.set(entry.name, (seen.get(entry.name) ?? 0) + 1)
    }
    const duplicated = [...seen].filter(([, count]) => count > 1).map(([name]) => name)

    expect(duplicated, "two entries under one name disagree by definition").toEqual([])
  })

  it("declares a version no later than the dictionary's own", () => {
    const ahead = DATA_DICTIONARY
      .filter(entry => entry.versionIntroduced > DICTIONARY_VERSION)
      .map(entry => `${entry.name} (${entry.versionIntroduced})`)

    expect(ahead, "introduced in a version that does not exist yet").toEqual([])
  })
})

/** Analytes the fixture happens to result; open-ended in real data. */
const LAB_ANALYTE_CODES = new Set(["LOINC:2345-7", "LOINC:718-7"])

const VALUE_NAMESPACES = [
  "ATC:", "ICD10:", "LAB:", "LOSPOR_PROCEDURE:",
  "ANAESTHESIA_TECHNIQUE:", "VASCULAR_ACCESS:",
]

function emittedVariables(): Map<string, string> {
  const found = new Map<string, string>()
  for (const [table, rows] of Object.entries(bundle)) {
    if (!Array.isArray(rows)) continue
    for (const row of rows as Array<Record<string, unknown>>) {
      for (const key of ["observation_source_value", "measurement_source_value"]) {
        const value = row[key]
        if (typeof value !== "string") continue
        if (VALUE_NAMESPACES.some(ns => value.startsWith(ns))) continue
        // Which lab analytes appear depends on what was ordered, so a LOINC
        // code carried by a lab row is a value rather than a documented
        // column -- the dictionary covers them with one generic lab entry.
        // The LOINC codes that ARE columns (vitals, FiO2, pain score) are
        // documented individually and still checked below.
        if (LAB_ANALYTE_CODES.has(value)) continue
        found.set(value, table)
      }
    }
  }
  return found
}

describe("every variable the export emits is documented", () => {
  /**
   * This is the assertion the whole file exists for: a variable appearing in
   * an export with no dictionary entry is a column a researcher cannot
   * interpret, and one appearing under a different name than the dictionary
   * gives is worse — they filter for it, get nothing, and read that as "not
   * recorded" rather than "named differently".
   *
   * Both were true of this export until 4.0.0. Holding it now costs nothing;
   * the alternative is noticing in someone's results.
   */
  it("names every emitted variable, under the name the export uses", () => {
    const documented = new Set(
      DATA_DICTIONARY.map(entry => parseExportName(entry).concept).filter(Boolean),
    )
    const undocumented = [...emittedVariables()]
      .filter(([code]) => !documented.has(code))
      .map(([code, table]) => `${table}: ${code}`)

    expect(undocumented.sort(), "emitted with no dictionary entry").toEqual([])
  })
})
