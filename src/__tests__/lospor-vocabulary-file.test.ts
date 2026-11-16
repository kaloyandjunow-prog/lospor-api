import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { losporVocabularyConceptRows } from "@/lib/omop-mapper/lospor-vocabulary"

/** OMOP CONCEPT columns, in the order the CDM vocabulary files use (tab-separated, as Athena ships them). */
const COLUMNS = ["concept_id", "concept_name", "domain_id", "vocabulary_id", "concept_class_id", "standard_concept", "concept_code", "valid_start_date", "valid_end_date", "invalid_reason"] as const

export function losporConceptFile(): string {
  const rows = losporVocabularyConceptRows().map(row => COLUMNS.map(column => {
    const value = row[column]
    return value == null ? "" : String(value).replace(/-/g, column.startsWith("valid_") ? "" : "-")
  }).join("\t"))
  return [COLUMNS.join("\t"), ...rows].join("\n") + "\n"
}

describe("data/omop/LOSPOR_CONCEPT.csv", () => {
  it("is the vocabulary the mapper uses, row for row (regenerate it from losporVocabularyConceptRows)", () => {
    const file = readFileSync(join(process.cwd(), "data", "omop", "LOSPOR_CONCEPT.csv"), "utf8").replace(/\r\n/g, "\n")
    expect(file).toBe(losporConceptFile())
  })
})
