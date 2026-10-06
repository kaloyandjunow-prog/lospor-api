import type { BlockedSaveIssue } from "@lospor/core/sync"
import { findPII, type PiiIssue } from "@/lib/pii-check"

type Labelled = {
  label?: unknown
  name?: unknown
  term?: unknown
  code?: unknown
  sub?: unknown
  system?: unknown
  inn?: unknown
  atcCode?: unknown
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null
}

function labelList(items: unknown): string | null {
  if (!Array.isArray(items)) return text(items)
  const labels = items
    .map((item: Labelled) => text(item?.label) ?? text(item?.name) ?? text(item?.term))
    .filter((v): v is string => Boolean(v))
  return labels.length ? labels.join("; ") : null
}

function isCatalogSelectionList(items: unknown): boolean {
  return Array.isArray(items)
    && items.length > 0
    && items.every((item: Labelled) =>
      Boolean(
        text(item?.code)
        ?? text(item?.sub)
        ?? text(item?.system)
        ?? text(item?.inn)
        ?? text(item?.atcCode),
      ),
    )
}

export type ClinicalPiiIssue = BlockedSaveIssue

type ClinicalField = {
  field: string
  value: string | null
  blockedKeys: string[]
  skipNameCheck?: boolean
}

function clinicalIssue(input: ClinicalField): ClinicalPiiIssue | null {
  const issue = findPII(
    { [input.field]: input.value },
    input.skipNameCheck ? { skipNameCheck: new Set([input.field]) } : {},
  )
  return issue ? toClinicalIssue(issue, input.blockedKeys) : null
}

function toClinicalIssue(issue: PiiIssue, blockedKeys: string[]): ClinicalPiiIssue {
  return {
    code: "PII_BLOCKED",
    field: issue.field,
    reason: issue.reason,
    message: `${issue.message} Please remove identifying information before saving.`,
    retryable: false,
    blockedKeys,
  }
}

export function piiErrorBody(issue: ClinicalPiiIssue) {
  return {
    error: issue.message,
    code: issue.code,
    field: issue.field,
    reason: issue.reason,
    retryable: issue.retryable,
    blockedKeys: issue.blockedKeys,
  }
}

/**
 * Whether a save is refused for identifying text (9.14.2).
 *
 * On a hospital appliance the text is the hospital's own record, kept inside
 * the hospital: it is stored as typed and cleaned on every way out (export,
 * Central, AI). Refusing it at save turned clinical phrases ("Ритмична
 * Сърдечна дейност", "ЕКГ от 12.10.2026") into failed saves -- found on the
 * appliance testing 1.5.1. The cloud demo keeps refusing: there, names typed
 * into a note would leave the hospital. Anything but an explicit hospital
 * deployment keeps the check.
 */
export function screensIdentifyingTextAtSave(): boolean {
  return process.env.LOSPOR_DEPLOYMENT_MODE?.trim().toLowerCase() !== "hospital"
}

export function checkClinicalPayloadPII(payload: {
  preop?: Record<string, unknown>
  intraop?: Record<string, unknown>
  postop?: Record<string, unknown>
  notes?: unknown
}): ClinicalPiiIssue | null {
  if (!screensIdentifyingTextAtSave()) return null
  const preop = payload.preop ?? {}
  const intraop = payload.intraop ?? {}
  const postop = payload.postop ?? {}

  const hasDiagnoses = Array.isArray(preop.diagnoses) && preop.diagnoses.length > 0
  const hasProcedures = Array.isArray(preop.procedures) && preop.procedures.length > 0
  const fields: ClinicalField[] = [
    { field: "notes", value: text(payload.notes), blockedKeys: ["notes"] },
    hasDiagnoses
      ? {
          field: "diagnoses",
          value: labelList(preop.diagnoses),
          blockedKeys: ["diagnoses", "diagnosis", "icdCode"],
          skipNameCheck: isCatalogSelectionList(preop.diagnoses),
        }
      : {
          field: "diagnosis",
          value: text(preop.diagnosis),
          blockedKeys: ["diagnosis", "icdCode"],
        },
    hasProcedures
      ? {
          field: "procedures",
          value: labelList(preop.procedures),
          blockedKeys: ["procedures", "plannedProcedure"],
          skipNameCheck: isCatalogSelectionList(preop.procedures),
        }
      : {
          field: "plannedProcedure",
          value: text(preop.plannedProcedure),
          blockedKeys: ["plannedProcedure"],
        },
    {
      field: "comorbidities",
      value: labelList(preop.comorbidities),
      blockedKeys: ["comorbidities"],
      skipNameCheck: isCatalogSelectionList(preop.comorbidities),
    },
    { field: "teamNotes", value: text(preop.teamNotes), blockedKeys: ["teamNotes"] },
    {
      field: "allergyDetails",
      value: labelList(preop.allergyDetails),
      blockedKeys: ["allergyDetails"],
      skipNameCheck: isCatalogSelectionList(preop.allergyDetails),
    },
    {
      field: "currentMedications",
      value: labelList(preop.currentMedications),
      blockedKeys: ["currentMedications"],
      skipNameCheck: isCatalogSelectionList(preop.currentMedications),
    },
    { field: "familyAnesthesiaDetails", value: text(preop.familyAnesthesiaDetails), blockedKeys: ["familyAnesthesiaDetails"] },
    { field: "difficultAirwayNotes", value: text(preop.difficultAirwayNotes), blockedKeys: ["difficultAirwayNotes"] },
    { field: "physicalExamReport", value: text(preop.physicalExamReport), blockedKeys: ["physicalExamReport"] },
    { field: "preopNotes", value: text(preop.notes), blockedKeys: ["notes"] },
    { field: "premedicationEvening", value: text(intraop.premedicationEvening), blockedKeys: ["premedicationEvening"] },
    { field: "premedicationMorning", value: text(intraop.premedicationMorning), blockedKeys: ["premedicationMorning"] },
    { field: "airwayNotes", value: text(intraop.airwayNotes), blockedKeys: ["airwayNotes"] },
    { field: "bloodProductsNote", value: text(intraop.bloodProductsNote), blockedKeys: ["bloodProductsNote"] },
    { field: "intraopComplications", value: text(intraop.complications), blockedKeys: ["complications"] },
    { field: "postopComplications", value: text(postop.complications), blockedKeys: ["complications"] },
    { field: "dispositionNotes", value: text(postop.dispositionNotes), blockedKeys: ["dispositionNotes"] },
  ]
  for (const field of fields) {
    const issue = clinicalIssue(field)
    if (issue) return issue
  }
  return null
}

/** The typed parts of an intraop event; everything else in it is coded. */
export const EVENT_FREE_TEXT_KEYS = ["notes", "note", "comment", "description", "complicationNote", "customText"] as const

export function checkEventPII(ev: Record<string, unknown>): ClinicalPiiIssue | null {
  if (!screensIdentifyingTextAtSave()) return null
  const issue = findPII(Object.fromEntries(EVENT_FREE_TEXT_KEYS.map(key => [key, text(ev[key])])))
  return issue ? toClinicalIssue(issue, [issue.field]) : null
}
