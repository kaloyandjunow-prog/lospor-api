import { BUNDLED_PREOP_QUESTIONS } from "@/lib/preop/catalog"
import { legacyAnswers } from "@/lib/preop/service"

/**
 * The answer rows a real save writes for these legacy preop fields.
 *
 * A stored case carries both: the legacy columns (still read by scores and
 * print) and the answer rows, which are what OMOP exports. A fixture that set
 * only the columns would describe a case the API can no longer produce, so the
 * fixtures derive the rows the same way savePreopAnswers does.
 */
export function answersFromLegacy(preop: Record<string, unknown>) {
  return legacyAnswers(preop).map(answer => {
    const question = BUNDLED_PREOP_QUESTIONS.find(item => item.stableKey === answer.stableKey)!
    const option = question.options.find(item => item.key === answer.optionKey)
    return {
      state: answer.state,
      optionKey: answer.optionKey ?? null,
      valueText: null,
      valueNumber: null,
      profileVersion: 1,
      source: "clinician",
      provenance: { source: "clinician" },
      question: {
        stableKey: question.stableKey,
        omopDomain: question.omopDomain ?? null,
        omopConceptId: question.omopConceptId ?? null,
        omopSourceCode: question.omopSourceCode ?? null,
      },
      option: option ? { omopConceptId: option.omopConceptId ?? null } : null,
    }
  })
}

/** Re-derive a case's answer rows after its legacy preop fields were changed. */
export function withPreopAnswers<T>(caseRow: T): T {
  const row = caseRow as { preop?: Record<string, unknown> | null }
  if (!row.preop) return caseRow
  return { ...row, preop: { ...row.preop, assessmentAnswers: answersFromLegacy(row.preop) } } as T
}
