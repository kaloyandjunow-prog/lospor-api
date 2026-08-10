import { describe, expect, it } from "vitest"
import { mapCasesToOmop } from "@/lib/omop-mapper"

import { pediatricCaseFixture as pediatricCase } from "./fixtures/pediatric-case"

describe("pediatric OMOP source preservation", () => {
  it("exports pediatric provenance without inventing standard concept IDs", () => {
    const bundle = mapCasesToOmop([pediatricCase()])
    const observations = new Map(
      bundle.observation.map(row => [row.observation_source_value, row]),
    )

    expect(bundle.metadata.source_version).toBe("3.6.0")
    expect(bundle.metadata.schema_version).toBe("3.5.0")
    expect(bundle.person[0].year_of_birth).toBe(2026)

    expect(observations.get("LOSPOR:CLINICAL_MODE")?.value_as_string).toBe("PEDIATRIC")
    expect(observations.get("LOSPOR:CLINICAL_RULES_VERSION")?.value_as_string)
      .toBe("2026.08.04-release.1")
    expect(observations.get("LOSPOR:AGE_AT_PROCEDURE_EXACT")?.value_as_string).toBe("14 DAYS")
    expect(observations.get("LOSPOR:AGE_AT_PROCEDURE_APPROX_DAYS")?.value_as_string)
      .toBe("14")
    expect(observations.get("LOSPOR:POVOC_SCORE")?.value_as_string).toBe("2")
    expect(observations.get("LOSPOR:COLDS_SCORE")?.value_as_string).toBe("8")
    expect(observations.get("LOSPOR:PEDIATRIC_PAIN_FLACC_0_10")?.value_as_string).toBe("3")
    expect(observations.get("LOSPOR:PAED_SCORE")?.value_as_string).toBe("7")

    for (const source of [
      "LOSPOR:CLINICAL_MODE",
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
