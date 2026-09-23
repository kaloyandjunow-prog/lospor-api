import { Prisma, PreopAnswerState, PreopSuggestionStatus } from "@/generated/prisma/client"
import { activePreopProfile, pinPreopProfile, type PreopProfileShape } from "./service"

export const PREOP_SUGGESTION_RULE_VERSION = "1.4.7.1"

type DiagnosisEvidence = {
  id?: string
  label: string
  code?: string | null
  source?: string | null
  sourceCode?: string | null
  standardConceptId?: number | null
}
type MedicationEvidence = {
  id?: string
  kind: string
  nameRaw: string
  inn?: string | null
  atcCode?: string | null
}
type LabEvidence = {
  id?: string
  test: string
  value?: string | null
  valueNum?: number | null
  loincCode?: string | null
}

export type SuggestionCandidate = {
  stableKey: string
  proposedState: PreopAnswerState
  evidence: Record<string, unknown>
  ruleId: string
  ruleVersion: string
  linkedDiagnosisId?: string
}

type EvidenceInput = {
  clinicalMode?: "ADULT" | "PEDIATRIC" | null
  diagnoses: DiagnosisEvidence[]
  comorbidities: DiagnosisEvidence[]
  medications: MedicationEvidence[]
  labs: LabEvidence[]
}

function haystack(row: DiagnosisEvidence | MedicationEvidence | LabEvidence): string {
  return Object.values(row).filter(value => typeof value === "string").join(" ").toLowerCase()
}

function firstMatch(rows: DiagnosisEvidence[], pattern: RegExp): DiagnosisEvidence | undefined {
  return rows.find(row => pattern.test(haystack(row)))
}

function candidate(
  stableKey: string,
  ruleId: string,
  evidence: Record<string, unknown>,
  linkedDiagnosisId?: string,
): SuggestionCandidate {
  return {
    stableKey,
    proposedState: PreopAnswerState.YES,
    evidence,
    ruleId,
    ruleVersion: PREOP_SUGGESTION_RULE_VERSION,
    ...(linkedDiagnosisId ? { linkedDiagnosisId } : {}),
  }
}

/**
 * Pure, deterministic suggestion rules. It intentionally accepts only current
 * relational evidence: no longitudinal history, no inference from missing
 * data, and no answer mutation. The returned candidates are reviewable facts,
 * not clinical conclusions.
 */
export function buildPreopSuggestionCandidates(input: EvidenceInput): SuggestionCandidate[] {
  const diagnosisRows = [...input.diagnoses, ...input.comorbidities]
  const result: SuggestionCandidate[] = []
  const addDiagnosisRule = (
    stableKey: string,
    ruleId: string,
    pattern: RegExp,
  ) => {
    const match = firstMatch(diagnosisRows, pattern)
    if (!match) return
    result.push(candidate(stableKey, ruleId, {
      evidenceType: "coded_diagnosis_or_comorbidity",
      label: match.label,
      code: match.code ?? null,
      sourceCode: match.sourceCode ?? null,
      standardConceptId: match.standardConceptId ?? null,
    }, match.id))
  }

  addDiagnosisRule("A3_UNINTENTIONAL_WEIGHT_LOSS", "DX_WEIGHT_LOSS", /weight loss|cachexia|malnutrition|unintentional.*loss/i)
  addDiagnosisRule("A5_FALLS", "DX_FALL_HISTORY", /fall|falls|recurrent collapse/i)
  addDiagnosisRule("A7_THROMBOSIS", "DX_THROMBOSIS", /deep vein thrombosis|\bdvt\b|pulmonary embol|\bpe\b|venous thrombo|vte/i)
  addDiagnosisRule("A8_BLEEDING_DISORDER", "DX_BLEEDING_DISORDER", /bleeding disorder|coagulopathy|haemophilia|hemophilia|von willebrand|abnormal bleeding/i)
  addDiagnosisRule("A11_DYSPHAGIA_ASPIRATION", "DX_DYSPHAGIA_ASPIRATION", /dysphagia|aspiration|swallowing disorder/i)
  addDiagnosisRule("A12_PACEMAKER", "DX_PACEMAKER", /pacemaker|implantable cardioverter|\bicd\b/i)
  addDiagnosisRule("A13_PREGNANCY", "DX_PREGNANCY", /pregnan|gestation|gravid/i)
  addDiagnosisRule("A14_BREASTFEEDING", "DX_BREASTFEEDING", /breastfeed|lactat/i)
  addDiagnosisRule("BASE_SMOKING", "DX_SMOKING", /smok|tobacco|nicotine dependence/i)
  addDiagnosisRule("BASE_SUBSTANCE_ABUSE", "DX_SUBSTANCE_USE", /substance use|substance abuse|alcohol dependence|opioid use/i)
  addDiagnosisRule(
    input.clinicalMode === "PEDIATRIC" ? "P4_SLEEP_DISORDER_BREATHING" : "BASE_STOPBANG_SNORING",
    "DX_SLEEP_DISORDER_BREATHING",
    /obstructive sleep apn|sleep disordered breathing|snor/i,
  )

  const medication = input.medications.find(row =>
    row.kind === "CURRENT" && /anticoagul|antiplatelet|warfarin|heparin|apixaban|rivaroxaban|dabigatran|clopidogrel/i.test(haystack(row)),
  )
  if (medication) result.push(candidate("A7_THROMBOSIS", "MEDICATION_ANTITHROMBOTIC", {
    evidenceType: "imported_current_medication",
    nameRaw: medication.nameRaw,
    inn: medication.inn ?? null,
    atcCode: medication.atcCode ?? null,
  }))

  const allergy = input.medications.find(row => row.kind === "ALLERGY" && /latex|natural rubber/i.test(haystack(row)))
  if (allergy) result.push(candidate("BASE_LATEX_ALLERGY", "IMPORTED_LATEX_ALLERGY", {
    evidenceType: "imported_allergy",
    nameRaw: allergy.nameRaw,
    inn: allergy.inn ?? null,
  }))

  const platelet = input.labs.find(row =>
    /platelet|thrombocyte/i.test(haystack(row)) && typeof row.valueNum === "number" && row.valueNum < 100,
  )
  const inr = input.labs.find(row =>
    /inr|international normalized/i.test(haystack(row)) && typeof row.valueNum === "number" && row.valueNum > 1.5,
  )
  if (platelet || inr) result.push(candidate("A8_BLEEDING_DISORDER", "LAB_BLEEDING_SCREEN", {
    evidenceType: "supported_lab",
    findings: [platelet, inr].filter(Boolean).map(row => ({
      test: row?.test,
      loincCode: row?.loincCode ?? null,
      value: row?.value ?? null,
      valueNum: row?.valueNum ?? null,
    })),
  }))

  const seen = new Set<string>()
  return result.filter(item => {
    const key = `${item.stableKey}:${item.ruleId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

type Db = any

export async function generatePreopSuggestions(db: Db, args: {
  caseId: string
  preopId: string
  actorId: string
}): Promise<{ profileVersion: number; suggestions: unknown[] }> {
  const { profile } = await pinPreopProfile(db, args.caseId, args.actorId)
  const caseRow = await db.case.findUnique({ where: { id: args.caseId }, select: { clinicalMode: true } })
  const preop = await db.preoperativeAssessment.findUnique({
    where: { id: args.preopId },
    include: { diagnoses: true, comorbidityRows: true, medications: true, labRows: true },
  })
  if (!preop) throw new Error("PREOP_NOT_FOUND")
  const enabled = new Set(profile.questions.filter((row: any) => row.enabled).map((row: any) => row.question.stableKey))
  const candidates = buildPreopSuggestionCandidates({
    clinicalMode: caseRow?.clinicalMode ?? undefined,
    diagnoses: preop.diagnoses,
    comorbidities: preop.comorbidityRows,
    medications: preop.medications,
    labs: preop.labRows,
  }).filter(item => enabled.has(item.stableKey))
  const questionByKey = new Map(profile.questions.map((row: any) => [row.question.stableKey, row.questionId]))
  const suggestions: unknown[] = []
  for (const item of candidates) {
    const questionId = questionByKey.get(item.stableKey)
    if (!questionId) continue
    const row = await db.preopAssessmentSuggestion.upsert({
      where: { preopId_questionId_ruleId_ruleVersion: {
        preopId: args.preopId, questionId, ruleId: item.ruleId, ruleVersion: item.ruleVersion,
      } },
      create: {
        preopId: args.preopId, questionId, profileVersion: profile.version,
        proposedState: item.proposedState, evidence: item.evidence as Prisma.InputJsonValue,
        ruleId: item.ruleId, ruleVersion: item.ruleVersion,
        linkedDiagnosisId: item.linkedDiagnosisId ?? null,
      },
      update: {
        profileVersion: profile.version, proposedState: item.proposedState,
        evidence: item.evidence as Prisma.InputJsonValue,
        linkedDiagnosisId: item.linkedDiagnosisId ?? null,
      },
    })
    suggestions.push(row)
  }
  return { profileVersion: profile.version, suggestions }
}

export async function reviewPreopSuggestion(db: Db, args: {
  caseId: string
  suggestionId: string
  reviewerId: string
  status: "ACCEPTED" | "REJECTED"
}) {
  const suggestion = await db.preopAssessmentSuggestion.findUnique({
    where: { id: args.suggestionId },
    include: { preop: true, question: true },
  })
  if (!suggestion || suggestion.preop.caseId !== args.caseId) throw new Error("PREOP_SUGGESTION_NOT_FOUND")
  const reviewedAt = new Date()
  if (args.status === "ACCEPTED" && suggestion.proposedState) {
    const clinicianAnswer = await db.preopAssessmentAnswer.findFirst({
      where: { preopId: suggestion.preopId, questionId: suggestion.questionId, source: "clinician" },
      orderBy: { updatedAt: "desc" },
    })
    if (!clinicianAnswer) {
      await db.preopAssessmentAnswer.upsert({
        where: { preopId_questionId_profileVersion: {
          preopId: suggestion.preopId, questionId: suggestion.questionId, profileVersion: suggestion.profileVersion,
        } },
        create: {
          preopId: suggestion.preopId, questionId: suggestion.questionId,
          profileId: (await db.preopCaseProfilePin.findUnique({ where: { caseId: args.caseId } })).profileId,
          profileVersion: suggestion.profileVersion,
          state: suggestion.proposedState, optionKey: suggestion.proposedOptionKey ?? null,
          valueText: suggestion.proposedValueText ?? null, valueNumber: suggestion.proposedValueNumber ?? null,
          source: "suggestion", provenance: { suggestionId: suggestion.id, ruleId: suggestion.ruleId, ruleVersion: suggestion.ruleVersion, linkedDiagnosisId: suggestion.linkedDiagnosisId },
          authorId: args.reviewerId,
        },
        update: {
          state: suggestion.proposedState, optionKey: suggestion.proposedOptionKey ?? null,
          valueText: suggestion.proposedValueText ?? null, valueNumber: suggestion.proposedValueNumber ?? null,
          source: "suggestion", provenance: { suggestionId: suggestion.id, ruleId: suggestion.ruleId, ruleVersion: suggestion.ruleVersion, linkedDiagnosisId: suggestion.linkedDiagnosisId },
          authorId: args.reviewerId,
        },
      })
    }
  }
  return db.preopAssessmentSuggestion.update({
    where: { id: suggestion.id },
    data: { status: args.status as PreopSuggestionStatus, reviewedById: args.reviewerId, reviewedAt },
  })
}

export type { PreopProfileShape }
