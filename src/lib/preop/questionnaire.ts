import {
  PREOP_ADULT_FORM_ONLY_QUESTIONS,
  PREOP_LEGACY_FIELD_BY_QUESTION,
  preopProfileForMode,
  preopQuestionAppliesToAge,
  preopQuestionAppliesToMode,
  type PreopProfileQuestion,
} from "@lospor/core/preop-assessment"
import { preopAgeInYears, type PreopQuestionnaireAnswer, type PreopQuestionnaireItem } from "@lospor/core/preop-documents"

/** Asked through its own control and printed in a section of its own (nil by mouth). */
const PRINTED_ELSEWHERE = new Set(["BASE_PEDIATRIC_FASTING"])

const ANSWERS = new Set<string>(["YES", "NO", "UNKNOWN", "NOT_APPLICABLE"])

type AnswerRow = {
  state: string
  optionKey?: string | null
  question?: { stableKey?: string | null } | null
}

type Label = { en: string; bg: string }

const optionLabel = (question: PreopProfileQuestion, key: string): Label | null => {
  const option = question.options.find(item => item.key === key)
  return option ? { en: option.labelEn, bg: option.labelBg } : null
}

/**
 * The whole questionnaire for the summary sheet: every question switched on
 * for the case's population, in the operator's order, each with its answer,
 * "no" included. A follow-up is listed only when its question was answered
 * "yes", as the form shows it. Baseline questions are read from the fields
 * their controls write; the others from the answers table.
 */
export function preopQuestionnaire(
  preop: Record<string, unknown> | null | undefined,
  answers: readonly AnswerRow[] | null | undefined,
  profile: { questions: ReadonlyArray<Omit<PreopProfileQuestion, "answerType"> & { answerType: string }> },
  mode: string | null | undefined,
): PreopQuestionnaireItem[] {
  if (!preop) return []
  // The API serialises the answer type as a plain string; nothing here reads it.
  const shape = profile as unknown as { questions: PreopProfileQuestion[] }
  const forMode = preopProfileForMode(shape, mode) ?? shape
  const rows = new Map<string, AnswerRow>()
  for (const answer of answers ?? []) {
    const key = answer.question?.stableKey
    if (key) rows.set(key, answer)
  }

  const answerOf = (question: PreopProfileQuestion): { answer: PreopQuestionnaireAnswer | null; option: Label | null } => {
    if (question.stableKey === "BASE_SURGERY_URGENCY") {
      const key = preop.emergencySurgery === true ? "EMERGENCY" : preop.elective === true ? "ELECTIVE" : null
      return key ? { answer: "YES", option: optionLabel(question, key) } : { answer: null, option: null }
    }
    if (question.stableKey === "BASE_SURGERY_RISK") {
      // A switch on the form: off is "low risk".
      return { answer: "YES", option: optionLabel(question, preop.highRiskSurgery === true ? "HIGH" : "LOW") }
    }
    const field = PREOP_LEGACY_FIELD_BY_QUESTION[question.stableKey]
    const value = field ? preop[field] : undefined
    // "Not applicable" is how the form leaves COLDS off, so its false is no answer (Core preopAnswerStates).
    if (value === true) return { answer: "YES", option: null }
    if (value === false && field !== "coldsApplicable") return { answer: "NO", option: null }
    const row = rows.get(question.stableKey)
    if (!row || !ANSWERS.has(row.state)) return { answer: null, option: null }
    const option = row.state === "YES" && row.optionKey && row.optionKey !== "YES" && row.optionKey !== "NO"
      ? optionLabel(question, row.optionKey)
      : null
    return { answer: row.state as PreopQuestionnaireAnswer, option }
  }

  const ageYears = preopAgeInYears(preop as Parameters<typeof preopAgeInYears>[0])
  const shown = (question: PreopProfileQuestion) => question.enabled && preopQuestionAppliesToMode(question.applicability, mode)
    && preopQuestionAppliesToAge(question.minAgeYears, ageYears)
    && !(mode === "PEDIATRIC" && PREOP_ADULT_FORM_ONLY_QUESTIONS.has(question.stableKey))
  const ordered = [...forMode.questions].sort((left, right) => left.sortOrder - right.sortOrder)
  const byKey = new Map(ordered.map(question => [question.stableKey, question]))
  const items: PreopQuestionnaireItem[] = []
  const answered = new Map<string, PreopQuestionnaireAnswer | null>()
  for (const question of ordered) {
    if (!shown(question) || PRINTED_ELSEWHERE.has(question.stableKey)) continue
    const { answer, option } = answerOf(question)
    answered.set(question.stableKey, answer)
    items.push({
      stableKey: question.stableKey,
      parentKey: question.parentKey,
      formSection: question.formSection,
      label: { en: question.labelEn, bg: question.labelBg },
      answer,
      option,
    })
  }
  // A follow-up is asked only under a "yes"; its question must be on the sheet too.
  return items.filter(item => !item.parentKey || (byKey.has(item.parentKey) && answered.get(item.parentKey) === "YES"))
}
