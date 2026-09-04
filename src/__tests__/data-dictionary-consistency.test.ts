import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { CLINICAL_NUMBER_RULES } from "@lospor/core/clinical-validation"
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

/**
 * The two columns an OMOP observation or measurement can carry a value in.
 * Which of the two a variable lands in is not cosmetic: a score written as
 * text cannot be averaged, thresholded or plotted without being cast back,
 * and a researcher who reads "value_as_number" in the dictionary and finds
 * NULL in the column concludes the value was never recorded.
 */
const VALUE_COLUMNS = new Set(["value_as_number", "value_as_string"])
const NUMERIC_TYPES = new Set(["integer", "float"])

/** Which set of validation rules an entry's source table is governed by. */
const SECTION_BY_SOURCE_TABLE: Record<string, "preop" | "intraop" | "postop"> = {
  PreoperativeRecord: "preop",
  IntraoperativeRecord: "intraop",
  PostoperativeRecord: "postop",
}

/** Every column an export row can name its variable in. */
const SOURCE_VALUE_COLUMNS = [
  "observation_source_value",
  "measurement_source_value",
  "procedure_source_value",
]

function tableRows(table: string): Array<Record<string, unknown>> {
  const rows = (bundle as unknown as Record<string, unknown>)[table]
  return Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []
}

function rowsForConcept(table: string, concept: string): Array<Record<string, unknown>> {
  return tableRows(table).filter(row =>
    SOURCE_VALUE_COLUMNS.some(key => row[key] === concept))
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
  "ANAESTHESIA_TECHNIQUE:", "VASCULAR_ACCESS:", "LOSPOR_COMPLICATION:",
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

/**
 * The checks above compare table names and concept codes. Everything between
 * them — which column the value lands in, and whether it lands there as a
 * number or as text — was parsed out of the export name and then thrown away,
 * and that is exactly where the dictionary was wrong: twenty-six entries
 * declared observation.value_as_number against an OBSERVATION row that had no
 * such column, so every score in the export was documented as a number and
 * shipped as a string in a column that did not exist.
 *
 * These assert the full tuple the dictionary promises: table, column, the
 * source value the row is found under, and the type of the value in it.
 */
describe("the dictionary names the column the value is actually written to", () => {
  it("names a column the emitted rows actually have", () => {
    const wrong: string[] = []
    for (const entry of DATA_DICTIONARY) {
      const { table, column } = parseExportName(entry)
      if (!table || !column) continue
      const rows = tableRows(table)
      if (rows.length === 0) {
        // Not a documentation fault, but it means this entry is unchecked, so
        // it is reported rather than quietly skipped.
        wrong.push(`${entry.name}: ${table} is empty in the fixtures, so ${column} is unverifiable`)
        continue
      }
      if (!(column in rows[0])) wrong.push(`${entry.name} → ${table}.${column}`)
    }

    expect(wrong.sort(), "documented under a column the emitted row does not have").toEqual([])
  })

  it("writes the value into the documented column, in the documented form", () => {
    // Only concepts the fixtures actually produce can be checked here. The
    // reverse direction — every documented concept appearing in an export — is
    // a question about fixture coverage rather than about the contract, and a
    // fixture gap would surface here as a documentation fault it is not.
    const emitted = new Set([...emittedVariables()].map(([code]) => code))
    const wrong: string[] = []

    for (const entry of DATA_DICTIONARY) {
      const { table, column, concept } = parseExportName(entry)
      if (!concept || !VALUE_COLUMNS.has(column)) continue
      if (!emitted.has(concept)) continue

      const rows = rowsForConcept(table, concept)
      if (rows.length === 0) {
        wrong.push(`${entry.name}: ${concept} is emitted, but not into ${table}`)
        continue
      }
      const expectedType = column === "value_as_number" ? "number" : "string"
      if (!rows.some(row => typeof row[column] === expectedType)) {
        const got = rows.map(row => row[column] === null ? "null" : typeof row[column]).join(", ")
        wrong.push(`${entry.name}: ${table}.${column} holds ${got}, not ${expectedType}`)
      }
    }

    expect(wrong.sort(), "documented column is empty or holds the wrong form").toEqual([])
  })

  it("states the range the app actually enforces", () => {
    // allowedValues is what a researcher screens on: a value outside it reads
    // as corrupt data. Written by hand it drifts towards what feels plausible
    // rather than what the app accepts, and the two versions of the height
    // range disagreed by exactly the population paediatric mode exists for —
    // the dictionary said 50-250 cm while the validator has always taken
    // 20-280, so every neonate on file sat outside its own documented range.
    // The rules in @lospor/core are the ones enforced at entry, so they are
    // the answer rather than a second opinion.
    const disagreeing: string[] = []
    for (const entry of DATA_DICTIONARY) {
      const section = SECTION_BY_SOURCE_TABLE[entry.sourceTable]
      if (!section || !NUMERIC_TYPES.has(entry.type)) continue
      const rule = CLINICAL_NUMBER_RULES[section][entry.sourceColumn]
      if (!rule) continue
      const enforced = `${rule.min}–${rule.max}`
      if (entry.allowedValues !== enforced) {
        disagreeing.push(`${entry.name}: documents ${entry.allowedValues ?? "no range"}, enforces ${enforced}`)
      }
    }

    expect(disagreeing.sort(), "documented range is not the validated one").toEqual([])
  })

  it("declares a value type that agrees with the column it names", () => {
    // A variable documented as an integer or a float has to be in
    // value_as_number, and one documented as a string, enum, boolean or JSON
    // blob has to be in value_as_string. The two statements are the same fact
    // written twice, and when they disagree one of them is wrong.
    const contradictory = DATA_DICTIONARY
      .filter(entry => VALUE_COLUMNS.has(parseExportName(entry).column))
      .filter(entry => {
        const numericColumn = parseExportName(entry).column === "value_as_number"
        return numericColumn !== NUMERIC_TYPES.has(entry.type)
      })
      .map(entry => `${entry.name}: ${entry.type} in ${parseExportName(entry).column}`)

    expect(contradictory.sort(), "declared type and declared column disagree").toEqual([])
  })
})

/**
 * The dictionary's *source* side, which nothing checked until now.
 *
 * Every assertion above is about the export: which OMOP table a variable lands
 * in, which column, in what form. None of them looks at where the value came
 * from, so `sourceTable` and `sourceColumn` were free text that drifted
 * unchallenged — 27 entries named "PreoperativeRecord", a model that has never
 * existed, and two named "Complication" instead of "CaseComplication".
 *
 * That is not only a documentation fault. SECTION_BY_SOURCE_TABLE is keyed on
 * these names, so the 24 entries that spelled the preoperative table correctly
 * were skipped by the range check above — the check that exists because the
 * documented height range once excluded every neonate on file.
 */
describe("the dictionary names a real place for every value to come from", () => {
  const schema = readFileSync(
    join(process.cwd(), "prisma", "schema.prisma"),
    "utf8",
  )

  /** Model name to the set of columns it declares. */
  const modelColumns = new Map<string, Set<string>>()
  {
    let current: string | null = null
    for (const raw of schema.split(/\r?\n/)) {
      const line = raw.trim()
      const opened = line.match(/^model\s+(\w+)\s*\{/)
      if (opened) { current = opened[1]; modelColumns.set(current, new Set()); continue }
      if (line === "}") { current = null; continue }
      if (!current || !line || line.startsWith("//") || line.startsWith("@@")) continue
      const field = line.split(/\s+/)[0]
      if (/^[a-z][A-Za-z0-9]*$/.test(field)) modelColumns.get(current)!.add(field)
    }
  }

  it("reads the schema at all", () => {
    // Guards the two assertions below: a parse that found nothing would let
    // them pass while checking nothing, which is the failure mode of every
    // test that reads its own source of truth.
    expect(modelColumns.size).toBeGreaterThan(20)
    expect(modelColumns.get("PreoperativeAssessment")?.size ?? 0).toBeGreaterThan(50)
  })

  it("names a table the schema declares", () => {
    const unknown = DATA_DICTIONARY
      .filter(entry => !modelColumns.has(entry.sourceTable))
      .map(entry => `${entry.name} → ${entry.sourceTable}`)

    expect([...new Set(unknown)].sort(), "sourceTable is not a model in schema.prisma").toEqual([])
  })

  it("names a column that table actually has", () => {
    const unknown: string[] = []
    for (const entry of DATA_DICTIONARY) {
      const columns = modelColumns.get(entry.sourceTable)
      // A bad table is already reported above; reporting it twice buries the
      // column faults underneath it.
      if (!columns) continue
      // A variable derived from more than one column names them "a / b" --
      // an age from its value and unit, a visit boundary from the real instant
      // and the legacy wall clock. Each part has to exist; the joined string
      // never will.
      for (const column of entry.sourceColumn.split("/").map(part => part.trim())) {
        if (!columns.has(column)) {
          unknown.push(`${entry.name} → ${entry.sourceTable}.${column}`)
        }
      }
    }

    expect(unknown.sort(), "sourceColumn is not a field on that model").toEqual([])
  })
})

/**
 * The dictionary must not tell a researcher to discard a real distinction.
 *
 * A reading that was attempted and could not be obtained carries 618772 on the
 * measurement row; one nobody recorded carries nothing. Six preoperative
 * entries used to say "NULL = not recorded or marked unobtainable", which is
 * the opposite of what the export does, and four recovery entries said only
 * "NULL = not measured".
 *
 * That reads as an instruction to exclude every blank as missing data — and
 * unobtainable readings cluster in shocked, arrhythmic and peripherally
 * shut-down patients, so following it drops the sickest cases and leaves a
 * cohort that looks healthier than it was. Nothing about the resulting analysis
 * would look wrong.
 */
describe("a measurement that could not be obtained is documented as such", () => {
  /**
   * Table and column, not column alone.
   *
   * The intraoperative timetable also has heartRate and spO2, on CaseEvent, and
   * those carry no unobtainable flag -- a vital charted during a case is either
   * recorded at that minute or not. Matching on the column name alone pulled
   * them in and demanded an explanation that would have been untrue.
   */
  const FLAGGED = [
    ["PreoperativeAssessment", "bpSystolic"],
    ["PreoperativeAssessment", "bpDiastolic"],
    ["PreoperativeAssessment", "heartRate"],
    ["PreoperativeAssessment", "spO2"],
    ["PreoperativeAssessment", "temperature"],
    ["PreoperativeAssessment", "respiratoryRate"],
    ["PostoperativeRecord", "recoveryBpSystolic"],
    ["PostoperativeRecord", "recoveryBpDiastolic"],
    ["PostoperativeRecord", "recoveryHeartRate"],
    ["PostoperativeRecord", "recoverySpO2"],
    ["PostoperativeRecord", "temperatureCelsius"],
  ] as const
  const isFlagged = (entry: DictionaryEntry) =>
    FLAGGED.some(([table, column]) => entry.sourceTable === table && entry.sourceColumn === column)

  it("names the qualifier on every measurement that can carry it", () => {
    const silent = DATA_DICTIONARY
      .filter(isFlagged)
      .filter(entry => !entry.missingnessRule?.includes("618772"))
      .map(entry => entry.name)

    expect(silent.sort(), "blank could mean unobtainable, and the rule does not say so").toEqual([])
  })

  it("covers every flagged measurement, so the list above cannot rot", () => {
    // If a column is renamed or a new flagged vital is added, this fails rather
    // than the check above quietly testing nothing.
    const missing = FLAGGED
      .filter(([table, column]) => !DATA_DICTIONARY.some(
        entry => entry.sourceTable === table && entry.sourceColumn === column))
      .map(([table, column]) => `${table}.${column}`)
    expect(missing).toEqual([])
  })

  it("never says the two are indistinguishable", () => {
    const conflating = DATA_DICTIONARY
      .filter(entry => /not recorded or marked unobtainable/i.test(entry.missingnessRule ?? ""))
      .map(entry => entry.name)

    expect(conflating, "the export separates these; the dictionary must not pool them").toEqual([])
  })
})
