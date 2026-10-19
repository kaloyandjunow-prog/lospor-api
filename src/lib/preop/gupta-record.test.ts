import { describe, expect, it } from "vitest"
import { guptaRiskPercent } from "./gupta-record"

const answer = (stableKey: string, optionKey: string) => ({ state: "YES", optionKey, question: { stableKey } })

describe("the Gupta risk of a stored preop", () => {
  it("is derived from age, ASA, the creatinine row and the two answers", () => {
    expect(guptaRiskPercent({
      ageYears: 80,
      asaScore: "IV",
      labRows: [{ test: "Creatinine", valueNum: 1.8, value: null, unitCanon: "mg/dL" }],
      assessmentAnswers: [answer("A15_FUNCTIONAL_STATUS", "PARTIALLY_DEPENDENT"), answer("A16_GUPTA_PROCEDURE_TYPE", "AORTIC")],
    })).toBe(14.9)
  })

  it("is absent while an input is missing, rather than guessed", () => {
    expect(guptaRiskPercent({ ageYears: 80, asaScore: "IV", assessmentAnswers: [answer("A16_GUPTA_PROCEDURE_TYPE", "AORTIC")] })).toBeNull()
    expect(guptaRiskPercent({ ageYears: 80, asaScore: "IV", assessmentAnswers: [
      { state: "NOT_ASKED", optionKey: null, question: { stableKey: "A15_FUNCTIONAL_STATUS" } },
      answer("A16_GUPTA_PROCEDURE_TYPE", "AORTIC"),
    ] })).toBeNull()
  })
})
