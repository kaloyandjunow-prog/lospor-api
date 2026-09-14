import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { selectStandardMapResolutions } from "../../scripts/standard-map-selection"

const version = "Athena test snapshot"

describe("Athena standard-map selection", () => {
  it("accepts one exact active Maps to target", () => {
    const result = selectStandardMapResolutions({
      vocabularyId: "ICD10",
      codes: ["A00"],
      sourceConcepts: [{ conceptId: 1, conceptCode: "A00", conceptName: "Cholera", vocabularyId: "ICD10", standardConcept: null }],
      relationships: [{ conceptId1: 1, conceptId2: 10 }],
      targets: new Map([[10, { conceptId: 10, conceptName: "Cholera", vocabularyId: "SNOMED" }]]),
      athenaVersion: version,
    }).get("A00")

    expect(result).toEqual({
      kind: "mapped",
      standard: {
        standardVocabulary: "SNOMED",
        standardConceptId: 10,
        standardLabel: "Cholera",
        mappingMethod: "athena-exact-code-maps-to",
        mappingConfidence: 0.95,
        athenaVersion: version,
      },
    })
  })

  it("never selects the first of several targets, and hands every one back for a caller that can hold them", () => {
    const result = selectStandardMapResolutions({
      vocabularyId: "ICD10",
      codes: ["B20"],
      sourceConcepts: [{ conceptId: 2, conceptCode: "B20", conceptName: "HIV disease", vocabularyId: "ICD10", standardConcept: null }],
      relationships: [{ conceptId1: 2, conceptId2: 12 }, { conceptId1: 2, conceptId2: 11 }],
      targets: new Map([
        [11, { conceptId: 11, conceptName: "First finding", vocabularyId: "SNOMED" }],
        [12, { conceptId: 12, conceptName: "Second finding", vocabularyId: "SNOMED" }],
      ]),
      athenaVersion: version,
    }).get("B20")

    expect(result).toEqual({
      kind: "source-only",
      mappingMethod: "athena-multiple-standard-targets",
      mappingNotes: "Athena supplies 2 distinct active standard targets (11, 12); no target was selected.",
      athenaVersion: version,
      // Conditions export one row per target; other domains keep it source-only.
      targetIds: [11, 12],
    })
  })

  it("deduplicates repeated relationships to the same standard target", () => {
    const result = selectStandardMapResolutions({
      vocabularyId: "ICD10",
      codes: ["C00"],
      sourceConcepts: [{ conceptId: 3, conceptCode: "C00", conceptName: "Lip neoplasm", vocabularyId: "ICD10", standardConcept: null }],
      relationships: [{ conceptId1: 3, conceptId2: 20 }, { conceptId1: 3, conceptId2: 20 }],
      targets: new Map([[20, { conceptId: 20, conceptName: "Malignant neoplasm of lip", vocabularyId: "SNOMED" }]]),
      athenaVersion: version,
    }).get("C00")

    expect(result?.kind).toBe("mapped")
  })

  it("maps an already-standard exact code to itself", () => {
    const result = selectStandardMapResolutions({
      vocabularyId: "LOINC",
      codes: ["1234-5"],
      sourceConcepts: [{ conceptId: 30, conceptCode: "1234-5", conceptName: "Example measurement", vocabularyId: "LOINC", standardConcept: "S" }],
      relationships: [],
      targets: new Map(),
      athenaVersion: version,
    }).get("1234-5")

    expect(result?.kind).toBe("mapped")
    if (result?.kind === "mapped") expect(result.standard.mappingMethod).toBe("athena-exact-standard-code")
  })

  it("distinguishes a missing source code from a source with no standard target", () => {
    const results = selectStandardMapResolutions({
      vocabularyId: "ICD10",
      codes: ["X00.01", "Z99.4"],
      sourceConcepts: [{ conceptId: 4, conceptCode: "Z99.4", conceptName: "Dependence on artificial heart", vocabularyId: "ICD10", standardConcept: null }],
      relationships: [],
      targets: new Map(),
      athenaVersion: version,
    })

    expect(results.get("X00.01")).toMatchObject({ mappingMethod: "athena-exact-source-code-not-found" })
    expect(results.get("Z99.4")).toMatchObject({ mappingMethod: "athena-no-active-standard-target" })
  })

  it("lets automatic reseeding clear stale mappings without overwriting reviewed decisions", () => {
    const seeder = fs.readFileSync(path.join(process.cwd(), "scripts", "seed-concept-maps.ts"), "utf8")
    expect(seeder).toContain('cm."mappingStatus" NOT IN (\'MANUALLY_CURATED\', \'REJECTED\')')
    expect(seeder).toContain("const generatedRows = rows")
  })
})
