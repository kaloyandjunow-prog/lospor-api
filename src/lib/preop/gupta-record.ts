import { guptaFromRecord } from "@lospor/core/gupta"

/**
 * The Gupta MICA risk of a stored preop, or null when an input is missing.
 *
 * Nothing is stored for Gupta beyond its inputs: age, ASA and the creatinine
 * result the record already holds, and the two catalogue answers (functional
 * status, procedure type). The OMOP export and the research record both derive
 * the percentage here, so the two can never disagree.
 */
export function guptaRiskPercent(preop: {
  ageYears?: number | null
  asaScore?: string | null
  labRows?: ReadonlyArray<{ test: string; valueNum: number | null; value: string | null; unitCanon: string | null }> | null
  assessmentAnswers?: ReadonlyArray<{ state: string; optionKey?: string | null; question: { stableKey: string } }> | null
}): number | null {
  const result = guptaFromRecord({
    ageYears: preop.ageYears,
    asaScore: preop.asaScore,
    labResults: (preop.labRows ?? []).map(row => ({
      test: row.test,
      value: row.valueNum != null ? String(row.valueNum) : row.value ?? undefined,
      unit: row.unitCanon ?? undefined,
    })),
    answers: (preop.assessmentAnswers ?? [])
      .filter(answer => answer.state === "YES")
      .map(answer => ({ stableKey: answer.question.stableKey, optionKey: answer.optionKey ?? null })),
  })
  return result.available ? result.percent : null
}
