/**
 * OMOP CDM v5.4 mapper — export contract `source_version` 3.8.0.
 *
 * `source_version` tracks the shape of the export, not the app version: bump it
 * whenever a table or column is added, removed or reinterpreted.
 *
 * 3.8.0 — the shape changes since 3.7.0, none of which had been released.
 *
 *         CARE_SITE is emitted as its own table and referenced by
 *         care_site_id, instead of the site being written onto
 *         VISIT_OCCURRENCE as a bare string.
 *
 *         Allergies stop being exported as DRUG_EXPOSURE. Medication.kind is
 *         CURRENT | ALLERGY, and the export iterated both, so a substance the
 *         patient reacts to was recorded as one they were given. Allergies now
 *         become observations, which is a different claim in the right place.
 *
 *         Continuous administrations gain drug_exposure_end_date, paired from
 *         their stop events. Every planned procedure is exported, not the
 *         first. Intraoperative drugs resolve their ATC through the same
 *         concept pipeline as relational medications.
 *
 *         Clinical yes/no questions emit for a recorded "no" as well as a
 *         "yes". They were nullable-free booleans, so silence was the only
 *         honest option; the columns are now nullable and silence means the
 *         question was never asked.
 *
 *         Airway management is exported: device list, Cormack-Lehane grade,
 *         tools, per-device sizes and cuff status, DLT type/side/size,
 *         endobronchial size, ventilation modes, IPPV, jet ventilation and
 *         PEEP. Placing an instrumented airway is also emitted as a
 *         PROCEDURE_OCCURRENCE, separating what was done to the patient from
 *         what was true of them.
 *
 *         Preop findings that were read out of the database and written to no
 *         table now leave: smoking, substance use, latex allergy, family
 *         anaesthesia history, dental state, cardiac arrhythmia, BMI, blood
 *         group and Rh, GUTA, the airway examination (mouth opening,
 *         thyromental distance, neck mobility, upper lip bite test,
 *         retrognathia, prominent incisors, facial hair), and the free-text
 *         allergy, family-history and difficult-airway notes, redacted.
 *
 *         MEASUREMENT gains value_source_value, range_low and range_high.
 *         A lab result with no parsed number used to be skipped entirely, so a
 *         culture, a dipstick or a blood group left no trace of having been
 *         recorded; it is now exported with the value the lab reported. The
 *         reference range travels with the result, because ranges differ by
 *         laboratory, assay and patient age, and "high" is not a claim the
 *         export can support without the range that produced it. The abnormal
 *         flag rides as its own observation, keyed to the measurement's source
 *         value, since CDM 5.4 has no column for it.
 *
 *         Vascular lines carry their depth, lumen count and whether they were
 *         already in place. A pre-existing line was not placed during this
 *         case, so its procedure row overstates the work without that flag.
 *
 *         mapping_summary gains manually_curated_rows and rejected_rows.
 *         MAPPED covered both an automatic resolution and one a human signed
 *         off, and UNMAPPED covered both "nobody has looked" and "a candidate
 *         was rejected" -- so the summary could not distinguish evidence from
 *         guesswork, or finished review work from a backlog.
 * 3.7.0 — OBSERVATION gains value_as_number, the CDM column a numeric
 *         observation belongs in. Every score the export carries (RCRI, Apfel,
 *         STOP-BANG, the Aldrete subscores and total, POVOC, COLDS, PAED, the
 *         paediatric pain scales, fluid totals, durations) was written only as
 *         text, so a researcher could not sum, average or threshold one without
 *         casting it back. The string form is kept alongside for values that
 *         are genuinely textual and for consumers already reading it.
 * 3.6.0 — preserves pediatric mode, precise age, rule provenance, pediatric
 *         risk scores, and pediatric recovery scores as source observations.
 *         No unreviewed standard concept IDs are assigned.
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
import { formatCanonicalConcentration } from "@/lib/case-event-schema"
import { deriveQualityStatus } from "@lospor/core/omop"

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _counter = 1
function nextId() { return _counter++ }
function resetIds(start = 1) { _counter = start }

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

/**
 * The act of placing each airway device, where placing it is a procedure.
 *
 * A device is a state of the patient; putting it there is something done to
 * them, and only the second belongs in a procedure count. Devices that are
 * applied rather than instrumented map to null: a face mask is held on a face,
 * and counting that as an airway procedure would inflate every such count.
 *
 * Exhaustive over `AIRWAY_DEVICES` in @lospor/core, and asserted so by test.
 * The list is seeded from that catalogue and can grow, and a device missing
 * from here would silently export no procedure at all -- the failure would be
 * an absence, which nothing else in the pipeline would notice.
 */
export const AIRWAY_ACTS: Record<string, string | null> = {
  FACE_MASK:          null,
  OPA:                null,
  NPA:                null,
  LMA:                "SUPRAGLOTTIC_AIRWAY_PLACEMENT",
  ORAL_ETT:           "TRACHEAL_INTUBATION_ORAL",
  NASAL_ETT:          "TRACHEAL_INTUBATION_NASAL",
  DOUBLE_LUMEN_TUBE:  "DOUBLE_LUMEN_TUBE_PLACEMENT",
  ENDOBRONCHIAL_TUBE: "ENDOBRONCHIAL_TUBE_PLACEMENT",
  SURGICAL_AIRWAY:    "SURGICAL_AIRWAY",
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
  // Height and weight are required before a case can reach the intraoperative
  // form, so every case has them — and until they were added here the export
  // silently dropped both, while the data dictionary documented them. Weight in
  // particular is how every dose on the chart was calculated; without it a
  // reviewer cannot check a dose or study dosing at all.
  heightCm:    { concept_id: 3036277, loinc: "8302-2",  unit: "cm" },
  weightKg:    { concept_id: 3025315, loinc: "29463-7", unit: "kg" },
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
    matching_case_count: number
    exported_case_count: number
    complete: boolean
    included_case_count: number
    excluded_case_count: number
    app_git_commit: string
    forced_override: boolean
    case_count: number
    mapping_summary: {
      mapped_rows: number
      /** Of mapped_rows, how many a human reviewed and signed off. */
      manually_curated_rows: number
      /** Candidates considered and rejected. Not part of the unmapped backlog. */
      rejected_rows: number
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
  // A dimension rather than a clinical event: one row per place, referenced by
  // VISIT_OCCURRENCE. The institution used to be written onto every visit as
  // free text, in a column no OHDSI tool reads.
  care_site: OmopCareSite[]
  person: OmopPerson[]
  observation_period: OmopObservationPeriod[]
  visit_occurrence: OmopVisit[]
  condition_occurrence: OmopCondition[]
  drug_exposure: OmopDrug[]
  measurement: OmopMeasurement[]
  procedure_occurrence: OmopProcedure[]
  observation: OmopObservation[]
}

export interface OmopCareSite {
  care_site_id: number
  care_site_name: string | null
  place_of_service_concept_id: number
  care_site_source_value: string | null
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
  care_site_id: number | null
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
  // Null means genuinely open — an administration still running when the case
  // ended — not "unknown". A single-shot drug has no interval and is null too.
  drug_exposure_end_date: string | null
  drug_type_concept_id: number
  drug_source_value: string | null
  // A concept id, per the CDM: an integer or nothing. Source vocabulary text
  // belongs in drug_source_value. This column held strings like "ATC:N01AH01",
  // which a loader must either reject or silently coerce away.
  drug_source_concept_id: number | null
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
  /** The value as the source reported it, including qualitative results. */
  value_source_value: string | null
  /** The reference range this result was judged against, where the lab gave one. */
  range_low: number | null
  range_high: number | null
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
  // OMOP puts a numeric observation in value_as_number and a textual one in
  // value_as_string. Everything used to go through value_as_string, which made
  // every score in the export a string: a researcher could not average an
  // Aldrete total or threshold an RCRI without casting it back, and the
  // dictionary documented 26 of them as living in a column the row did not
  // have. Numbers are now written to both — the number so it can be used as
  // one, the string so nothing already reading value_as_string breaks.
  value_as_number: number | null
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
  clinicalMode?: "ADULT" | "PEDIATRIC"
  clinicalRulesVersion?: string | null
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
    concentrationValue?: number | null
    concentrationUnit?: string | null
    formulation?: string | null
    calculationBasis?: string | null
    calculationWeightKg?: number | null
    calculationMethod?: string | null
    clinicalRuleKey?: string | null
    clinicalRuleVersion?: string | null
    clinicalRuleSourceIds?: unknown
    clinicalPresetId?: string | null
    clinicalPresetVersion?: number | null
    clinicalPresetScope?: string | null
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
    standardConceptId?: number | null
    mappingStatus?: string
    // Pairing keys: an infusion's start and stop share infId, a fluid's share
    // fluidId. Volatile agents have no key — only one runs at a time, so a stop
    // closes whichever is open, which is how the intraop engine reads them too.
    infId?: string | null
    fluidId?: string | null
    inn?: string | null
    drugRoute?: string | null
    metadataJson: unknown
  }[]
  selections?: {
    section: string
    category: string
    value: string
    ordinal: number
    sourceVocabulary?: string | null
    sourceCode?: string | null
    standardConceptId?: number | null
    mappingStatus?: string
  }[]
  complications?: {
    section: string
    label: string
    note: string | null
    timestamp: Date | null
    source: string | null
    ordinal: number
    sourceVocabulary?: string | null
    sourceCode?: string | null
    standardConceptId?: number | null
    mappingStatus?: string
  }[]
  preop?: {
    ageYears: number | null
    ageValue?: number | null
    ageUnit?: "DAYS" | "MONTHS" | "YEARS" | null
    ageApproxDays?: number | null
    bodySurfaceAreaM2?: number | null
    pediatricFasting?: unknown
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
    allergies: boolean | null
    allergyDetails: string | null
    smoking: boolean | null
    substanceAbuse: boolean | null
    currentMedications: string | null
    rcriScore: number | null
    apfelScore: number | null
    stopBangScore: number | null
    povocScore?: number | null
    povocRiskPercent?: number | null
    coldsScore?: number | null
    difficultAirwayHistory: boolean | null
    mallampati: string | null
    // Clinical detail the export used to read and discard.
    bmi?: number | null
    bloodType?: string | null
    rhFactor?: string | null
    gutaScore?: number | null
    latexAllergy?: boolean | null
    familyAnesthesiaProblems?: boolean | null
    familyAnesthesiaDetails?: string | null
    dentalProsthetics?: boolean | null
    looseTeeth?: boolean | null
    heartArrhythmia?: boolean | null
    mouthOpeningCm?: number | null
    thyromental?: number | null
    neckMobility?: string | null
    upperLipBiteTest?: string | null
    retrognathia?: boolean | null
    prominentIncisors?: boolean | null
    facialHair?: boolean | null
    difficultAirwayNotes?: string | null
    labResults: unknown
    labRows?: {
      test: string
      valueNum: number | null
      value: string | null
      unitCanon: string | null
      loincCode: string | null
      abnormalFlag: string | null
      referenceLow?: number | null
      referenceHigh?: number | null
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
    // Airway management detail. `airwayDevices` is the current multi-device
    // list; `airwayDevice` is the older single value and both may be set.
    airwayDevices?: unknown
    cormackLehane?: string | null
    airwayTools?: unknown
    fob?: boolean | null
    lmaSize?: number | null
    oralTubeSize?: number | null
    oralCuffed?: boolean | null
    nasalTubeSize?: number | null
    nasalCuffed?: boolean | null
    dltType?: string | null
    dltSide?: string | null
    dltSize?: number | null
    endobronchialSize?: number | null
    // Legacy shared size/cuff, written before the per-device columns existed.
    tubeSize?: number | null
    cuffed?: boolean | null
    ventilationModes?: unknown
    ippv?: boolean | null
    jetVentilation?: boolean | null
    peepCmH2O?: number | null
    vascularAccessRows?: {
      site: string | null
      siteLabel: string | null
      size: string | null
      sizeUnit: string | null
      depthCm: string | null
      lumens: string | null
      preexisting: boolean
      ordinal: number
      sourceVocabulary?: string | null
      sourceCode?: string | null
      standardConceptId?: number | null
      mappingStatus?: string
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
    pediatricPainScale?: "FLACC" | "FPS_R" | "NRS" | null
    pediatricPainScore?: number | null
    paedScore?: number | null
    ponv: boolean | null
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
  mappingSummary: { mapped_rows: number; manually_curated_rows: number; rejected_rows: number; source_only_rows: number; unmapped_rows: number },
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
  // Counted from the case alone, matching what the export actually writes as
  // the care site. Counting the author's institution here would report cases as
  // institution-linked whose exported care site is null.
  const institutionLinked = cases.filter(c => Boolean(c.institutionId)).length

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
  matchingCaseCount?: number
  complete?: boolean
  gitCommit: string
  forcedOverride: boolean
  exportId?: string
  generatedAt?: string
  rowIdStart?: number
}

export function mapCasesToOmop(cases: CaseRow[], ctx?: ExportContext): OmopBundle {
  resetIds(ctx?.rowIdStart ?? 1)

  // One row per distinct institution seen, keyed by the same pseudonym the
  // visits reference. Built as a map so a hundred cases at one hospital emit
  // one care site rather than a hundred.
  const careSites = new Map<number, OmopCareSite>()
  const persons: OmopPerson[] = []
  const observationPeriods: OmopObservationPeriod[] = []
  const visits: OmopVisit[] = []
  const conditions: OmopCondition[] = []
  const drugs: OmopDrug[] = []
  const measurements: OmopMeasurement[] = []
  const procedures: OmopProcedure[] = []
  const observations: OmopObservation[] = []
  const mappingSummary = { mapped_rows: 0, manually_curated_rows: 0, rejected_rows: 0, source_only_rows: 0, unmapped_rows: 0 }

  const trackMapping = (status: string | null | undefined) => {
    if (status === "MAPPED") mappingSummary.mapped_rows++
    // A mapping a human reviewed and signed off counts as mapped, because the
    // concept is applied either way, and is also counted on its own: an
    // automatic string match and a curated mapping are different levels of
    // evidence, and a summary that reports only "mapped" invites a reader to
    // trust a similarity score as if a clinician had checked it.
    else if (status === "MANUALLY_CURATED") { mappingSummary.mapped_rows++; mappingSummary.manually_curated_rows++ }
    // Rejected is not unmapped. Unmapped means nobody has looked; rejected
    // means someone looked and said no, and the export must not present the
    // two as the same backlog.
    else if (status === "REJECTED") mappingSummary.rejected_rows++
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

    // The case's own institution, stamped at creation and never updated,
    // because a case belongs to the institution it was performed at — see
    // access-control.ts, which scopes reads the same way.
    //
    // There is deliberately no fallback to the author's institution. That was
    // joined live at export time, so a case with no institution of its own was
    // attributed to wherever its author happened to work on the day of the
    // export, and could move hospital between two exports because a colleague
    // changed jobs. It also mixed two kinds of value in one column: an id from
    // the case, a name from the user. Unknown now stays unknown.
    const careSite = c.institutionId ?? null
    const careSiteId = careSite ? pseudonymId("caresite", careSite) : null
    if (careSite && careSiteId && !careSites.has(careSiteId)) {
      careSites.set(careSiteId, {
        care_site_id: careSiteId,
        // LOSPOR records the institution, not the department or theatre, so
        // there is no name beyond the source identifier and no reviewed
        // place-of-service concept to claim.
        care_site_name: null,
        place_of_service_concept_id: 0,
        care_site_source_value: careSite,
      })
    }

    // ── PERSON ───────────────────────────────────────────────────────────────
    // One person per case: LOSPOR deliberately stores no patient identifier, so
    // the same patient returning for a second operation cannot be recognised.
    // Documented as a research limitation, not an accident.
    // 8507/8532 are the OMOP standard gender concepts. OTHER and UNKNOWN both
    // fall through to 0 ("no matching concept"), but they mean different things
    // in the source data and are preserved verbatim in gender_source_value.
    const GENDER_CONCEPT: Record<string, number> = { MALE: 8507, FEMALE: 8532 }
    const ageAtOp = c.preop?.ageYears
      ?? (c.preop?.ageApproxDays != null ? Math.floor(c.preop.ageApproxDays / 365.2425) : null)
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
      // 9201 Inpatient Visit, and it is a description rather than a guess:
      // LOSPOR documents admitted surgical care only. The Disposition enum
      // carries the evidence — WARD, PACU, ICU, with no home-discharge value —
      // so a patient who went home the same day cannot be recorded here at all.
      //
      // This is therefore an assumption about the register's scope, not a fact
      // read off the case. If day surgery is ever recorded, this must stop being
      // a constant and derive from the setting: 9201 inpatient, 9202
      // outpatient, 581379 day surgery. Until then, exporting 0 would be worse
      // than exporting 9201 — it would hide every visit from the OHDSI tools
      // that filter on visit type, to avoid stating something that is true.
      visit_concept_id:      9201,
      visit_start_date:      startDate,
      visit_end_date:        endDate,
      visit_type_concept_id: 32817, // EHR
      visit_source_value:    c.caseCode,
      care_site_source_value: careSite,
      // The reference a CDM consumer reads. Null when the case records no
      // institution, which is a real state; the source value stays alongside.
      care_site_id: careSiteId,
    })

    const sourceObservation = (
      source: string,
      value: string | number | boolean | null | undefined,
      date = startDate,
      // Where the exported text is a formatted rendering of a number — a
      // concentration written "0.5%" — the number is passed in rather than
      // parsed back out of the string.
      numericValue?: number | null,
    ) => {
      if (value == null || value === "") return
      observations.push({
        observation_id: nextId(),
        person_id: personId,
        observation_concept_id: 0,
        observation_date: date,
        observation_type_concept_id: 32817,
        // A boolean is not a measurement, so it stays text only: "true" in
        // value_as_number would be indistinguishable from a score of 1.
        value_as_number: numericValue
          ?? (typeof value === "number" && Number.isFinite(value) ? value : null),
        value_as_string: String(value),
        observation_source_value: source,
        visit_occurrence_id: visitId,
      })
    }

    sourceObservation("LOSPOR:CLINICAL_MODE", c.clinicalMode ?? "ADULT")
    sourceObservation("LOSPOR:CLINICAL_RULES_VERSION", c.clinicalRulesVersion)

    const preop = c.preop

    // ── Preop vitals -> MEASUREMENT ───────────────────────────────────────────
    if (preop) {
      const vitDate = isoDate(c.createdAt)
      if (preop.ageValue != null && preop.ageUnit) {
        sourceObservation("LOSPOR:AGE_AT_PROCEDURE_EXACT", `${preop.ageValue} ${preop.ageUnit}`, vitDate)
      }
      sourceObservation("LOSPOR:AGE_AT_PROCEDURE_APPROX_DAYS", preop.ageApproxDays, vitDate)
      sourceObservation("LOSPOR:BODY_SURFACE_AREA_M2", preop.bodySurfaceAreaM2, vitDate)
      // Age is also folded into person.year_of_birth, but most analyses want it
      // directly rather than deriving it from a date.
      sourceObservation("LOSPOR:AGE_YEARS", preop.ageYears, vitDate)
      // Emergency also appears as the conventional "E" suffix on the ASA class
      // below; this is the same fact as a value a cohort can be filtered on.
      sourceObservation("LOSPOR:EMERGENCY_SURGERY", preop.emergencySurgery, vitDate)
      sourceObservation("LOSPOR:HIGH_RISK_SURGERY", preop.highRiskSurgery, vitDate)
      sourceObservation("LOSPOR:POVOC_SCORE", preop.povocScore, vitDate)
      sourceObservation("LOSPOR:POVOC_RISK_PERCENT", preop.povocRiskPercent, vitDate)
      sourceObservation("LOSPOR:COLDS_SCORE", preop.coldsScore, vitDate)
      sourceObservation(
        "LOSPOR:PEDIATRIC_FASTING_ASSESSMENT",
        preop.pediatricFasting == null ? null : JSON.stringify(preop.pediatricFasting),
        vitDate,
      )
      const vitalMap: [keyof typeof VITAL_CONCEPTS, number | null | undefined][] = [
        ["systolic",        preop.bpSystolic],
        ["diastolic",       preop.bpDiastolic],
        ["heartRate",       preop.heartRate],
        ["spO2",            preop.spO2],
        ["temp",            preop.temperature],
        ["respiratoryRate", preop.respiratoryRate],
        ["heightCm",         preop.heightCm],
        ["weightKg",         preop.weightKg],
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
          // Vitals carry no source text and no laboratory reference range.
          value_source_value:        null,
          range_low:                 null,
          range_high:                null,
          visit_occurrence_id:       visitId,
        })
      }

      // ── Lab results from LabResult rows -> MEASUREMENT ────────────────────
      // Use SQL LabResult rows (LOINC-coded) instead of raw JSON
      const labRows = preop.labRows ?? []
      for (const lab of labRows) {
        // A result with neither a number nor text is not a result. Anything
        // else is exported: this used to skip every row without a parsed
        // number, so a qualitative result -- a blood group, a culture, a
        // dipstick -- was dropped with no trace that it had been recorded.
        if (lab.valueNum == null && !lab.value) continue
        trackMapping(lab.mappingStatus)
        const labSource = lab.loincCode ? `LOINC:${lab.loincCode}` : `LAB:${lab.test}`
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
          measurement_source_value:    labSource,
          // The value as the lab reported it. For a numeric result this is the
          // unparsed original; for a qualitative one it is the only value there
          // is.
          value_source_value:          lab.value ?? null,
          // The range this result was judged against. Reference ranges differ
          // by laboratory, assay and patient age, so "high" is not a claim the
          // export can support without carrying the range that produced it.
          range_low:                   lab.referenceLow ?? null,
          range_high:                  lab.referenceHigh ?? null,
          visit_occurrence_id:         visitId,
        })
        // CDM 5.4 has no abnormal-flag column, and value_as_concept_id would
        // need a standard concept this export does not assign. The flag is
        // LOSPOR's own judgement, so it is carried as its own observation,
        // keyed by the same source value the measurement row uses.
        if (lab.abnormalFlag) {
          sourceObservation("LOSPOR:LAB_ABNORMAL_FLAG", `${labSource}=${lab.abnormalFlag}`, vitDate)
        }
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
      const preopDate = isoDate(c.createdAt)
      if (preop.asaScore) {
        observations.push({
          observation_id:           nextId(),
          person_id:                personId,
          observation_concept_id:   4173987, // ASA Physical Status concept
          observation_date:         preopDate,
          observation_type_concept_id: 32817,
          // A Roman numeral, optionally suffixed "E" — a class, not a quantity.
          value_as_number:          null,
          value_as_string:          preop.asaScore + (preop.emergencySurgery ? "E" : ""),
          observation_source_value: "LOSPOR:ASA_CLASS",
          visit_occurrence_id:      visitId,
        })
      }
      // The risk scores are counts of risk factors: they are summed, banded and
      // thresholded, so they belong in value_as_number.
      sourceObservation("LOSPOR:RCRI", preop.rcriScore, preopDate)
      sourceObservation("LOSPOR:APFEL", preop.apfelScore, preopDate)
      sourceObservation("LOSPOR:STOP_BANG", preop.stopBangScore, preopDate)
      // Recorded for yes and for no, but not when nobody asked.
      //
      // This used to emit only on true, and that was right at the time: the
      // column was Boolean @default(false), so a false meant "either answered
      // no, or never touched" and exporting it would have asserted "no
      // difficult airway history" for every patient nobody had asked. Silence
      // was the honest option when the schema could not tell them apart.
      //
      // The column is now nullable, so false is an answer and null is the
      // absence of one. sourceObservation already skips null and writes false,
      // so an answered "no" finally reaches the export as a finding rather than
      // being rounded off to silence.
      sourceObservation("LOSPOR:DIFFICULT_AIRWAY_HISTORY", preop.difficultAirwayHistory, preopDate)
      sourceObservation("LOSPOR:MALLAMPATI", preop.mallampati, preopDate)

      // ── Preop findings that used to be read and discarded ────────────────
      //
      // All of this was selected out of the database, carried through the
      // mapper's row types, and written to no table. Smoking status is the
      // plainest example: a register exists partly to study it, and it left
      // the appliance nowhere at all.
      //
      // Everything below follows the same rule as the airway history above --
      // an answered "no" is a finding and reaches the export, and only an
      // unasked question stays silent.
      sourceObservation("LOSPOR:SMOKING", preop.smoking, preopDate)
      sourceObservation("LOSPOR:SUBSTANCE_ABUSE", preop.substanceAbuse, preopDate)
      sourceObservation("LOSPOR:LATEX_ALLERGY", preop.latexAllergy, preopDate)
      sourceObservation("LOSPOR:FAMILY_ANAESTHESIA_PROBLEMS", preop.familyAnesthesiaProblems, preopDate)
      sourceObservation("LOSPOR:FAMILY_ANAESTHESIA_DETAILS", preop.familyAnesthesiaDetails, preopDate)
      sourceObservation("LOSPOR:DENTAL_PROSTHETICS", preop.dentalProsthetics, preopDate)
      sourceObservation("LOSPOR:LOOSE_TEETH", preop.looseTeeth, preopDate)
      sourceObservation("LOSPOR:HEART_ARRHYTHMIA", preop.heartArrhythmia, preopDate)

      // The allergy flag already reaches DRUG_ALLERGY observations per
      // substance, but the free-text detail carries allergens that were never
      // resolved to a drug -- redacted upstream like every other note.
      sourceObservation("LOSPOR:ALLERGY_DETAILS", preop.allergyDetails, preopDate)

      // Body mass index is stored, not derived at export time, because the
      // height and weight it was computed from may since have been corrected.
      sourceObservation("LOSPOR:BMI", preop.bmi, preopDate)
      sourceObservation("LOSPOR:BLOOD_TYPE", preop.bloodType, preopDate)
      sourceObservation("LOSPOR:RH_FACTOR", preop.rhFactor, preopDate)
      sourceObservation("LOSPOR:GUTA_SCORE", preop.gutaScore, preopDate)

      // ── The airway examination ───────────────────────────────────────────
      //
      // Distinct from the difficult-airway history: this is what the
      // anaesthetist found on examining this patient, and it is what a
      // predictive study needs alongside the Cormack-Lehane grade the intraop
      // record now carries.
      sourceObservation("LOSPOR:MOUTH_OPENING_CM", preop.mouthOpeningCm, preopDate)
      sourceObservation("LOSPOR:THYROMENTAL_DISTANCE_CM", preop.thyromental, preopDate)
      sourceObservation("LOSPOR:NECK_MOBILITY", preop.neckMobility, preopDate)
      sourceObservation("LOSPOR:UPPER_LIP_BITE_TEST", preop.upperLipBiteTest, preopDate)
      sourceObservation("LOSPOR:RETROGNATHIA", preop.retrognathia, preopDate)
      sourceObservation("LOSPOR:PROMINENT_INCISORS", preop.prominentIncisors, preopDate)
      sourceObservation("LOSPOR:FACIAL_HAIR", preop.facialHair, preopDate)
      sourceObservation("LOSPOR:DIFFICULT_AIRWAY_NOTES", preop.difficultAirwayNotes, preopDate)
    }

    // ── Planned procedure -> PROCEDURE_OCCURRENCE ─────────────────────────────
    // Every planned procedure, not just the first. This read procedureRows[0]
    // and discarded the rest silently: a case with two planned procedures
    // exported one, with nothing to show the others had been dropped. A
    // combined operation therefore appeared in the register as a lesser one.
    //
    // The unstructured plannedProcedure text is the fallback for cases recorded
    // before procedure rows existed, and only when there are no rows at all.
    const procedureRows = preop?.procedureRows ?? []
    if (procedureRows.length > 0) {
      for (const row of procedureRows) {
        trackMapping(row.mappingStatus)
        procedures.push({
          procedure_occurrence_id:    nextId(),
          person_id:                 personId,
          procedure_concept_id:      row.standardConceptId ?? 0,
          procedure_date:            startDate,
          procedure_type_concept_id: 32817,
          procedure_source_value:    sourceValue("PROCEDURE", row.sourceVocabulary, row.sourceCode, row.group ?? row.description),
          visit_occurrence_id:       visitId,
        })
      }
    } else if (preop?.plannedProcedure) {
      procedures.push({
        procedure_occurrence_id:    nextId(),
        person_id:                 personId,
        procedure_concept_id:      0,
        procedure_date:            startDate,
        procedure_type_concept_id: 32817,
        procedure_source_value:    preop.plannedProcedure,
        visit_occurrence_id:       visitId,
      })
    }

    // ── Intraop techniques -> PROCEDURE_OCCURRENCE ────────────────────────────
    for (const med of preop?.medications ?? []) {
      trackMapping(med.mappingStatus)
      // Medication.kind is CURRENT | ALLERGY, and they are opposite claims: one
      // says the patient takes this drug, the other says they must never be
      // given it. Both used to become DRUG_EXPOSURE, which asserts
      // administration — so an allergy was exported as a dose, in the dangerous
      // direction, and no downstream query could tell it apart from a real one.
      //
      // The allergy is not dropped. It becomes an observation carrying the
      // substance, because "no allergy recorded" and "allergy lost on export"
      // must not look identical to a researcher.
      if (med.kind === "ALLERGY") {
        sourceObservation(
          "LOSPOR:DRUG_ALLERGY",
          sourceValue("MEDICATION", med.sourceVocabulary, med.sourceCode, med.nameRaw),
          isoDate(c.createdAt),
        )
        continue
      }
      const dose = med.dose ? parseFloat(med.dose) || null : null
      drugs.push({
        drug_exposure_id: nextId(),
        person_id: personId,
        drug_concept_id: med.standardConceptId ?? 0,
        drug_exposure_start_date: isoDate(c.createdAt),
        // A single administration, not an interval: no end to record.
        drug_exposure_end_date: null,
        drug_type_concept_id: 32817,
        drug_source_value: sourceValue("MEDICATION", med.sourceVocabulary, med.sourceCode, med.nameRaw),
        // The ATC/INN text is already carried by drug_source_value above. No
        // OMOP *source* concept is resolved for it today, so this stays null
        // rather than being filled with something that is not a concept id.
        drug_source_concept_id: null,
        dose_value: dose,
        dose_unit_source_value: med.dose,
        route_source_value: med.route,
        visit_occurrence_id: visitId,
      })
    }

    if (c.intraop) {
      sourceObservation("LOSPOR:ANAESTHESIA_DURATION_MIN", c.intraop.durationMinutes)

      // ── Airway management ────────────────────────────────────────────────
      //
      // The device, its size and the laryngoscopic view are states of the
      // patient during the case, so they are OBSERVATIONs. Placing the device
      // is an act performed on the patient, so it is a PROCEDURE_OCCURRENCE.
      // Exporting only the first conflates the two: "an endotracheal tube was
      // present" and "this patient was intubated" are different claims, and
      // only the second belongs in a procedure count.
      //
      // Until this, none of the detail left at all. An export could say a tube
      // was placed but not which, what size, whether it was cuffed, or how
      // difficult the view was -- which is the whole substance of a
      // difficult-airway study.
      const ia = c.intraop
      const strList = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []

      // airwayDevice is the older single column; airwayDevices is the current
      // list. Both may be populated, so they are merged and de-duplicated
      // rather than one being preferred and the other silently dropped.
      const devices = [...new Set([...(ia.airwayDevice ? [ia.airwayDevice] : []), ...strList(ia.airwayDevices)])]
      for (const device of devices) sourceObservation("LOSPOR:AIRWAY_DEVICE", device)

      sourceObservation("LOSPOR:CORMACK_LEHANE", ia.cormackLehane)
      for (const tool of strList(ia.airwayTools)) sourceObservation("LOSPOR:AIRWAY_TOOL", tool)
      sourceObservation("LOSPOR:FIBREOPTIC_BRONCHOSCOPY", ia.fob)

      // Sizes are recorded per device. The legacy tubeSize/cuffed pair is the
      // only size older rows carry, so it is exported under its own code
      // rather than being guessed onto one of the per-device ones.
      sourceObservation("LOSPOR:LMA_SIZE", ia.lmaSize)
      sourceObservation("LOSPOR:ORAL_TUBE_SIZE", ia.oralTubeSize)
      sourceObservation("LOSPOR:ORAL_TUBE_CUFFED", ia.oralCuffed)
      sourceObservation("LOSPOR:NASAL_TUBE_SIZE", ia.nasalTubeSize)
      sourceObservation("LOSPOR:NASAL_TUBE_CUFFED", ia.nasalCuffed)
      sourceObservation("LOSPOR:DLT_TYPE", ia.dltType)
      sourceObservation("LOSPOR:DLT_SIDE", ia.dltSide)
      sourceObservation("LOSPOR:DLT_SIZE", ia.dltSize)
      sourceObservation("LOSPOR:ENDOBRONCHIAL_TUBE_SIZE", ia.endobronchialSize)
      sourceObservation("LOSPOR:TUBE_SIZE_LEGACY", ia.tubeSize)
      sourceObservation("LOSPOR:TUBE_CUFFED_LEGACY", ia.cuffed)

      // ── Ventilation ──────────────────────────────────────────────────────
      for (const mode of strList(ia.ventilationModes)) sourceObservation("LOSPOR:VENTILATION_MODE", mode)
      sourceObservation("LOSPOR:IPPV", ia.ippv)
      sourceObservation("LOSPOR:JET_VENTILATION", ia.jetVentilation)
      sourceObservation("LOSPOR:PEEP_CMH2O", ia.peepCmH2O)

      // ── Airway acts -> PROCEDURE_OCCURRENCE ──────────────────────────────
      //
      // Derived from the devices actually recorded, so a case documents the
      // intubation it performed and not the one it might have. Devices with no
      // corresponding act -- a face mask, a nasal cannula -- produce no
      // procedure, which is correct: nothing was placed.
      for (const device of devices) {
        const act = AIRWAY_ACTS[device]
        if (!act) continue
        procedures.push({
          procedure_occurrence_id:   nextId(),
          person_id:                 personId,
          procedure_concept_id:      0,
          procedure_date:            startDate,
          procedure_type_concept_id: 32817,
          procedure_source_value:    `AIRWAY_MANAGEMENT:${act}`,
          visit_occurrence_id:       visitId,
        })
      }

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

      // When each continuous administration stopped.
      //
      // infusion_stop and agent_stop used to be skipped entirely, so every
      // infusion and every volatile exported with a start and no end — which in
      // the CDM reads as "still running". Duration, the quantity most
      // anaesthetic research is built on, could not be derived at all.
      //
      // Infusions pair by infId. Volatiles have no key because only one runs at
      // a time, so a stop closes whichever is currently open; that is exactly
      // how the intraop engine reads the same events. An administration with no
      // stop stays open, because still running when the case ended is a real
      // state and inventing an end would manufacture a duration nobody recorded.
      const ordered = [...drugEvents].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
      const infusionEnd = new Map<string, Date>()
      const agentEnd = new Map<number, Date>()
      let openAgentIndex: number | null = null
      ordered.forEach((ev, index) => {
        if (ev.type === "infusion_stop" && ev.infId) infusionEnd.set(ev.infId, ev.timestamp)
        if (ev.type === "agent_start") openAgentIndex = index
        if (ev.type === "agent_stop" && openAgentIndex != null) {
          agentEnd.set(openAgentIndex, ev.timestamp)
          openAgentIndex = null
        }
      })
      const endFor = (ev: typeof drugEvents[number], index: number): string | null => {
        if (ev.type === "infusion_start") return ev.infId ? isoDate(infusionEnd.get(ev.infId)) : null
        if (ev.type === "agent_start") return isoDate(agentEnd.get(index))
        return null
      }

      for (const [index, ev] of ordered.entries()) {
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
              // Vitals carry no source text and no laboratory reference range.
              value_source_value:        null,
              range_low:                 null,
              range_high:                null,
              visit_occurrence_id:       visitId,
            })
          }
        }
        if (ev.type === "agent_start" && ev.agentPercent != null) {
          sourceObservation("LOSPOR:VOLATILE_AGENT_PERCENT", ev.agentPercent, isoDate(ev.timestamp))
        }
        if (ev.type === "gas_start" || ev.type === "gas_change") {
          const gasValues: [string, number | null | undefined, string][] = [
            ["LOSPOR:FGF_L_PER_MIN", ev.fgfLitersPerMin, "L/min"],
            ["LOINC:3150-0", ev.fio2Percent, "%"],
            ["LOSPOR:FIAIR_PERCENT", ev.fiAirPercent, "%"],
            ["LOSPOR:FIN2O_PERCENT", ev.fiN2OPercent, "%"],
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
              // Vitals carry no source text and no laboratory reference range.
              value_source_value:        null,
              range_low:                 null,
              range_high:                null,
              visit_occurrence_id: visitId,
            })
          }
          sourceObservation("LOSPOR:CARRIER_GAS", ev.carrierGas, isoDate(ev.timestamp))
        }
        // fluid_start joins the administration types: the volume and category
        // were selected from the database and then discarded, leaving only case
        // totals, so when a litre went in was unanswerable — the question in any
        // resuscitation study. Totals are still emitted, as a derived summary.
        if (ev.type !== "drug" && ev.type !== "agent_start"
          && ev.type !== "infusion_start" && ev.type !== "fluid_start") continue
        const meta = (ev.metadataJson ?? {}) as Record<string, unknown>
        const doseSource = ev.type === "infusion_start" ? ev.rate
          : ev.type === "fluid_start" ? ev.volume
            : meta.dose
        const dose = doseSource != null ? parseFloat(String(doseSource)) || null : null
        drugs.push({
          drug_exposure_id:           nextId(),
          person_id:                  personId,
          // The concept resolved when the event was written. It used to be
          // hardcoded 0, so every drug given during a case exported as unmapped
          // while its ATC sat in the row unused — and the same drug listed
          // preoperatively exported mapped.
          drug_concept_id:            ev.standardConceptId ?? 0,
          drug_exposure_start_date:   isoDate(ev.timestamp),
          drug_exposure_end_date:     endFor(ev, index),
          drug_type_concept_id:       32817,
          // The ATC moves into the source value, where source codes belong. It
          // was previously the only place the code appeared, so dropping it
          // from the concept id column without doing this would lose the one
          // identifier an unmapped intraoperative drug still had.
          drug_source_value:          ev.atcCode
            ? `ATC:${ev.atcCode} - ${(meta.name as string | undefined) ?? ev.label ?? ""}`.trimEnd()
            : (meta.name as string | undefined) ?? ev.label ?? null,
          drug_source_concept_id:     null,
          dose_value:                 dose,
          dose_unit_source_value:     ev.unit ?? (meta.unit as string | undefined) ?? (ev.type === "agent_start" ? "%" : null),
          route_source_value:         ev.drugRoute ?? (meta.drugRoute as string | undefined) ?? (ev.type === "agent_start" ? "INHALATIONAL" : "IV"),
          visit_occurrence_id:        visitId,
        })
        if (ev.type === "drug") {
          const concentration = ev.concentration
            ?? formatCanonicalConcentration(ev.concentrationValue, ev.concentrationUnit)
          // Third element is the numeric form where the text is a rendering of
          // a number: "0.5%" is a concentration of 0.5, and a preset version is
          // an ordinal a researcher may want to compare rather than match.
          const auditObservations: Array<[string, string | null | undefined, number | null]> = [
            ["LOSPOR:DRUG_CONCENTRATION", concentration, ev.concentrationValue ?? null],
            ["LOSPOR:DRUG_FORMULATION", ev.formulation, null],
            ["LOSPOR:DOSE_CALCULATION_BASIS", ev.calculationBasis, null],
            ["LOSPOR:DOSE_CALCULATION_METHOD", ev.calculationMethod, null],
            ["LOSPOR:CLINICAL_RULE_KEY", ev.clinicalRuleKey, null],
            ["LOSPOR:CLINICAL_RULE_VERSION", ev.clinicalRuleVersion, null],
            ["LOSPOR:CLINICAL_PRESET_ID", ev.clinicalPresetId, null],
            [
              "LOSPOR:CLINICAL_PRESET_VERSION",
              ev.clinicalPresetVersion == null ? null : String(ev.clinicalPresetVersion),
              ev.clinicalPresetVersion ?? null,
            ],
            ["LOSPOR:CLINICAL_PRESET_SCOPE", ev.clinicalPresetScope, null],
            [
              "LOSPOR:CLINICAL_RULE_SOURCE_IDS",
              Array.isArray(ev.clinicalRuleSourceIds)
                ? ev.clinicalRuleSourceIds.filter(value => typeof value === "string").join("|")
                : null,
              null,
            ],
          ]
          for (const [source, value, numericValue] of auditObservations) {
            if (!value) continue
            sourceObservation(source, value, isoDate(ev.timestamp), numericValue)
          }
          if (ev.calculationWeightKg != null) {
            measurements.push({
              measurement_id: nextId(),
              person_id: personId,
              measurement_concept_id: 0,
              measurement_date: isoDate(ev.timestamp),
              measurement_datetime: ev.timestamp.toISOString(),
              measurement_type_concept_id: 32817,
              value_as_number: ev.calculationWeightKg,
              unit_concept_id: 0,
              unit_source_value: "kg",
              measurement_source_value: "LOSPOR:DOSE_CALCULATION_WEIGHT_KG",
              // Vitals carry no source text and no laboratory reference range.
              value_source_value:        null,
              range_low:                 null,
              range_high:                null,
              visit_occurrence_id: visitId,
            })
          }
        }
      }

      for (const prem of c.intraop.premedicationRows ?? []) {
        trackMapping(prem.mappingStatus)
        const dose = prem.dose ? parseFloat(prem.dose) || null : null
        drugs.push({
          drug_exposure_id: nextId(), person_id: personId,
          drug_concept_id: prem.standardConceptId ?? 0,
          drug_exposure_start_date: startDate,
          // A single administration, not an interval: no end to record.
          drug_exposure_end_date: null,
          drug_type_concept_id: 32817,
          // Same correction as the other two drug sites: the ATC is source text
          // and belongs in the source value, not in a numeric concept column.
          // Only prefixed when there is a code to carry, so rows without one
          // read exactly as they did before.
          drug_source_value: prem.atcCode ? `ATC:${prem.atcCode} - ${prem.nameRaw}` : prem.nameRaw,
          drug_source_concept_id: null,
          dose_value: dose,
          dose_unit_source_value: prem.dose,
          route_source_value: prem.route,
          visit_occurrence_id: visitId,
        })
        sourceObservation("LOSPOR:PREMEDICATION_PHASE", prem.phase, startDate)
      }

      for (const line of c.intraop.vascularAccessRows ?? []) {
        procedures.push({
          procedure_occurrence_id: nextId(), person_id: personId,
          procedure_concept_id: line.standardConceptId ?? 0,
          procedure_date: startDate,
          procedure_type_concept_id: 32817,
          procedure_source_value: `VASCULAR_ACCESS:${line.siteLabel ?? line.site ?? "unknown"}${line.size ? ` ${line.size}${line.sizeUnit ?? ""}` : ""}`,
          visit_occurrence_id: visitId,
        })
        // Depth, lumen count and whether the line was already there were
        // selected and discarded. The last one matters most: a pre-existing
        // line was not placed during this case, so counting it as a procedure
        // performed here overstates what the anaesthetist did.
        const lineKey = line.siteLabel ?? line.site ?? "unknown"
        if (line.depthCm) sourceObservation("LOSPOR:VASCULAR_ACCESS_DEPTH_CM", `${lineKey}=${line.depthCm}`, startDate, Number(line.depthCm))
        if (line.lumens) sourceObservation("LOSPOR:VASCULAR_ACCESS_LUMENS", `${lineKey}=${line.lumens}`, startDate, Number(line.lumens))
        sourceObservation("LOSPOR:VASCULAR_ACCESS_PREEXISTING", `${lineKey}=${line.preexisting}`, startDate)
      }

      // Fluid totals as observations. Millilitres given: a quantity, and one
      // that is routinely summed across a cohort.
      sourceObservation("LOSPOR:CRYSTALLOIDS_ML", c.intraop.crystalloidsMl, endDate)
      sourceObservation("LOSPOR:COLLOIDS_ML", c.intraop.colloidsMl, endDate)
      sourceObservation("LOSPOR:BLOOD_PRODUCTS_ML", c.intraop.bloodMl, endDate)
      sourceObservation("LOSPOR:URINE_OUTPUT_ML", c.intraop.urineMl, endDate)
    }

    for (const sel of c.selections ?? []) {
      // A selected option from the institution's option library — a label, not
      // a quantity, even when the label happens to read as a number.
      observations.push({
        observation_id: nextId(), person_id: personId,
        // The option library's reviewed concept when there is one. CaseSelection
        // has carried standardConceptId all along; the export simply never
        // asked for it, so a mapped monitoring line still claimed to map to
        // nothing.
        observation_concept_id: sel.standardConceptId ?? 0,
        observation_date: startDate,
        observation_type_concept_id: 32817,
        value_as_number: null,
        value_as_string: sel.value,
        observation_source_value: `LOSPOR:${sel.section.toUpperCase()}_${sel.category.toUpperCase()}`,
        visit_occurrence_id: visitId,
      })
    }

    for (const comp of c.complications ?? []) {
      observations.push({
        observation_id: nextId(), person_id: personId,
        observation_concept_id: comp.standardConceptId ?? 0,
        observation_date: isoDate(comp.timestamp) ?? (comp.section === "postop" ? endDate : startDate),
        observation_type_concept_id: 32817,
        value_as_number: null,
        value_as_string: comp.note ? `${comp.label}; ${comp.note}` : comp.label,
        observation_source_value: `LOSPOR:${comp.section.toUpperCase()}_COMPLICATION`,
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
        measurements.push({ measurement_id: nextId(), person_id: personId, measurement_concept_id: cfg.concept_id, measurement_date: postDate, measurement_datetime: postDate, measurement_type_concept_id: 32817, value_as_number: val, unit_concept_id: 0, unit_source_value: cfg.unit, measurement_source_value: `POSTOP_LOINC:${cfg.loinc}`, value_source_value: null, range_low: null, range_high: null, visit_occurrence_id: visitId })
      }
      // Aldrete subscores and their total: 0-2 each, 0-10 summed. A discharge
      // threshold is a numeric comparison, so these have to be numbers.
      sourceObservation("LOSPOR:ALDRETE_ACTIVITY", c.postop.aldreteActivity, postDate)
      sourceObservation("LOSPOR:ALDRETE_RESPIRATION", c.postop.aldreteRespiration, postDate)
      sourceObservation("LOSPOR:ALDRETE_CIRCULATION", c.postop.aldreteCirculation, postDate)
      sourceObservation("LOSPOR:ALDRETE_CONSCIOUSNESS", c.postop.aldreteConsciousness, postDate)
      sourceObservation("LOSPOR:ALDRETE_SPO2", c.postop.aldreteSpO2, postDate)
      sourceObservation("LOSPOR:ALDRETE_TOTAL", c.postop.aldreteTotal, postDate)
      if (c.postop.pediatricPainScore != null && c.postop.pediatricPainScale) {
        sourceObservation(`LOSPOR:PEDIATRIC_PAIN_${c.postop.pediatricPainScale}_0_10`, c.postop.pediatricPainScore, postDate)
      } else if (c.postop.painScoreNRS != null) {
        observations.push({
          observation_id: nextId(), person_id: personId,
          // Was 3020891 — the standard concept for body temperature, copied
          // from the vital map. A pain score loaded under that concept would
          // have appeared in any OHDSI temperature query as a value of 2 or 3.
          // LOSPOR has no reviewed mapping for the NRS pain concept, so this
          // follows the file's rule: emit 0 and carry the source LOINC code.
          observation_concept_id: 0,
          observation_date: postDate,
          observation_type_concept_id: 32817,
          value_as_number: c.postop.painScoreNRS,
          value_as_string: String(c.postop.painScoreNRS),
          observation_source_value: "LOINC:72514-3",
          visit_occurrence_id: visitId,
        })
      }
      sourceObservation("LOSPOR:PAED_SCORE", c.postop.paedScore, postDate)
      // Recorded only when present, and as a fact rather than a count.
      if (c.postop.ponv) sourceObservation("LOSPOR:PONV", true, postDate)
      sourceObservation("LOSPOR:DISPOSITION", c.postop.disposition, postDate)
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

  const caseDates = cases.map(row => row.createdAt.getTime())
  const dateRange = cases.length
    ? { from: new Date(Math.min(...caseDates)).toISOString(), to: new Date(Math.max(...caseDates)).toISOString() }
    : null

  return {
    metadata: {
      export_id:               ctx?.exportId ?? crypto.randomUUID(),
      omop_cdm_version:        "5.4",
      generated_at:            ctx?.generatedAt ?? new Date().toISOString(),
      generated_by_user_id:    ctx?.userId ?? "unknown",
      generated_by_role:       ctx?.userRole ?? "unknown",
      source:                  "LOSPOR",
      source_version:          "3.8.0",
      schema_version:          "3.6.0",
      concept_map_version:     "local-bilingual-map-v2",
      data_dictionary_version: DICTIONARY_VERSION,
      case_status_filter:      ctx?.statusFilter ?? [],
      date_range:              dateRange,
      matching_case_count:     ctx?.matchingCaseCount ?? cases.length,
      exported_case_count:     cases.length,
      complete:                ctx?.complete ?? true,
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
      note: "Numeric observations carry their value in observation.value_as_number and, unchanged, as text in observation.value_as_string; genuinely textual observations populate value_as_string only. OMOP concept IDs are emitted only where LOSPOR has a confident local mapping. Source vocabulary, source code, English/Bulgarian labels, and source-only rows are preserved for research traceability. Pediatric mode, precise age at procedure, rule provenance, pediatric risk scores, and recovery scores are preserved as source observations with concept_id 0 until reviewed mappings exist. person_id is a deterministic pseudonym derived from SHA-256 of the internal case ID — no patient names, national IDs, or direct identifiers are stored. PERSON carries an approximate year_of_birth derived from age at operation (month and day are unknown, not defaulted); race and ethnicity are not collected and are emitted as concept 0. OBSERVATION_PERIOD spans the operation only. Intraoperative event timestamps are preserved at exact DateTime precision for clinical sequence analysis — see residual_linkage_risks.",
    },
    care_site:             [...careSites.values()],
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
