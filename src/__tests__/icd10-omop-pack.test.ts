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

describe("the bundled laboratory and drug research numbers", () => {
  const labDrug = JSON.parse(fs.readFileSync("src/data/lab-drug-omop.json", "utf8")) as {
    source: string
    loinc: Record<string, number>
    atc: Record<string, number[]>
  }

  it("give every LOINC code LOSPOR records its OMOP concept", () => {
    expect(labDrug.source).toMatch(/^OHDSI Athena, LOINC /)
    // Haemoglobin, and the vital signs the exporter writes.
    expect(labDrug.loinc["718-7"]).toBe(3000963)
    expect(labDrug.loinc["8480-6"]).toBe(3004249)
    expect(Object.keys(labDrug.loinc).length).toBeGreaterThan(85)
  })

  it("give catalogue drugs the standard RxNorm concepts their ATC code maps to", () => {
    // Diazepam.
    expect(labDrug.atc["N05BA01"]?.length).toBe(1)
    expect(Object.keys(labDrug.atc).length).toBeGreaterThan(190)
    expect(Object.values(labDrug.atc).every(ids => ids.every(id => Number.isSafeInteger(id) && id > 0))).toBe(true)
  })

  it("give the drug list a clinician picks home medications from its research numbers too", () => {
    // Metformin and bisoprolol, as the Bulgarian drug list codes them.
    expect(labDrug.atc["A10BA02"]).toEqual([1503297])
    expect(labDrug.atc["C07AB07"]?.length).toBe(1)
    const drugs = JSON.parse(fs.readFileSync("src/data/drugs.json", "utf8")) as { atc: string }[]
    const coded = drugs.filter(drug => drug.atc)
    const mapped = coded.filter(drug => labDrug.atc[drug.atc]?.length === 1)
    // 2,938 of 3,525 in the 2026-09-13 Athena bundle; the rest are allergen
    // extracts, local "00" codes, retired codes and combinations.
    expect(mapped.length / coded.length).toBeGreaterThan(0.8)
  })
})
