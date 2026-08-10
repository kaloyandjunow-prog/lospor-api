import { describe, expect, it } from "vitest"
import { DATA_DICTIONARY, DICTIONARY_VERSION, type DictionaryEntry } from "@/lib/data-dictionary"
import { mapCasesToOmop } from "@/lib/omop-mapper"
import { completeCaseFixture } from "./fixtures/complete-case"

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
  const concept = /\(([A-Z]+:[A-Za-z0-9_-]+)\)/.exec(entry.exportName)?.[1] ?? null
  return { table: table ?? "", column: column ?? "", concept }
}

const bundle = mapCasesToOmop([completeCaseFixture() as never], {
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

/**
 * A concept-by-concept comparison is deliberately NOT asserted here.
 *
 * Writing it surfaced three disagreements between the dictionary and the
 * export that are real and none of them mine to resolve silently:
 *
 *  - height (LOINC:8302-2) and weight (LOINC:29463-7) are documented as
 *    measurements, and a case carrying both produces no measurement row for
 *    either;
 *  - several variables are documented under a LOINC or LOSPOR code and emitted
 *    under a different string — ASA, RCRI, Apfel, STOP-BANG, Mallampati,
 *    carrier gas, FiO2, pain score;
 *  - PACU vitals are emitted with a POSTOP_ prefix where the dictionary marks
 *    the same concept with a [PACU] suffix.
 *
 * Any of those could be fixed in the dictionary or in the mapper, and the
 * choice changes a published contract that datasets have already been
 * generated against. Asserting either side would freeze a decision nobody has
 * made. The structural checks above hold regardless of how it is settled.
 */
