import { losporConceptId } from "@/lib/omop-mapper/lospor-vocabulary"
import { describe, expect, it } from "vitest"
import { mapCasesToOmop } from "@/lib/omop-mapper"

import { pediatricCaseFixture as pediatricCase } from "./fixtures/pediatric-case"

describe("pediatric OMOP source preservation", () => {
  it("exports pediatric provenance without inventing standard concept IDs", () => {
    const bundle = mapCasesToOmop([pediatricCase()])
    const observations = new Map(
      bundle.observation.map(row => [row.observation_source_value, row]),
    )
    const measurements = new Map(
      bundle.measurement.map(row => [row.measurement_source_value, row]),
    )

    expect(bundle.metadata.source_version).toBe("3.9.0")
    expect(bundle.metadata.schema_version).toBe("3.6.0")
    expect(bundle.person[0].year_of_birth).toBe(2026)

    // 2.9.0: the rules version is software provenance and no longer a patient row.
    expect(observations.has("LOSPOR:CLINICAL_RULES_VERSION")).toBe(false)
    expect(observations.get("LOSPOR:AGE_AT_PROCEDURE_EXACT")?.value_as_string).toBe("14 DAYS")
    expect(observations.get("LOSPOR:AGE_AT_PROCEDURE_APPROX_DAYS")?.value_as_string)
      .toBe("14")
    expect(observations.get("LOSPOR:POVOC_SCORE")?.value_as_string).toBe("2")
    expect(observations.get("LOSPOR:COLDS_SCORE")?.value_as_string).toBe("8")
    expect(observations.get("LOSPOR:PAED_SCORE")?.value_as_string).toBe("7")

    // The paediatric scores are the ones most likely to be analysed as numbers
    // — banded by age, compared across a cohort — and they were text only.
    expect(observations.get("LOSPOR:POVOC_SCORE")?.value_as_number).toBe(2)
    expect(observations.get("LOSPOR:POVOC_RISK_PERCENT")?.value_as_number).toBe(30)
    expect(observations.get("LOSPOR:COLDS_SCORE")?.value_as_number).toBe(8)
    // FLACC moved to measurement.value_as_number (3036118, the LOINC FLACC total; the panel 3037051 until 10.0.0
    // concept), the same way RCRI, STOP-BANG and the Aldrete total did — it is
    // no longer a LOSPOR-only observation at concept 0.
    expect(measurements.get("LOSPOR:PEDIATRIC_PAIN_FLACC_0_10")?.value_as_number).toBe(3)
    expect(measurements.get("LOSPOR:PEDIATRIC_PAIN_FLACC_0_10")?.measurement_concept_id).toBe(3036118)
    expect(observations.get("LOSPOR:PAED_SCORE")?.value_as_number).toBe(7)
    // Steward (10.0.0) has no concept of its own, and is not filed under the
    // Aldrete/PAR one: four numeric observations, under LOSPOR's own concepts (2.9.0).
    for (const [code, value] of [["TOTAL", 5], ["CONSCIOUSNESS", 2], ["AIRWAY", 1], ["MOVEMENT", 2]] as const) {
      expect(observations.get(`LOSPOR:STEWARD_${code}`)).toMatchObject({ observation_concept_id: losporConceptId(`LOSPOR:STEWARD_${code}`), value_as_number: value })
    }
    expect(measurements.has("LOSPOR:STEWARD_TOTAL")).toBe(false)
    expect(observations.get("LOSPOR:AGE_AT_PROCEDURE_APPROX_DAYS")?.value_as_number).toBe(14)
    // Moved to measurement with concept 3005424, whose domain is Measurement.
    expect(measurements.get("LOSPOR:BODY_SURFACE_AREA_M2")).toMatchObject({
      measurement_concept_id: 3005424, value_as_number: 0.35,
    })
    // 2.9.0: the age as charted is Age (3022304) with its unit, so 14 means 14 days.
    expect(observations.get("LOSPOR:AGE_AT_PROCEDURE_EXACT")).toMatchObject({ observation_concept_id: 3022304, value_as_number: 14, unit_concept_id: 8512 })
    // A nil-by-mouth assignment is a number of hours before surgery.
    expect(observations.get("LOSPOR:PEDIATRIC_NPO_CLEAR_FLUIDS_HOURS")?.value_as_number).toBe(1)

    // No standard concept invented: these carry LOSPOR's own (2.9.0).
    for (const source of [
      "LOSPOR:POVOC_SCORE",
      "LOSPOR:COLDS_SCORE",
      "LOSPOR:PAED_SCORE",
    ]) {
      expect(observations.get(source)?.observation_concept_id).toBe(losporConceptId(source))
      expect(observations.get(source)?.observation_concept_id).toBeGreaterThanOrEqual(2_000_000_000)
    }
  })
})
