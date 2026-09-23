import { describe, expect, it } from "vitest"
import { mapCasesToOmop } from "@/lib/omop-mapper"
import { completeCaseFixture } from "./fixtures/complete-case"

describe("relational preoperative OMOP answers", () => {
  it("exports coded yes/no answers, skips NOT_ASKED, and maps A2 with a LOSPOR key", () => {
    const source = completeCaseFixture() as any
    source.preop.assessmentAnswers = [
      {
        state: "YES",
        optionKey: null,
        valueText: null,
        valueNumber: null,
        profileVersion: 1,
        source: "clinician",
        provenance: { source: "clinician" },
        question: { stableKey: "A2_REDUCED_EXERCISE_TOLERANCE", omopSourceCode: "LOSPOR:PREOP_A2_REDUCED_EXERCISE_TOLERANCE", omopConceptId: null },
      },
      {
        state: "NOT_ASKED",
        optionKey: null,
        valueText: null,
        valueNumber: null,
        profileVersion: 1,
        source: "schema",
        provenance: null,
        question: { stableKey: "A3_UNINTENTIONAL_WEIGHT_LOSS", omopSourceCode: null, omopConceptId: null },
      },
    ]
    const bundle = mapCasesToOmop([source as never])
    expect(bundle.observation).toContainEqual(expect.objectContaining({
      observation_source_value: "LOSPOR:PREOP_A2_REDUCED_EXERCISE_TOLERANCE",
      value_as_concept_id: 4188539,
    }))
    expect(bundle.observation).not.toContainEqual(expect.objectContaining({
      observation_source_value: "LOSPOR:PREOP_A3_UNINTENTIONAL_WEIGHT_LOSS",
    }))
  })

  it("exports positive A3 as condition occurrence and avoids duplicate linked diagnosis export", () => {
    const source = completeCaseFixture() as any
    source.preop.assessmentAnswers = [{
      state: "YES",
      optionKey: null,
      valueText: null,
      valueNumber: null,
      profileVersion: 1,
      source: "clinician",
      provenance: {},
      question: { stableKey: "A3_UNINTENTIONAL_WEIGHT_LOSS", omopSourceCode: null, omopConceptId: null },
    }]
    const result = mapCasesToOmop([source as never])
    expect(result.condition_occurrence).toContainEqual(expect.objectContaining({
      condition_concept_id: 40491502,
      condition_source_value: "LOSPOR:PREOP_A3_UNINTENTIONAL_WEIGHT_LOSS",
    }))

    source.preop.assessmentAnswers[0].provenance = { linkedDiagnosisId: "dx-1" }
    const linked = mapCasesToOmop([source as never])
    expect(linked.condition_occurrence).not.toContainEqual(expect.objectContaining({
      condition_concept_id: 40491502,
    }))
  })
})
