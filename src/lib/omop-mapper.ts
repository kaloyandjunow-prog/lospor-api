/**
 * OMOP CDM v5.4 mapper — export contract `source_version` 3.5.1.
 *
 * `source_version` tracks the shape of the export, not the app version: bump it
 * whenever a table or column is added, removed or reinterpreted.
 *
 * 3.5.1 — production export includes real intraoperative start/end instants in
 *         the selected row shape, so visit dates use startedAt/endedAt when
 *         present instead of falling back to legacy wall-clock columns.
 * 3.5.0 — emits PERSON and OBSERVATION_PERIOD, the root tables the CDM and the
 *         OHDSI tools (ATLAS, ACHILLES) require; without them earlier bundles
 *         were OMOP-shaped but could not be loaded. person_id is now derived
 *         from SHA-256 (52 bits) instead of a 32-bit string hash that would
 *         have collided two unrelated cases onto one person around ~70k cases.
 * 3.4.x — drug exposure from CaseEvent rows; LOINC-coded lab measurements from
 *         LabResult; care_site_source_value from Case.institutionId.
 *
 * Concept IDs stay 0 where LOSPOR has no confident standard-vocabulary mapping
 * (vitals, which carry real LOINC-backed concept_ids, are the exception). No
 * identifier is ever invented — source vocabulary and code are carried instead.
 */

import { createHash } from "node:crypto"
import { DICTIONARY_VERSION } from "@/lib/data-dictionary"
import { deriveQualityStatus } from "@lospor/core/omop"

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _counter = 1
function nextId() { return _counter++ }
function resetIds() { _counter = 1 }

// Optional deployment-wide salt. Keep it stable: changing it changes every
// pseudonym, so two exports taken either side of a change cannot be related.
const PSEUDONYM_SALT = process.env.OMOP_PSEUDONYM_SALT ?? ""

/**
 * Deterministic pseudonymous ID, derived from SHA-256.
 *
 * Takes 52 bits of the digest — the widest value that stays an exact JavaScript
 * integer. Collision becomes likely (birthday bound) somewhere past 60 million
 * cases rather than the ~70 thousand of the previous 32-bit string hash, which
 * would have silently merged two unrelated operations into one "person".
 *
 * `kind` namespaces the id so a case's person and visit ids can never coincide.
 */
function pseudonymId(kind: string, key: string): number {
  const digest = createHash("sha256").update(`${PSEUDONYM_SALT}|${kind}|${key}`).digest()
  const hi = digest.readUInt32BE(0)         // 32 bits
  const lo = digest.readUInt32BE(4) >>> 12  // top 20 bits of the next word
  return hi * 0x100000 + lo + 1             // 52 bits, never zero
}

function isoDate(d: Date | string | null | undefined): string | null {
  if (!d) return null
  const dt = typeof d === "string" ? new Date(d) : d
  return isNaN(dt.getTime()) ? null : dt.toISOString().substring(0, 10)
}

// ─── LOINC / OMOP vital concept map ──────────────────────────────────────────

const VITAL_CONCEPTS: Record<string, { concept_id: number; loinc: string; unit: string }> = {
  systolic:    { concept_id: 3004249, loinc: "8480-6",  unit: "mmHg" },
  diastolic:   { concept_id: 3012888, loinc: "8462-4",  unit: "mmHg" },
  heartRate:   { concept_id: 3027018, loinc: "8867-4",  unit: "/min" },
  spO2:        { concept_id: 3016502, loinc: "59408-5", unit: "%" },
  etco2:       { concept_id: 3020892, loinc: "19889-5", unit: "mmHg" },
  temp:        { concept_id: 3020891, loinc: "8310-5",  unit: "Cel" },
  bgl:         { concept_id: 0,       loinc: "2345-7",  unit: "mmol/L" },
  respiratoryRate: { concept_id: 3024171, loinc: "9279-1", unit: "/min" },
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OmopBundle {
  metadata: {
    export_id: string
    omop_cdm_version: string
    generated_at: string
    generated_by_user_id: string
    generated_by_role: string
    source: string
    source_version: string
    schema_version: string
    concept_map_version: string
    data_dictionary_version: string
    case_status_filter: string[]
    date_range: { from: string; to: string } | null
    included_case_count: number
    excluded_case_count: number
    app_git_commit: string
    forced_override: boolean
    case_count: number
    mapping_summary: {
      mapped_rows: number
      source_only_rows: number
      unmapped_rows: number
    }
    table_counts: Record<string, number>
    quality_warnings: ExportQualityWarning[]
    data_quality_status: "PASS" | "WARNING" | "FAIL"
    deidentification: {
      mode: string
      person_id_strategy: string
      direct_patient_identifiers_stored: boolean
      event_timestamp_precision: string
      residual_linkage_risks: string[]
    }
    note: string
  }
  // PERSON is the root of the OMOP model — every clinical row references it,
  // and OBSERVATION_PERIOD is what OHDSI tooling (ATLAS, ACHILLES) uses to
  // decide when a person was under observation. Without both, the bundle is
  // OMOP-shaped but not loadable.
  person: OmopPerson[]
  observation_period: OmopObservationPeriod[]
  visit_occurrence: OmopVisit[]
  condition_occurrence: OmopCondition[]
  drug_exposure: OmopDrug[]
  measurement: OmopMeasurement[]
  procedure_occurrence: OmopProcedure[]
  observation: OmopObservation[]
}

export interface OmopPerson {
  person_id: number
  gender_concept_id: number
  year_of_birth: number | null
  month_of_birth: null
  day_of_birth: null
  birth_datetime: null
  race_concept_id: number
  ethnicity_concept_id: number
  person_source_value: string | null
  gender_source_value: string | null
}

export interface OmopObservationPeriod {
  observation_period_id: number
  person_id: number
  observation_period_start_date: string | null
  observation_period_end_date: string | null
  period_type_concept_id: number
}

export type ExportQualityWarning = {
  code: string
  severity: "info" | "warning" | "error"
  message: string
  count?: number
}

interface OmopVisit {
  visit_occurrence_id: number
  person_id: number
  visit_concept_id: number
  visit_start_date: string | null
  visit_end_date: string | null
  visit_type_concept_id: number
  visit_source_value: string | null
  care_site_source_value: string | null
}

interface OmopCondition {
  condition_occurrence_id: number
  person_id: number
  condition_concept_id: number
  condition_start_date: string | null
  condition_type_concept_id: number
  condition_source_value: string | null
  visit_occurrence_id: number
}

interface OmopDrug {
  drug_exposure_id: number
  person_id: number
  drug_concept_id: number
  drug_exposure_start_date: string | null
  drug_type_concept_id: number
  drug_source_value: string | null
  drug_source_concept_id: string | null
  dose_value: number | null
  dose_unit_source_value: string | null
  route_source_value: string | null
  visit_occurrence_id: number
}

interface OmopMeasurement {
  measurement_id: number
  person_id: number
  measurement_concept_id: number
  measurement_date: string | null
  measurement_datetime: string | null
  measurement_type_concept_id: number
  value_as_number: number | null
  unit_concept_id: number
  unit_source_value: string | null
  measurement_source_value: string | null
  visit_occurrence_id: number
}

interface OmopProcedure {
  procedure_occurrence_id: number
  person_id: number
  procedure_concept_id: number
  procedure_date: string | null
  procedure_type_concept_id: number
  procedure_source_value: string | null
  visit_occurrence_id: number
}

interface OmopObservation {
  observation_id: number
  person_id: number
  observation_concept_id: number
  observation_date: string | null
  observation_type_concept_id: number
  value_as_string: string | null
  observation_source_value: string | null
  visit_occurrence_id: number
}

// ─── Main mapper ──────────────────────────────────────────────────────────────

type CaseRow = {
  id: string
  caseCode: string | null
  createdAt: Date
  status: string
  institutionId?: string | null
  user?: { institution?: { name: string | null } | null } | null
  events?: {
    type: string
    timestamp: Date
    label: string | null
    value: string | null
    unit: string | null
    rate?: string | null
    concentration?: string | null
    volume?: string | null
    fluidCategory?: string | null
    agentPercent?: number | null
    fgfLitersPerMin?: number | null
    carrierGas?: string | null
    fio2Percent?: number | null
    fiAirPercent?: number | null
    fiN2OPercent?: number | null
    systolic?: number | null
    diastolic?: number | null
    heartRate?: number | null
    spO2?: number | null
    etco2?: number | null
    temp?: number | null
    bgl: number | null
    bglLoincCode: string | null
    bglUnitCanon: string | null
    atcCode: string | null
    drugId: string | null
    inn?: string | null
    drugRoute?: string | null
    metadataJson: unknown
  }[]
  selections?: {
    section: string
    category: string
    value: string
    ordinal: number
  }[]
  complications?: {
    section: string
    label: string
    note: string | null
    timestamp: Date | null
    source: string | null
    ordinal: number
  }[]
  preop?: {
    ageYears: number | null
    sex: string
    heightCm: number | null
    weightKg: number | null
    bpSystolic: number | null
    bpDiastolic: number | null
    heartRate: number | null
    spO2: number | null
    temperature: number | null
    respiratoryRate: number | null
    diagnosis: string
    diagnosesJson: unknown
    plannedProcedure: string
    proceduresJson: unknown
    comorbidities: unknown
    asaScore: string | null
    emergencySurgery: boolean
    highRiskSurgery: boolean
    allergies: boolean
    allergyDetails: string | null
    smoking: boolean
    substanceAbuse: boolean
    currentMedications: string | null
    rcriScore: number | null
    apfelScore: number | null
    stopBangScore: number | null
    difficultAirwayHistory: boolean
    mallampati: string | null
    labResults: unknown
    labRows?: {
      test: string
      valueNum: number | null
      value: string | null
      unitCanon: string | null
      loincCode: string | null
      abnormalFlag: string | null
      standardConceptId?: number | null
      mappingStatus?: string
    }[]
    diagnoses?: {
      code: string | null
      label: string
      labelEn: string | null
      labelBg: string | null
      sourceVocabulary?: string | null
      sourceCode?: string | null
      standardConceptId?: number | null
      mappingStatus?: string
      ordinal: number
    }[]
    procedureRows?: {
      code: string | null
      group: string | null
      domain: string | null
      description: string | null
      sourceVocabulary?: string | null
      sourceCode?: string | null
      standardConceptId?: number | null
      mappingStatus?: string
      ordinal: number
    }[]
    comorbidityRows?: {
      label: string
      labelEn: string | null
      labelBg: string | null
      code: string | null
      icd10Code: string | null
      sourceVocabulary?: string | null
      sourceCode?: string | null
      standardConceptId?: number | null
      mappingStatus?: string
      ordinal: number
    }[]
    medications?: {
      kind: string
      nameRaw: string
      inn: string | null
      atcCode: string | null
      dose: string | null
      route: string | null
      sourceVocabulary?: string | null
      sourceCode?: string | null
      standardConceptId?: number | null
      mappingStatus?: string
      ordinal: number
    }[]
  } | null
  intraop?: {
    // Real instants when the record has them — the only form that can be placed
    // on a timeline or compared across sites.
    startedAt?: Date | null
    endedAt?: Date | null
    timezone?: string | null
    // Legacy bare wall clock, nullable: a case may not have started, and older
    // rows carry no zone so this cannot be resolved to a true instant.
    startTime: Date | null
    endTime: Date | null
    durationMinutes: number | null
    monthYear: string | null
    techniques: unknown
    keyEvents: unknown
    crystalloidsMl: number | null
    colloidsMl: number | null
    bloodMl: number | null
    urineMl: number | null
    complications: string | null
    premedicationEvening: string | null
    premedicationMorning: string | null
    airwayDevice: string | null
    vascularAccessRows?: {
      site: string | null
      siteLabel: string | null
      size: string | null
      sizeUnit: string | null
      depthCm: string | null
      lumens: string | null
      preexisting: boolean
      ordinal: number
    }[]
    premedicationRows?: {
      phase: string
      nameRaw: string
      inn: string | null
      atcCode: string | null
      standardConceptId?: number | null
      mappingStatus?: string
      dose: string | null
      route: string | null
      ordinal: number
    }[]
  } | null
  postop?: {
    aldreteActivity: number | null
    aldreteRespiration: number | null
    aldreteCirculation: number | null
    aldreteConsciousness: number | null
    aldreteSpO2: number | null
    aldreteTotal: number | null
    recoveryBpSystolic: number | null
    recoveryBpDiastolic: number | null
    recoveryHeartRate: number | null
    recoverySpO2: number | null
    temperatureCelsius: number | null
    painScoreNRS: number | null
    ponv: boolean
    disposition: string | null
    complications: string | null
  } | null
  fieldStatuses?: {
    section: string
    fieldKey: string
    presence: string
  }[]
  snapshot?: { id: string } | null
  updatedAt?: Date
  finalizedAt?: Date | null
}

function buildQualityWarnings(
  cases: CaseRow[],
  mappingSummary: { mapped_rows: number; source_only_rows: number; unmapped_rows: number },
): ExportQualityWarning[] {
  const warnings: ExportQualityWarning[] = []

  // ── Error-level (FAIL) checks ──────────────────────────────────────────────

  const nonFinalizedCount = cases.filter(c => c.status !== "COMPLETE").length
  if (nonFinalizedCount > 0) {
    warnings.push({
      code: "NON_FINALIZED_CASES",
      severity: "error",
      message: "Export includes cases that have not been finalised (status !== COMPLETE). Research integrity requires finalised cases only.",
      count: nonFinalizedCount,
    })
  }

  const missingSnapshotCount = cases.filter(c => c.status === "COMPLETE" && !c.snapshot).length
  if (missingSnapshotCount > 0) {
    warnings.push({
      code: "MISSING_FINALIZATION_SNAPSHOT",
      severity: "error",
      message: "Some finalised cases have no immutable snapshot. The snapshot is written at finalisation; its absence indicates a corrupted or interrupted finalisation.",
      count: missingSnapshotCount,
    })
  }

  const relationalDriftCount = cases.filter(c => {
    if (!c.updatedAt || !c.finalizedAt) return false
    return c.updatedAt.getTime() > c.finalizedAt.getTime() + 5_000
  }).length
  if (relationalDriftCount > 0) {
    warnings.push({
      code: "RELATIONAL_DRIFT",
      severity: "error",
      message: "Some cases were edited after finalisation (updatedAt > finalizedAt). The snapshot may not match the exported data.",
      count: relationalDriftCount,
    })
  }

  const impossibleTimestampCount = cases.filter(c => {
    const start = c.intraop?.startedAt ?? c.intraop?.startTime
    const end = c.intraop?.endedAt ?? c.intraop?.endTime
    if (!start || !end) return false
    return end < start
  }).length
  if (impossibleTimestampCount > 0) {
    warnings.push({
      code: "IMPOSSIBLE_TIMESTAMPS",
      severity: "error",
      message: "Some cases have intraoperative end time before start time, indicating a data entry error.",
      count: impossibleTimestampCount,
    })
  }

  // ── Warning-level checks ───────────────────────────────────────────────────

  const casesWithoutFieldStatus = cases.filter(c => (c.fieldStatuses ?? []).length === 0).length
  const exactTimestampRows = cases.reduce((sum, c) => sum + (c.events ?? []).length, 0)
  const freeTextComplications = cases.reduce((sum, c) => sum + (c.complications ?? []).filter(comp => Boolean(comp.note)).length, 0)
  const institutionLinked = cases.filter(c => Boolean(c.institutionId ?? c.user?.institution?.name)).length

  if (mappingSummary.unmapped_rows > 0) {
    warnings.push({
      code: "UNMAPPED_CONCEPT_ROWS",
      severity: "warning",
      message: "Some normalized rows have no source or standard vocabulary mapping.",
      count: mappingSummary.unmapped_rows,
    })
  }
  if (mappingSummary.source_only_rows > 0) {
    warnings.push({
      code: "SOURCE_ONLY_CONCEPT_ROWS",
      severity: "info",
      message: "Some rows preserve source vocabulary/code without a confident OMOP standard concept ID.",
      count: mappingSummary.source_only_rows,
    })
  }
  if (casesWithoutFieldStatus > 0) {
    warnings.push({
      code: "NO_FIELD_STATUS_ROWS",
      severity: "error",
      message: "Some cases have no ClinicalFieldStatus rows. Field-level missingness cannot be determined; relational sync may not have run.",
      count: casesWithoutFieldStatus,
    })
  }
  if (exactTimestampRows > 0) {
    warnings.push({
      code: "EXACT_EVENT_TIMESTAMPS",
      severity: "info",
      message: "Intraoperative events retain exact timestamps for clinical sequence analysis; this is a residual linkage risk.",
      count: exactTimestampRows,
    })
  }
  if (institutionLinked > 0) {
    warnings.push({
      code: "INSTITUTION_LINKAGE",
      severity: "info",
      message: "Exports include care_site_source_value for research governance; small institutions can increase re-identification risk.",
      count: institutionLinked,
    })
  }
  if (freeTextComplications > 0) {
    warnings.push({
      code: "REDACTED_FREE_TEXT_PRESENT",
      severity: "warning",
      message: "Free-text complication notes existed and were passed through the export redaction pipeline. Review redacted output before sharing.",
      count: freeTextComplications,
    })
  }
  return warnings
}

export interface ExportContext {
  userId: string
  userRole: string
  statusFilter: string[]
  excludedCaseCount: number
  gitCommit: string
  forcedOverride: boolean
}

export function mapCasesToOmop(cases: CaseRow[], ctx?: ExportContext): OmopBundle {
  resetIds()

  const persons: OmopPerson[] = []
  const observationPeriods: OmopObservationPeriod[] = []
  const visits: OmopVisit[] = []
  const conditions: OmopCondition[] = []
  const drugs: OmopDrug[] = []
  const measurements: OmopMeasurement[] = []
  const procedures: OmopProcedure[] = []
  const observations: OmopObservation[] = []
  const mappingSummary = { mapped_rows: 0, source_only_rows: 0, unmapped_rows: 0 }

  const trackMapping = (status: string | null | undefined) => {
    if (status === "MAPPED") mappingSummary.mapped_rows++
    else if (status === "UNMAPPED") mappingSummary.unmapped_rows++
    else if (status === "SOURCE_ONLY") mappingSummary.source_only_rows++
  }

  const sourceValue = (prefix: string, sourceVocabulary?: string | null, sourceCode?: string | null, label?: string | null) =>
    sourceVocabulary && sourceCode ? `${sourceVocabulary}:${sourceCode}${label ? ` - ${label}` : ""}` : `${prefix}:${label ?? "unknown"}`

  for (const c of cases) {
    const personId = pseudonymId("person", c.id)
    const visitId  = pseudonymId("visit", c.id)
    // Prefer the real instants. The legacy startTime/endTime columns hold a bare
    // wall clock on a dummy date (2000-01-01) with no zone, so using them as a
    // date would export the year 2000 for every legacy case; fall back to
    // createdAt instead, which is at least a genuine moment. Never emit the
    // dummy date as if it were the day of surgery.
    const legacyDay = (d: Date | null | undefined) =>
      d && d.getUTCFullYear() > 2000 ? d : null
    const startDate = isoDate(c.intraop?.startedAt ?? legacyDay(c.intraop?.startTime) ?? c.createdAt)
    const endDate   = isoDate(c.intraop?.endedAt ?? legacyDay(c.intraop?.endTime) ?? c.intraop?.startedAt ?? c.createdAt)

    // care_site: prefer case-level institutionId, fall back to user institution
    const careSite = c.institutionId ?? c.user?.institution?.name ?? null

    // ── PERSON ───────────────────────────────────────────────────────────────
    // One person per case: LOSPOR deliberately stores no patient identifier, so
    // the same patient returning for a second operation cannot be recognised.
    // Documented as a research limitation, not an accident.
    // 8507/8532 are the OMOP standard gender concepts. OTHER and UNKNOWN both
    // fall through to 0 ("no matching concept"), but they mean different things
    // in the source data and are preserved verbatim in gender_source_value.
    const GENDER_CONCEPT: Record<string, number> = { MALE: 8507, FEMALE: 8532 }
    const ageAtOp = c.preop?.ageYears ?? null
    const opYear = startDate ? Number(startDate.substring(0, 4)) : null
    persons.push({
      person_id:            personId,
      // 0 = "no matching concept", the OMOP convention for unknown/other.
      gender_concept_id:    (c.preop?.sex && GENDER_CONCEPT[c.preop.sex]) || 0,
      // Only age-in-years is collected, so the birth year is approximate (±1)
      // and month/day are genuinely unknown rather than defaulted.
      year_of_birth:        (ageAtOp != null && opYear != null) ? opYear - ageAtOp : null,
      month_of_birth:       null,
      day_of_birth:         null,
      birth_datetime:       null,
      race_concept_id:      0,   // not collected
      ethnicity_concept_id: 0,   // not collected
      person_source_value:  c.caseCode,
      gender_source_value:  c.preop?.sex ?? null,
    })

    // ── OBSERVATION_PERIOD ───────────────────────────────────────────────────
    // Spans the operation itself: the only window in which this pseudonymous
    // person is observed. OHDSI cohort tooling requires this to exist.
    observationPeriods.push({
      observation_period_id:         pseudonymId("obsperiod", c.id),
      person_id:                     personId,
      observation_period_start_date: startDate,
      observation_period_end_date:   endDate ?? startDate,
      period_type_concept_id:        32817, // EHR
    })

    // ── VISIT_OCCURRENCE ─────────────────────────────────────────────────────
    visits.push({
      visit_occurrence_id:   visitId,
      person_id:             personId,
      visit_concept_id:      9201,  // Inpatient Visit
      visit_start_date:      startDate,
      visit_end_date:        endDate,
      visit_type_concept_id: 32817, // EHR
      visit_source_value:    c.caseCode,
      care_site_source_value: careSite,
    })

    const preop = c.preop

    // ── Preop vitals -> MEASUREMENT ───────────────────────────────────────────
    if (preop) {
      const vitDate = isoDate(c.createdAt)
      const vitalMap: [keyof typeof VITAL_CONCEPTS, number | null | undefined][] = [
        ["systolic",        preop.bpSystolic],
        ["diastolic",       preop.bpDiastolic],
        ["heartRate",       preop.heartRate],
        ["spO2",            preop.spO2],
        ["temp",            preop.temperature],
        ["respiratoryRate", preop.respiratoryRate],
      ]
      for (const [key, val] of vitalMap) {
        if (val == null) continue
        const cfg = VITAL_CONCEPTS[key]
        measurements.push({
          measurement_id:            nextId(),
          person_id:                 personId,
          measurement_concept_id:    cfg.concept_id,
          measurement_date:          vitDate,
          measurement_datetime:      vitDate,
          measurement_type_concept_id: 32817,
          value_as_number:           val,
          unit_concept_id:           0,
          unit_source_value:         cfg.unit,
          measurement_source_value:  `LOINC:${cfg.loinc}`,
          visit_occurrence_id:       visitId,
        })
      }

      // ── Lab results from LabResult rows -> MEASUREMENT ────────────────────
      // Use SQL LabResult rows (LOINC-coded) instead of raw JSON
      const labRows = preop.labRows ?? []
      for (const lab of labRows) {
        if (lab.valueNum == null) continue
        trackMapping(lab.mappingStatus)
        measurements.push({
          measurement_id:              nextId(),
          person_id:                   personId,
          measurement_concept_id:      lab.standardConceptId ?? 0,
          measurement_date:            vitDate,
          measurement_datetime:        vitDate,
          measurement_type_concept_id: 32817,
          value_as_number:             lab.valueNum,
          unit_concept_id:             0,
          unit_source_value:           lab.unitCanon ?? null,
          measurement_source_value:    lab.loincCode ? `LOINC:${lab.loincCode}` : `LAB:${lab.test}`,
          visit_occurrence_id:         visitId,
        })
      }

      // ── Comorbidities -> CONDITION_OCCURRENCE ─────────────────────────────
      for (const co of preop.comorbidityRows ?? []) {
        trackMapping(co.mappingStatus)
        conditions.push({
          condition_occurrence_id:    nextId(),
          person_id:                 personId,
          condition_concept_id:      co.standardConceptId ?? 0,
          condition_start_date:      isoDate(c.createdAt),
          condition_type_concept_id: 32817,
          condition_source_value:    sourceValue("COMORBIDITY", co.sourceVocabulary, co.sourceCode, co.labelEn ?? co.labelBg ?? co.label),
          visit_occurrence_id:       visitId,
        })
      }

      // Primary diagnosis -> CONDITION_OCCURRENCE
      const diagRows = preop.diagnoses ?? []
      if (diagRows.length > 0) {
        for (const diag of diagRows) {
          trackMapping(diag.mappingStatus)
          conditions.push({
            condition_occurrence_id:    nextId(),
            person_id:                 personId,
            condition_concept_id:      diag.standardConceptId ?? 0,
            condition_start_date:      isoDate(c.createdAt),
            condition_type_concept_id: 32817,
            condition_source_value:    sourceValue("DIAGNOSIS", diag.sourceVocabulary, diag.sourceCode, diag.labelEn ?? diag.labelBg ?? diag.label),
            visit_occurrence_id:       visitId,
          })
        }
      } else if (preop.diagnosis) {
        conditions.push({
          condition_occurrence_id:    nextId(),
          person_id:                 personId,
          condition_concept_id:      0,
          condition_start_date:      isoDate(c.createdAt),
          condition_type_concept_id: 32817,
          condition_source_value:    preop.diagnosis,
          visit_occurrence_id:       visitId,
        })
      }

      // ── Observations: ASA, RCRI, Apfel, STOP-BANG, airway ───────────────
      if (preop.asaScore) {
        observations.push({
          observation_id:           nextId(),
          person_id:                personId,
          observation_concept_id:   4173987, // ASA Physical Status concept
          observation_date:         isoDate(c.createdAt),
          observation_type_concept_id: 32817,
          value_as_string:          preop.asaScore + (preop.emergencySurgery ? "E" : ""),
          observation_source_value: "ASA_PHYSICAL_STATUS",
          visit_occurrence_id:      visitId,
        })
      }
      if (preop.rcriScore != null) {
        observations.push({
          observation_id: nextId(), person_id: personId,
          observation_concept_id: 0,
          observation_date: isoDate(c.createdAt), observation_type_concept_id: 32817,
          value_as_string: String(preop.rcriScore),
          observation_source_value: "RCRI_SCORE", visit_occurrence_id: visitId,
        })
      }
      if (preop.apfelScore != null) {
        observations.push({
          observation_id: nextId(), person_id: personId,
          observation_concept_id: 0,
          observation_date: isoDate(c.createdAt), observation_type_concept_id: 32817,
          value_as_string: String(preop.apfelScore),
          observation_source_value: "APFEL_SCORE_PONV", visit_occurrence_id: visitId,
        })
      }
      if (preop.stopBangScore != null) {
        observations.push({
          observation_id: nextId(), person_id: personId,
          observation_concept_id: 0,
          observation_date: isoDate(c.createdAt), observation_type_concept_id: 32817,
          value_as_string: String(preop.stopBangScore),
          observation_source_value: "STOPBANG_SCORE_OSA", visit_occurrence_id: visitId,
        })
      }
      if (preop.difficultAirwayHistory) {
        observations.push({
          observation_id: nextId(), person_id: personId,
          observation_concept_id: 0,
          observation_date: isoDate(c.createdAt), observation_type_concept_id: 32817,
          value_as_string: "true",
          observation_source_value: "DIFFICULT_AIRWAY_HISTORY", visit_occurrence_id: visitId,
        })
      }
      if (preop.mallampati) {
        observations.push({
          observation_id: nextId(), person_id: personId,
          observation_concept_id: 0,
          observation_date: isoDate(c.createdAt), observation_type_concept_id: 32817,
          value_as_string: preop.mallampati,
          observation_source_value: "MALLAMPATI_CLASS", visit_occurrence_id: visitId,
        })
      }
    }

    // ── Planned procedure -> PROCEDURE_OCCURRENCE ─────────────────────────────
    const procLabel = (() => {
      if (!preop) return null
      const row = preop.procedureRows?.[0]
      if (row) return sourceValue("PROCEDURE", row.sourceVocabulary, row.sourceCode, row.group ?? row.description)
      return preop.plannedProcedure
    })()
    if (procLabel) {
      const row = preop?.procedureRows?.[0]
      trackMapping(row?.mappingStatus)
      procedures.push({
        procedure_occurrence_id:    nextId(),
        person_id:                 personId,
        procedure_concept_id:      row?.standardConceptId ?? 0,
        procedure_date:            startDate,
        procedure_type_concept_id: 32817,
        procedure_source_value:    procLabel,
        visit_occurrence_id:       visitId,
      })
    }

    // ── Intraop techniques -> PROCEDURE_OCCURRENCE ────────────────────────────
    for (const med of preop?.medications ?? []) {
      trackMapping(med.mappingStatus)
      const dose = med.dose ? parseFloat(med.dose) || null : null
      drugs.push({
        drug_exposure_id: nextId(),
        person_id: personId,
        drug_concept_id: med.standardConceptId ?? 0,
        drug_exposure_start_date: isoDate(c.createdAt),
        drug_type_concept_id: 32817,
        drug_source_value: sourceValue("MEDICATION", med.sourceVocabulary, med.sourceCode, med.nameRaw),
        drug_source_concept_id: med.atcCode ? `ATC:${med.atcCode}` : med.inn ? `INN:${med.inn}` : null,
        dose_value: dose,
        dose_unit_source_value: med.dose,
        route_source_value: med.route,
        visit_occurrence_id: visitId,
      })
    }

    if (c.intraop) {
      const techs: string[] = Array.isArray(c.intraop.techniques) ? c.intraop.techniques as string[] : []
      for (const tech of techs) {
        procedures.push({
          procedure_occurrence_id:    nextId(),
          person_id:                 personId,
          procedure_concept_id:      0,
          procedure_date:            startDate,
          procedure_type_concept_id: 32817,
          procedure_source_value:    `ANAESTHESIA_TECHNIQUE:${tech}`,
          visit_occurrence_id:       visitId,
        })
      }

      // ── Drug events from CaseEvent rows -> DRUG_EXPOSURE ─────────────────
      // Read from SQL CaseEvent rows (type="drug", status="active")
      // instead of parsing the legacy keyEvents.log JSON blob
      const drugEvents = c.events ?? []
      for (const ev of drugEvents) {
        if (ev.type === "vital") {
          const eventVitals: [keyof typeof VITAL_CONCEPTS, number | null | undefined, string | null | undefined][] = [
            ["systolic", ev.systolic, null],
            ["diastolic", ev.diastolic, null],
            ["heartRate", ev.heartRate, null],
            ["spO2", ev.spO2, null],
            ["etco2", ev.etco2, null],
            ["temp", ev.temp, null],
            ["bgl", ev.bgl, ev.bglLoincCode],
          ]
          for (const [key, val, loincOverride] of eventVitals) {
            if (val == null) continue
            const cfg = VITAL_CONCEPTS[key]
            measurements.push({
              measurement_id:            nextId(),
              person_id:                 personId,
              measurement_concept_id:    cfg.concept_id,
              measurement_date:          isoDate(ev.timestamp),
              measurement_datetime:      ev.timestamp.toISOString(),
              measurement_type_concept_id: 32817,
              value_as_number:           val,
              unit_concept_id:           0,
              unit_source_value:         key === "bgl" ? ev.bglUnitCanon ?? cfg.unit : cfg.unit,
              measurement_source_value:  `LOINC:${loincOverride ?? cfg.loinc}`,
              visit_occurrence_id:       visitId,
            })
          }
        }
        if (ev.type === "gas_start" || ev.type === "gas_change") {
          const gasValues: [string, number | null | undefined, string][] = [
            ["INTRAOP_FGF_L_PER_MIN", ev.fgfLitersPerMin, "L/min"],
            ["INTRAOP_FIO2_PERCENT", ev.fio2Percent, "%"],
            ["INTRAOP_FIAIR_PERCENT", ev.fiAirPercent, "%"],
            ["INTRAOP_FIN2O_PERCENT", ev.fiN2OPercent, "%"],
          ]
          for (const [source, val, unit] of gasValues) {
            if (val == null) continue
            measurements.push({
              measurement_id: nextId(), person_id: personId,
              measurement_concept_id: 0,
              measurement_date: isoDate(ev.timestamp),
              measurement_datetime: ev.timestamp.toISOString(),
              measurement_type_concept_id: 32817,
              value_as_number: val,
              unit_concept_id: 0,
              unit_source_value: unit,
              measurement_source_value: source,
              visit_occurrence_id: visitId,
            })
          }
          if (ev.carrierGas) observations.push({ observation_id: nextId(), person_id: personId, observation_concept_id: 0, observation_date: isoDate(ev.timestamp), observation_type_concept_id: 32817, value_as_string: ev.carrierGas, observation_source_value: "INTRAOP_CARRIER_GAS", visit_occurrence_id: visitId })
        }
        if (ev.type !== "drug" && ev.type !== "agent_start" && ev.type !== "infusion_start") continue
        const meta = (ev.metadataJson ?? {}) as Record<string, unknown>
        const doseSource = ev.type === "infusion_start" ? ev.rate : meta.dose
        const dose = doseSource != null ? parseFloat(String(doseSource)) || null : null
        drugs.push({
          drug_exposure_id:           nextId(),
          person_id:                  personId,
          drug_concept_id:            0,
          drug_exposure_start_date:   isoDate(ev.timestamp),
          drug_type_concept_id:       32817,
          drug_source_value:          (meta.name as string | undefined) ?? ev.label ?? null,
          drug_source_concept_id:     ev.atcCode ? `ATC:${ev.atcCode}` : null,
          dose_value:                 dose,
          dose_unit_source_value:     ev.unit ?? (meta.unit as string | undefined) ?? (ev.type === "agent_start" ? "%" : null),
          route_source_value:         ev.drugRoute ?? (meta.drugRoute as string | undefined) ?? (ev.type === "agent_start" ? "INHALATIONAL" : "IV"),
          visit_occurrence_id:        visitId,
        })
      }

      for (const prem of c.intraop.premedicationRows ?? []) {
        trackMapping(prem.mappingStatus)
        const dose = prem.dose ? parseFloat(prem.dose) || null : null
        drugs.push({
          drug_exposure_id: nextId(), person_id: personId,
          drug_concept_id: prem.standardConceptId ?? 0,
          drug_exposure_start_date: startDate,
          drug_type_concept_id: 32817,
          drug_source_value: prem.nameRaw,
          drug_source_concept_id: prem.atcCode ? `ATC:${prem.atcCode}` : null,
          dose_value: dose,
          dose_unit_source_value: prem.dose,
          route_source_value: prem.route,
          visit_occurrence_id: visitId,
        })
        observations.push({ observation_id: nextId(), person_id: personId, observation_concept_id: 0, observation_date: startDate, observation_type_concept_id: 32817, value_as_string: prem.phase, observation_source_value: "PREMEDICATION_PHASE", visit_occurrence_id: visitId })
      }

      for (const line of c.intraop.vascularAccessRows ?? []) {
        procedures.push({
          procedure_occurrence_id: nextId(), person_id: personId,
          procedure_concept_id: 0,
          procedure_date: startDate,
          procedure_type_concept_id: 32817,
          procedure_source_value: `VASCULAR_ACCESS:${line.siteLabel ?? line.site ?? "unknown"}${line.size ? ` ${line.size}${line.sizeUnit ?? ""}` : ""}`,
          visit_occurrence_id: visitId,
        })
      }

      // Fluid totals as observations
      if (c.intraop.crystalloidsMl != null) observations.push({ observation_id: nextId(), person_id: personId, observation_concept_id: 0, observation_date: endDate, observation_type_concept_id: 32817, value_as_string: String(c.intraop.crystalloidsMl), observation_source_value: "CRYSTALLOIDS_ML", visit_occurrence_id: visitId })
      if (c.intraop.colloidsMl != null) observations.push({ observation_id: nextId(), person_id: personId, observation_concept_id: 0, observation_date: endDate, observation_type_concept_id: 32817, value_as_string: String(c.intraop.colloidsMl), observation_source_value: "COLLOIDS_ML", visit_occurrence_id: visitId })
      if (c.intraop.bloodMl != null) observations.push({ observation_id: nextId(), person_id: personId, observation_concept_id: 0, observation_date: endDate, observation_type_concept_id: 32817, value_as_string: String(c.intraop.bloodMl), observation_source_value: "BLOOD_ML", visit_occurrence_id: visitId })
      if (c.intraop.urineMl != null) observations.push({ observation_id: nextId(), person_id: personId, observation_concept_id: 0, observation_date: endDate, observation_type_concept_id: 32817, value_as_string: String(c.intraop.urineMl), observation_source_value: "URINE_OUTPUT_ML", visit_occurrence_id: visitId })
    }

    for (const sel of c.selections ?? []) {
      observations.push({
        observation_id: nextId(), person_id: personId,
        observation_concept_id: 0,
        observation_date: startDate,
        observation_type_concept_id: 32817,
        value_as_string: sel.value,
        observation_source_value: `${sel.section.toUpperCase()}_${sel.category.toUpperCase()}`,
        visit_occurrence_id: visitId,
      })
    }

    for (const comp of c.complications ?? []) {
      observations.push({
        observation_id: nextId(), person_id: personId,
        observation_concept_id: 0,
        observation_date: isoDate(comp.timestamp) ?? (comp.section === "postop" ? endDate : startDate),
        observation_type_concept_id: 32817,
        value_as_string: comp.note ? `${comp.label}; ${comp.note}` : comp.label,
        observation_source_value: `${comp.section.toUpperCase()}_COMPLICATION`,
        visit_occurrence_id: visitId,
      })
    }

    // ── Postop -> OBSERVATION ─────────────────────────────────────────────────
    if (c.postop) {
      const postDate = endDate ?? isoDate(c.createdAt)
      const postopVitals: [keyof typeof VITAL_CONCEPTS, number | null | undefined][] = [
        ["systolic", c.postop.recoveryBpSystolic],
        ["diastolic", c.postop.recoveryBpDiastolic],
        ["heartRate", c.postop.recoveryHeartRate],
        ["spO2", c.postop.recoverySpO2],
        ["temp", c.postop.temperatureCelsius],
      ]
      for (const [key, val] of postopVitals) {
        if (val == null) continue
        const cfg = VITAL_CONCEPTS[key]
        measurements.push({ measurement_id: nextId(), person_id: personId, measurement_concept_id: cfg.concept_id, measurement_date: postDate, measurement_datetime: postDate, measurement_type_concept_id: 32817, value_as_number: val, unit_concept_id: 0, unit_source_value: cfg.unit, measurement_source_value: `POSTOP_LOINC:${cfg.loinc}`, visit_occurrence_id: visitId })
      }
      if (c.postop.aldreteActivity != null) observations.push({ observation_id: nextId(), person_id: personId, observation_concept_id: 0, observation_date: postDate, observation_type_concept_id: 32817, value_as_string: String(c.postop.aldreteActivity), observation_source_value: "ALDRETE_ACTIVITY", visit_occurrence_id: visitId })
      if (c.postop.aldreteRespiration != null) observations.push({ observation_id: nextId(), person_id: personId, observation_concept_id: 0, observation_date: postDate, observation_type_concept_id: 32817, value_as_string: String(c.postop.aldreteRespiration), observation_source_value: "ALDRETE_RESPIRATION", visit_occurrence_id: visitId })
      if (c.postop.aldreteCirculation != null) observations.push({ observation_id: nextId(), person_id: personId, observation_concept_id: 0, observation_date: postDate, observation_type_concept_id: 32817, value_as_string: String(c.postop.aldreteCirculation), observation_source_value: "ALDRETE_CIRCULATION", visit_occurrence_id: visitId })
      if (c.postop.aldreteConsciousness != null) observations.push({ observation_id: nextId(), person_id: personId, observation_concept_id: 0, observation_date: postDate, observation_type_concept_id: 32817, value_as_string: String(c.postop.aldreteConsciousness), observation_source_value: "ALDRETE_CONSCIOUSNESS", visit_occurrence_id: visitId })
      if (c.postop.aldreteSpO2 != null) observations.push({ observation_id: nextId(), person_id: personId, observation_concept_id: 0, observation_date: postDate, observation_type_concept_id: 32817, value_as_string: String(c.postop.aldreteSpO2), observation_source_value: "ALDRETE_SPO2", visit_occurrence_id: visitId })
      if (c.postop.aldreteTotal != null) observations.push({ observation_id: nextId(), person_id: personId, observation_concept_id: 0, observation_date: postDate, observation_type_concept_id: 32817, value_as_string: String(c.postop.aldreteTotal), observation_source_value: "ALDRETE_TOTAL", visit_occurrence_id: visitId })
      if (c.postop.painScoreNRS != null) observations.push({ observation_id: nextId(), person_id: personId, observation_concept_id: 3020891, observation_date: postDate, observation_type_concept_id: 32817, value_as_string: String(c.postop.painScoreNRS), observation_source_value: "PAIN_NRS_0_10", visit_occurrence_id: visitId })
      if (c.postop.ponv) observations.push({ observation_id: nextId(), person_id: personId, observation_concept_id: 0, observation_date: postDate, observation_type_concept_id: 32817, value_as_string: "true", observation_source_value: "PONV_PRESENT", visit_occurrence_id: visitId })
      if (c.postop.disposition) observations.push({ observation_id: nextId(), person_id: personId, observation_concept_id: 0, observation_date: postDate, observation_type_concept_id: 32817, value_as_string: c.postop.disposition, observation_source_value: "POSTOP_DISPOSITION", visit_occurrence_id: visitId })
    }
  }

  const tableCounts = {
    person: persons.length,
    observation_period: observationPeriods.length,
    visit_occurrence: visits.length,
    condition_occurrence: conditions.length,
    drug_exposure: drugs.length,
    measurement: measurements.length,
    procedure_occurrence: procedures.length,
    observation: observations.length,
  }
  const qualityWarnings = buildQualityWarnings(cases, mappingSummary)

  const dateRange = cases.length
    ? { from: cases[0].createdAt.toISOString(), to: cases[cases.length - 1].createdAt.toISOString() }
    : null

  return {
    metadata: {
      export_id:               crypto.randomUUID(),
      omop_cdm_version:        "5.4",
      generated_at:            new Date().toISOString(),
      generated_by_user_id:    ctx?.userId ?? "unknown",
      generated_by_role:       ctx?.userRole ?? "unknown",
      source:                  "LOSPOR",
      source_version:          "3.5.1",
      schema_version:          "3.4.3",
      concept_map_version:     "local-bilingual-map-v2",
      data_dictionary_version: DICTIONARY_VERSION,
      case_status_filter:      ctx?.statusFilter ?? [],
      date_range:              dateRange,
      included_case_count:     cases.length,
      excluded_case_count:     ctx?.excludedCaseCount ?? 0,
      app_git_commit:          ctx?.gitCommit ?? "untracked",
      forced_override:         ctx?.forcedOverride ?? false,
      case_count:              cases.length,
      mapping_summary:         mappingSummary,
      table_counts:            tableCounts,
      quality_warnings:        qualityWarnings,
      data_quality_status:     deriveQualityStatus(qualityWarnings),
      deidentification: {
        mode:                              "pseudonymised",
        person_id_strategy:               "deterministic 52-bit identifier derived from SHA-256 of the internal case ID (optionally salted) — not reversible without the source database. One person per case: no patient identifier is stored, so the same patient across two operations appears as two persons.",
        direct_patient_identifiers_stored: false,
        event_timestamp_precision:        "exact_datetime",
        residual_linkage_risks: [
          "exact intraoperative event timestamps (not rounded or shifted)",
          "case-level institution/care-site linkage",
          "rare procedure, complication, and timeline combinations",
        ],
      },
      note: "OMOP concept IDs are emitted only where LOSPOR has a confident local mapping. Source vocabulary, source code, English/Bulgarian labels, and source-only rows are preserved for research traceability. person_id is a deterministic pseudonym derived from SHA-256 of the internal case ID — no patient names, national IDs, or direct identifiers are stored. PERSON carries an approximate year_of_birth derived from age at operation (month and day are unknown, not defaulted); race and ethnicity are not collected and are emitted as concept 0. OBSERVATION_PERIOD spans the operation only. Intraoperative event timestamps are preserved at exact DateTime precision for clinical sequence analysis — see residual_linkage_risks.",
    },
    person:                persons,
    observation_period:    observationPeriods,
    visit_occurrence:      visits,
    condition_occurrence:  conditions,
    drug_exposure:         drugs,
    measurement:           measurements,
    procedure_occurrence:  procedures,
    observation:           observations,
  }
}
