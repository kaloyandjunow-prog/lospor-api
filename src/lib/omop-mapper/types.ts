/**
 * OMOP export shapes, split out of omop-mapper.ts: the bundle the mapper
 * produces, its per-table row shapes, the case shape it reads, and the
 * export-run context passed in from the caller. Grouped together because
 * they change as a set -- adding a column means touching the row type here
 * and the bundle's table array, together.
 */

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
  device_exposure: OmopDevice[]
  observation: OmopObservation[]
}

/**
 * A device placed in the patient.
 *
 * The airway devices had exact Device-domain concepts and nowhere to put them:
 * this export produced nine tables and none of them was the one the CDM
 * reserves for exactly this. Emitting an endotracheal tube as an observation
 * would have put a Device-domain concept in an Observation column, which is
 * the violation the OHDSI data-quality checks exist to catch, so they stayed
 * at concept 0 instead -- correct, and useless to anyone searching for them.
 *
 * Separate from the airway *act* in PROCEDURE_OCCURRENCE, which is deliberate
 * and not duplication: placing a tube is something done to the patient, and
 * the tube itself is a thing that was in them. A cohort of "patients
 * intubated" wants the procedure; a cohort of "cases where a videolaryngoscope
 * was used" wants the device.
 */
export interface OmopDevice {
  device_exposure_id: number
  person_id: number
  device_concept_id: number
  device_exposure_start_date: string | null
  device_exposure_end_date: string | null
  device_type_concept_id: number
  device_source_value: string | null
  visit_occurrence_id: number
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

export interface OmopVisit {
  visit_occurrence_id: number
  person_id: number
  visit_concept_id: number
  visit_start_date: string | null
  visit_start_datetime: string | null
  visit_end_date: string | null
  visit_end_datetime: string | null
  visit_type_concept_id: number
  visit_source_value: string | null
  care_site_id: number | null
  care_site_source_value: string | null
}

export interface OmopCondition {
  condition_occurrence_id: number
  person_id: number
  condition_concept_id: number
  condition_start_date: string | null
  condition_type_concept_id: number
  condition_source_value: string | null
  visit_occurrence_id: number
}

export interface OmopDrug {
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

export interface OmopMeasurement {
  measurement_id: number
  person_id: number
  measurement_concept_id: number
  measurement_date: string | null
  measurement_datetime: string | null
  measurement_type_concept_id: number
  value_as_number: number | null
  /**
   * The coded answer, for results that are not a quantity: a graded scale, or
   * a measurement that was attempted and could not be obtained. Null whenever
   * value_as_number carries the result instead.
   */
  value_as_concept_id: number | null
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

export interface OmopProcedure {
  procedure_occurrence_id: number
  person_id: number
  procedure_concept_id: number
  procedure_date: string | null
  // Optional: most procedures here are known only to the day (the case's own
  // start date). A few are also witnessed as a precise intraop timeline
  // event -- when one exists, it refines this row's time rather than adding
  // a second, duplicate row for the same procedure.
  procedure_datetime?: string | null
  procedure_type_concept_id: number
  /**
   * A qualifier on the operation, not a second operation.
   *
   * Urgency is the case this exists for. "Emergency procedure" (4158569) is the
   * closest concept to what the form asks, but emitted as its own
   * procedure_occurrence row it would make one appendectomy count as two
   * procedures and put an extra hit into any cohort defined over a procedure
   * concept set. The CDM's answer is this column: the operation stays one row,
   * and how it was performed hangs off it.
   */
  modifier_concept_id: number
  modifier_source_value: string | null
  procedure_source_value: string | null
  visit_occurrence_id: number
}

/**
 * One row of the LabResult mirror, as the export reads it.
 *
 * Shared by the preoperative snapshot and the intraoperative draws: the two
 * are the same clinical object and go through the same emission path, so a
 * single shape keeps them from drifting.
 */
export interface OmopLabRow {
  test: string
  valueNum: number | null
  value: string | null
  unitCanon: string | null
  loincCode: string | null
  abnormalFlag: string | null
  /**
   * When the specimen was drawn. Carried by LabResult all along and thrown
   * away here until intraoperative labs existed: every lab row was stamped
   * with the preoperative vitals date instead, so a result drawn three days
   * before surgery and one drawn during it were indistinguishable in the
   * export.
   */
  takenAt?: Date | string | null
  referenceLow?: number | null
  referenceHigh?: number | null
  standardConceptId?: number | null
  mappingStatus?: string
}

export interface OmopObservation {
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
  /**
   * The answer as a concept, where the answer is one the vocabulary can state.
   *
   * A clinical yes/no lives here as SNOMED Yes (4188539) or No (4188540), which
   * no tool can read out of the string "true". The alternative was a value
   * concept per question — "Never smoked" for a false smoking flag — and that
   * asserts more than the form asked: a boolean that means "not currently
   * smoking" covers the never-smoker and the ex-smoker alike, and calling both
   * "never" is wrong for one of them.
   *
   * 0 where there is no coded answer, which is every free-text and numeric
   * observation.
   */
  value_as_concept_id: number
  observation_source_value: string | null
  visit_occurrence_id: number
}

export type CaseRow = {
  id: string
  /** Dedicated opaque research identifier; never substitute caseCode here. */
  researchId: string
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
    bis?: number | null
    tofRatio?: number | null
    cvp?: number | null
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
    /**
     * The factors behind each risk score.
     *
     * The totals exported and the factors did not, for every score alike --
     * RCRI, Apfel, STOP-BANG and POVOC. A researcher could see an RCRI of 3
     * and never which three, which is the wrong half to keep: for validating
     * or recalibrating a risk model the factors are the data and the total is
     * the derivation.
     *
     * All nullable, so false is an answer and null is nobody having asked.
     */
    rcriIschemicHeart?: boolean | null
    rcriCHF?: boolean | null
    rcriCVD?: boolean | null
    rcriInsulinDM?: boolean | null
    rcriCreatinine?: boolean | null
    apfelPONVHistory?: boolean | null
    apfelPostopOpioids?: boolean | null
    stopbangSnoring?: boolean | null
    stopbangTired?: boolean | null
    stopbangObserved?: boolean | null
    stopbangBP?: boolean | null
    stopbangNeck?: boolean | null
    povocSurgeryAtLeast30Minutes?: boolean | null
    povocAgeAtLeast3Years?: boolean | null
    povocStrabismusSurgery?: boolean | null
    povocHistory?: boolean | null
    povocScore?: number | null
    povocRiskPercent?: number | null
    coldsScore?: number | null
    coldsApplicable?: boolean | null
    coldsCurrentSymptoms?: string | null
    coldsOnset?: string | null
    coldsLungDisease?: string | null
    coldsAirwayDevice?: string | null
    coldsSurgery?: string | null
    difficultAirwayHistory: boolean | null
    mallampati: string | null
    // Attempted-but-not-obtained. One flag can qualify several readings: the
    // blood-pressure flag covers systolic and diastolic, the airway flag covers
    // the whole examination.
    bpUnobtainable?: boolean | null
    heartRateUnobtainable?: boolean | null
    spO2Unobtainable?: boolean | null
    temperatureUnobtainable?: boolean | null
    respiratoryRateUnobtainable?: boolean | null
    airwayUnobtainable?: boolean | null
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
    anticipatedDifficultAirway?: boolean | null
    malignantHyperthermiaHistory?: boolean | null
    unexplainedAnaesthesiaComplications?: boolean | null
    labResults: unknown
    labRows?: OmopLabRow[]
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
    bloodLossMl: number | null
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
    /** Arrived with a tube somebody else placed; this team did not intubate. */
    presentsIntubated?: boolean | null
    /** No airway intervention at all -- regional or sedation. */
    airwayNotApplicable?: boolean | null
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
    /** Laboratory draws taken during the case, each with its own `takenAt`. */
    labRows?: OmopLabRow[]
  } | null
  postop?: {
    aldreteActivity: number | null
    aldreteRespiration: number | null
    aldreteCirculation: number | null
    aldreteConsciousness: number | null
    aldreteSpO2: number | null
    aldreteTotal: number | null
    recoveryBpUnobtainable?: boolean | null
    recoveryHeartRateUnobtainable?: boolean | null
    recoverySpO2Unobtainable?: boolean | null
    recoveryTemperatureUnobtainable?: boolean | null
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
  // A case now holds one finalization per attestation, so presence is a count
  // rather than a single row. Declared required, unlike the optional `snapshot`
  // it replaces: that optionality is what let a rename pass the type checker
  // while quietly reporting every finalised case as missing its snapshot.
  finalizations: { id: string }[]
  updatedAt?: Date
  finalizedAt?: Date | null
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
