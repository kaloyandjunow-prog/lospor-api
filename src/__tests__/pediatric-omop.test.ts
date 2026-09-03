import { describe, expect, it } from "vitest"
import { mapCasesToOmop } from "@/lib/omop-mapper"

import { pediatricCaseFixture as pediatricCase } from "./fixtures/pediatric-case"

describe("pediatric OMOP source preservation", () => {
  it("exports pediatric provenance without inventing standard concept IDs", () => {
    const bundle = mapCasesToOmop([pediatricCase()])
    const observations = new Map(
      bundle.observation.map(row => [row.observation_source_value, row]),
    )

    expect(bundle.metadata.source_version).toBe("3.8.0")
    expect(bundle.metadata.schema_version).toBe("3.6.0")
    expect(bundle.person[0].year_of_birth).toBe(2026)

    expect(observations.get("LOSPOR:CLINICAL_RULES_VERSION")?.value_as_string)
      .toBe("2026.08.04-release.1")
    expect(observations.get("LOSPOR:AGE_AT_PROCEDURE_EXACT")?.value_as_string).toBe("14 DAYS")
    expect(observations.get("LOSPOR:AGE_AT_PROCEDURE_APPROX_DAYS")?.value_as_string)
      .toBe("14")
    expect(observations.get("LOSPOR:POVOC_SCORE")?.value_as_string).toBe("2")
    expect(observations.get("LOSPOR:COLDS_SCORE")?.value_as_string).toBe("8")
    expect(observations.get("LOSPOR:PEDIATRIC_PAIN_FLACC_0_10")?.value_as_string).toBe("3")
    expect(observations.get("LOSPOR:PAED_SCORE")?.value_as_string).toBe("7")

    // The paediatric scores are the ones most likely to be analysed as numbers
    // — banded by age, compared across a cohort — and they were text only.
    expect(observations.get("LOSPOR:POVOC_SCORE")?.value_as_number).toBe(2)
    expect(observations.get("LOSPOR:POVOC_RISK_PERCENT")?.value_as_number).toBe(30)
    expect(observations.get("LOSPOR:COLDS_SCORE")?.value_as_number).toBe(8)
    expect(observations.get("LOSPOR:PEDIATRIC_PAIN_FLACC_0_10")?.value_as_number).toBe(3)
    expect(observations.get("LOSPOR:PAED_SCORE")?.value_as_number).toBe(7)
    expect(observations.get("LOSPOR:AGE_AT_PROCEDURE_APPROX_DAYS")?.value_as_number).toBe(14)
    expect(observations.get("LOSPOR:BODY_SURFACE_AREA_M2")?.value_as_number).toBe(0.35)
    // "14 DAYS" is a rendering, not a quantity: 14 alone would be meaningless
    // without its unit, and the normalised age above is the numeric form.
    expect(observations.get("LOSPOR:AGE_AT_PROCEDURE_EXACT")?.value_as_number).toBeNull()
    // A fasting assessment is a JSON blob; there is no number to lift out.
    expect(observations.get("LOSPOR:PEDIATRIC_FASTING_ASSESSMENT")?.value_as_number).toBeNull()

    for (const source of [
      "LOSPOR:AGE_AT_PROCEDURE_EXACT",
      "LOSPOR:POVOC_SCORE",
      "LOSPOR:COLDS_SCORE",
      "LOSPOR:PEDIATRIC_PAIN_FLACC_0_10",
      "LOSPOR:PAED_SCORE",
    ]) {
      expect(observations.get(source)?.observation_concept_id).toBe(0)
    }
  })
})
