import { PREOP_LEGACY_FIELD_BY_QUESTION } from "@lospor/core/preop-assessment"
import type { PreopSummaryFinding } from "@lospor/core/preop-documents"
import { BUNDLED_PREOP_QUESTIONS } from "@/lib/preop/catalog"

/**
 * Questions the summary does not list as findings: the allergy questions
 * have their own frame, and these describe the operation or a plan rather
 * than the patient.
 */
const NOT_A_FINDING = new Set([
  "BASE_ALLERGIES",
  "BASE_LATEX_ALLERGY",
  "BASE_APFEL_POSTOP_OPIOIDS",
  "BASE_POVOC_SURGERY_30_MINUTES",
  "BASE_POVOC_STRABISMUS_SURGERY",
  "BASE_COLDS_APPLICABLE",
  "BASE_SURGERY_URGENCY",
  "BASE_SURGERY_RISK",
  "BASE_PEDIATRIC_FASTING",
])

const statement = (label: string) => label.replace(/\s*\?\s*$/, "")

type AnswerRow = {
  state: string
  optionKey?: string | null
  valueText?: string | null
  question?: { stableKey?: string | null } | null
}

/**
 * What the preop assessment found, for the summary sheet: every question
 * answered "yes", in the catalogue's order, worded as the clinician's form
 * words it. Findings only -- a "no" and a question never asked look the same
 * on paper, so the sheet says neither (the end-of-case record's rule).
 * Baseline questions are read from their legacy fields, the others from the
 * answers table; a follow-up is printed under its question.
 */
export function preopSummaryFindings(
  preop: Record<string, unknown> | null | undefined,
  answers: readonly AnswerRow[] | null | undefined,
): PreopSummaryFinding[] {
  if (!preop) return []
  const byKey = new Map<string, AnswerRow>()
  for (const answer of answers ?? []) {
    const key = answer.question?.stableKey
    if (key) byKey.set(key, answer)
  }
  const findings: PreopSummaryFinding[] = []
  for (const question of BUNDLED_PREOP_QUESTIONS) {
    if (NOT_A_FINDING.has(question.stableKey)) continue
    const legacyField = PREOP_LEGACY_FIELD_BY_QUESTION[question.stableKey]
    let found = false
    let optionLabel: { en: string; bg: string } | null = null
    if (legacyField) {
      found = preop[legacyField] === true
    } else {
      const answer = byKey.get(question.stableKey)
      if (answer?.state === "YES") {
        found = true
        const option = answer.optionKey ? question.options.find(item => item.key === answer.optionKey) : null
        // A choice question's "yes" is the option it holds; the yes/no options add nothing.
        if (option && option.key !== "YES" && option.key !== "NO") optionLabel = { en: option.labelEn, bg: option.labelBg }
      }
    }
    if (!found) continue
    findings.push({
      stableKey: question.stableKey,
      parentKey: question.parentKey ?? null,
      // A follow-up is worded as a question ("Difficulty swallowing liquids?"); as a finding it is a statement.
      label: { en: statement(question.labelEn), bg: statement(question.labelBg) },
      option: optionLabel,
    })
  }
  // A follow-up whose question was not a finding has nothing to hang under.
  const shown = new Set(findings.map(finding => finding.stableKey))
  return findings.filter(finding => !finding.parentKey || shown.has(finding.parentKey))
}
