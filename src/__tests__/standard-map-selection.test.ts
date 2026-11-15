import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { selectStandardMapResolutions } from "../../scripts/standard-map-selection"

const version = "Athena test snapshot"

describe("Athena standard-map selection", () => {
  it("maps a code the vocabulary lacks through its nearest parent, and says so", () => {
    const result = selectStandardMapResolutions({
      vocabularyId: "ICD10",
      codes: ["M15.81"],
      sourceConcepts: [{ conceptId: 8, conceptCode: "M15.8", conceptName: "Other polyarthrosis", vocabularyId: "ICD10", standardConcept: null }],
      relationships: [{ conceptId1: 8, conceptId2: 75897 }],
      targets: new Map([[75897, { conceptId: 75897, conceptName: "Polyarthropathy", vocabularyId: "SNOMED" }]]),
      athenaVersion: version,
    }).get("M15.81")
    expect(result).toMatchObject({ kind: "mapped", standard: {
      standardConceptId: 75897, mappingMethod: "athena-parent-code-maps-to", mappingConfidence: 0.8,
      mappingNotes: "Mapped through parent M15.8; the subdivision is kept in the source value only.",
    } })
  })

  it("does not lift a code the vocabulary holds but does not map", () => {
    const result = selectStandardMapResolutions({
      vocabularyId: "ICD10",
      codes: ["C79.5"],
      sourceConcepts: [
        { conceptId: 9, conceptCode: "C79.5", conceptName: "Secondary of bone", vocabularyId: "ICD10", standardConcept: null },
        { conceptId: 10, conceptCode: "C79", conceptName: "Secondary of other sites", vocabularyId: "ICD10", standardConcept: null },
      ],
      relationships: [{ conceptId1: 10, conceptId2: 100 }],
      targets: new Map([[100, { conceptId: 100, conceptName: "Secondary", vocabularyId: "SNOMED" }]]),
      athenaVersion: version,
    }).get("C79.5")
    expect(result).toMatchObject({ kind: "source-only", mappingMethod: "athena-no-active-standard-target" })
  })

  // NHIS keeps codes WHO retired (K35.0 was replaced in 2010); Athena keeps them
  // deprecated with a valid "Maps to" (2026-11-15).
  it("maps a retired code through its retired concept, and names the method", () => {
    const result = selectStandardMapResolutions({
      vocabularyId: "ICD10",
      codes: ["K35.0"],
      sourceConcepts: [{ conceptId: 5, conceptCode: "K35.0", conceptName: "Acute appendicitis with generalized peritonitis", vocabularyId: "ICD10", standardConcept: null, invalidReason: "D" }],
      relationships: [{ conceptId1: 5, conceptId2: 196149 }],
      targets: new Map([[196149, { conceptId: 196149, conceptName: "Acute appendicitis with generalized peritonitis", vocabularyId: "SNOMED" }]]),
      athenaVersion: version,
    }).get("K35.0")
    expect(result).toMatchObject({ kind: "mapped", standard: { standardConceptId: 196149, mappingMethod: "athena-deprecated-code-maps-to", mappingConfidence: 0.9 } })
  })

  it("prefers an active concept over a retired one for the same code", () => {
    const result = selectStandardMapResolutions({
      vocabularyId: "ICD10",
      codes: ["X01"],
      sourceConcepts: [
        { conceptId: 6, conceptCode: "X01", conceptName: "old meaning", vocabularyId: "ICD10", standardConcept: null, invalidReason: "U" },
        { conceptId: 7, conceptCode: "X01", conceptName: "current meaning", vocabularyId: "ICD10", standardConcept: null },
      ],
      relationships: [{ conceptId1: 6, conceptId2: 60 }, { conceptId1: 7, conceptId2: 70 }],
      targets: new Map([
        [60, { conceptId: 60, conceptName: "Old", vocabularyId: "SNOMED" }],
        [70, { conceptId: 70, conceptName: "Current", vocabularyId: "SNOMED" }],
      ]),
      athenaVersion: version,
    }).get("X01")
    expect(result).toMatchObject({ kind: "mapped", standard: { standardConceptId: 70, mappingMethod: "athena-exact-code-maps-to" } })
  })

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
