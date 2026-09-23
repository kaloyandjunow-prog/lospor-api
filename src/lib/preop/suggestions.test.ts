import { describe, expect, it } from "vitest"
import { buildPreopSuggestionCandidates } from "./suggestions"

describe("preoperative suggestion rules", () => {
  it("only suggests from current coded evidence", () => {
    const result = buildPreopSuggestionCandidates({
      clinicalMode: "ADULT",
      diagnoses: [{ id: "dx-1", label: "Unintentional weight loss", code: "R63.4", sourceCode: "R63.4" }],
      comorbidities: [],
      medications: [],
      labs: [],
    })
    expect(result).toContainEqual(expect.objectContaining({
      stableKey: "A3_UNINTENTIONAL_WEIGHT_LOSS",
      proposedState: "YES",
      linkedDiagnosisId: "dx-1",
      ruleId: "DX_WEIGHT_LOSS",
    }))
  })

  it("uses pediatric sleep-disordered-breathing connections", () => {
    const result = buildPreopSuggestionCandidates({
      clinicalMode: "PEDIATRIC",
      diagnoses: [{ label: "Obstructive sleep apnoea" }],
      comorbidities: [],
      medications: [],
      labs: [],
    })
    expect(result).toContainEqual(expect.objectContaining({
      stableKey: "P4_SLEEP_DISORDER_BREATHING",
      ruleId: "DX_SLEEP_DISORDER_BREATHING",
    }))
    expect(result).not.toContainEqual(expect.objectContaining({ stableKey: "BASE_STOPBANG_SNORING" }))
  })

  it("suggests bleeding only from supported current medications or labs", () => {
    const result = buildPreopSuggestionCandidates({
      clinicalMode: "ADULT",
      diagnoses: [],
      comorbidities: [],
      medications: [{ kind: "CURRENT", nameRaw: "Warfarin", inn: "warfarin", atcCode: "B01AA03" }],
      labs: [{ test: "Platelets", valueNum: 80, value: "80" }],
    })
    expect(result).toContainEqual(expect.objectContaining({ ruleId: "LAB_BLEEDING_SCREEN", stableKey: "A8_BLEEDING_DISORDER" }))
    expect(result).toContainEqual(expect.objectContaining({ ruleId: "MEDICATION_ANTITHROMBOTIC", stableKey: "A7_THROMBOSIS" }))
  })
})
