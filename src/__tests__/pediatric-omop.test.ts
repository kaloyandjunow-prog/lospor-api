import { describe, expect, it } from "vitest"
import { mapCasesToOmop } from "@/lib/omop-mapper"

type AnyCase = Parameters<typeof mapCasesToOmop>[0][number]

function pediatricCase(): AnyCase {
  return {
    id: "case-pediatric-omop",
    caseCode: "2026-P001",
    createdAt: new Date("2026-07-29T08:00:00Z"),
    status: "COMPLETE",
    clinicalMode: "PEDIATRIC",
    clinicalRulesVersion: "2026.07.29-draft.1",
    preop: {
      ageYears: 0,
      ageValue: 14,
      ageUnit: "DAYS",
      ageApproxDays: 14,
      bodySurfaceAreaM2: 0.35,
      pediatricFasting: { ruleVersion: "APAGBI-2018", compliant: true },
      sex: "FEMALE",
      povocScore: 2,
      povocRiskPercent: 30,
      coldsScore: 8,
    },
    intraop: {
      startedAt: new Date("2026-07-29T09:00:00Z"),
      endedAt: new Date("2026-07-29T10:00:00Z"),
      startTime: null,
      endTime: null,
    },
    postop: {
      pediatricPainScale: "FLACC",
      pediatricPainScore: 3,
      paedScore: 7,
      painScoreNRS: null,
    },
  } as unknown as AnyCase
}

describe("pediatric OMOP source preservation", () => {
  it("exports pediatric provenance without inventing standard concept IDs", () => {
    const bundle = mapCasesToOmop([pediatricCase()])
    const observations = new Map(
      bundle.observation.map(row => [row.observation_source_value, row]),
    )

    expect(bundle.metadata.source_version).toBe("3.6.0")
    expect(bundle.metadata.schema_version).toBe("3.5.0")
    expect(bundle.person[0].year_of_birth).toBe(2026)

    expect(observations.get("LOSPOR_CLINICAL_MODE")?.value_as_string).toBe("PEDIATRIC")
    expect(observations.get("LOSPOR_CLINICAL_RULES_VERSION")?.value_as_string)
      .toBe("2026.07.29-draft.1")
    expect(observations.get("AGE_AT_PROCEDURE_EXACT")?.value_as_string).toBe("14 DAYS")
    expect(observations.get("AGE_AT_PROCEDURE_APPROX_DAYS")?.value_as_string)
      .toBe("14")
    expect(observations.get("POVOC_SCORE")?.value_as_string).toBe("2")
    expect(observations.get("COLDS_SCORE")?.value_as_string).toBe("8")
    expect(observations.get("PEDIATRIC_PAIN_FLACC_0_10")?.value_as_string).toBe("3")
    expect(observations.get("PAED_SCORE")?.value_as_string).toBe("7")

    for (const source of [
      "LOSPOR_CLINICAL_MODE",
      "AGE_AT_PROCEDURE_EXACT",
      "POVOC_SCORE",
      "COLDS_SCORE",
      "PEDIATRIC_PAIN_FLACC_0_10",
      "PAED_SCORE",
    ]) {
      expect(observations.get(source)?.observation_concept_id).toBe(0)
    }
  })
})
