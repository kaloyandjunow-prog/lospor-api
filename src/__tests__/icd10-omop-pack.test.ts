import fs from "node:fs"
import { describe, expect, it } from "vitest"
import { icd10Rows } from "@lospor/core/vocabulary"

type Pack = {
  source: string
  note: string
  defaultVocabulary: string
  maps: Record<string, number[]>
  vocabularies: Record<string, string>
}

const pack = JSON.parse(fs.readFileSync("src/data/icd10-omop.json", "utf8")) as Pack

describe("the bundled ICD-10 research numbers", () => {
  it("map LOSPOR's codes to OMOP concept ids, several where Athena decomposes a code", () => {
    expect(pack.source).toMatch(/^OHDSI Athena, ICD10 /)
    expect(pack.maps["K80.0"]).toEqual([194991])
    expect(pack.maps["E11.2"]).toEqual([201826, 443731])
    const codes = new Set(icd10Rows().map(row => row.code))
    expect(Object.keys(pack.maps).every(code => codes.has(code))).toBe(true)
    expect(Object.keys(pack.maps).length).toBeGreaterThan(15_000)
  })

  it("carry numbers only, never SNOMED CT codes or descriptions", () => {
    for (const ids of Object.values(pack.maps)) {
      expect(ids.every(id => Number.isSafeInteger(id) && id > 0)).toBe(true)
    }
    expect(Object.values(pack.vocabularies).every(vocabulary => vocabulary !== "SNOMED")).toBe(true)
    // The only words in the file are its own field names and provenance.
    const words = new Set(JSON.stringify(pack).match(/[A-Za-z]{4,}/g))
    const allowed = new Set([
      "Athena", "Extension", "ICD10", "OHDSI", "OMOP", "Release", "SNOMED", "codes", "concept",
      "defaultVocabulary", "descriptions", "maps", "note", "only", "source", "vocabularies",
    ])
    expect([...words].filter(word => !allowed.has(word))).toEqual([])
  })
})
