// 4.2.0 adds bloodLossMl, the first intraoperative quantity a clinician enters
// that is not derivable from the fluid events. Crystalloids, colloids and blood
// products are projections of what was actually given; blood lost is an
// observation only the anaesthetist can make. NULL means not recorded, which is
// deliberately distinct from a recorded 0 mL.
//
// 4.1.0 points the entries at columns that exist. Twenty-six entries declared
// observation.value_as_number, a column the export did not have until
// source_version 3.7.0 added it; five more named a column by a name the export
// has never used (visit_start_datetime, visit_end_datetime, route_concept_id,
// and the anaesthesia techniques, which are procedure rows rather than
// observations). Every numeric allowed range is now the one the validator in
// @lospor/core enforces, rather than the narrower range that felt plausible
// when the entry was written: the dictionary said height 50-250 cm and weight
// 1-300 kg while the app has always accepted 20-280 and 0.1-700, so every
// neonate on file sat outside its own documented range and would have read as
// a data-quality problem. A test holds the two together from now on. Nothing
// has been exported under 4.0.0, so no dataset needs migrating.
//
// 4.0.0 renamed every source value to NAMESPACE:CODE and added height and
// weight, which were documented but never exported. Nothing had been exported
// under 3.x, so no dataset needs migrating.
export const DICTIONARY_VERSION = "4.3.0"

export interface DictionaryEntry {
  name: string
  exportName: string
  meaning: string
  unit?: string
  type: "integer" | "float" | "string" | "boolean" | "datetime" | "enum" | "concept_id" | "json"
  allowedValues?: string
  missingnessRule: string
  derivationRule?: string
  sourceTable: string
  sourceColumn: string
  versionIntroduced: string
}

export const DATA_DICTIONARY: DictionaryEntry[] = [
  // ── Visit occurrence ──────────────────────────────────────────────────────────
  {
    name: "visit_occurrence_id",
    exportName: "visit_occurrence.visit_occurrence_id",
    meaning: "Unique identifier for the perioperative visit",
    type: "integer",
    missingnessRule: "Always present",
    derivationRule: "Deterministic hash of case.id, truncated to 53-bit safe integer",
    sourceTable: "Case", sourceColumn: "id",
    versionIntroduced: "3.0.0",
  },
  {
    name: "person_id",
    exportName: "visit_occurrence.person_id",
    meaning: "Pseudonymised patient identifier — not reversible without source DB",
    type: "integer",
    missingnessRule: "Always present",
    derivationRule: "SHA-256 hash of case.id → 53-bit safe integer",
    sourceTable: "Case", sourceColumn: "id",
    versionIntroduced: "3.0.0",
  },
  {
    name: "visit_start_date",
    exportName: "visit_occurrence.visit_start_date",
    meaning: "Day of the anaesthetic. A date, not an instant — the exact start time is not exported at visit level, only on the individual intraoperative events",
    type: "datetime",
    missingnessRule: "NULL only if the case carries no usable date at all; a case with no recorded start falls back to the day it was created",
    derivationRule: "intraop.startedAt, else the legacy startTime when it carries a real date, else case.createdAt. The legacy wall-clock columns sit on a dummy 2000-01-01 date and are never exported as the day of surgery",
    sourceTable: "IntraoperativeRecord", sourceColumn: "startedAt / startTime",
    versionIntroduced: "3.0.0",
  },
  {
    name: "visit_end_date",
    exportName: "visit_occurrence.visit_end_date",
    meaning: "Day the anaesthetic ended, which for an overnight case is not the day it started",
    type: "datetime",
    missingnessRule: "NULL only if the case carries no usable date at all",
    derivationRule: "intraop.endedAt, else the legacy endTime when it carries a real date, else the start date",
    sourceTable: "IntraoperativeRecord", sourceColumn: "endedAt / endTime",
    versionIntroduced: "3.0.0",
  },
  // ── Preop demographics ────────────────────────────────────────────────────────
  {
    name: "ageYears",
    exportName: "measurement.value_as_number (LOSPOR:AGE_YEARS)",
    meaning: "Patient age at time of anaesthesia, in whole years, as SNOMED "
      + "4314456 (Current chronological age) in UCUM years (unit 9448). OMOP "
      + "tooling normally derives age from person.year_of_birth and a visit "
      + "date; this register coarsens the birth year deliberately, so the "
      + "recorded age is the more precise of the two.",
    unit: "years",
    type: "integer",
    allowedValues: "0–149",
    missingnessRule: "NULL = not recorded by clinician",
    sourceTable: "PreoperativeAssessment", sourceColumn: "ageYears",
    versionIntroduced: "3.0.0",
  },
  {
    name: "sex",
    exportName: "person.gender_concept_id",
    meaning: "Biological sex at birth",
    type: "enum",
    allowedValues: "'MALE' | 'FEMALE'",
    missingnessRule: "NULL = not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "sex",
    versionIntroduced: "3.0.0",
  },
  {
    name: "heightCm",
    exportName: "measurement.value_as_number (LOINC:8302-2)",
    meaning: "Patient height",
    unit: "cm",
    type: "float",
    // The range the app actually enforces (clinical-validation in @lospor/core).
    // The dictionary previously said 50–250, which excludes every neonate the
    // paediatric mode exists to record: a researcher would have read a real
    // 34 cm preterm height as out-of-range noise.
    allowedValues: "20–280",
    missingnessRule: "NULL = not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "heightCm",
    versionIntroduced: "3.0.0",
  },
  {
    name: "weightKg",
    exportName: "measurement.value_as_number (LOINC:29463-7)",
    meaning: "Patient weight",
    unit: "kg",
    type: "float",
    // As enforced by clinical-validation in @lospor/core. The lower bound
    // matters: a 0.6 kg preterm infant is a real weight and every dose on that
    // chart was calculated from it.
    allowedValues: "0.1–700",
    missingnessRule: "NULL = not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "weightKg",
    versionIntroduced: "3.0.0",
  },
  {
    name: "bpSystolic",
    exportName: "measurement.value_as_number (LOINC:8480-6)",
    meaning: "Preoperative systolic blood pressure",
    unit: "mmHg",
    type: "integer",
    allowedValues: "10–300",
    missingnessRule: "Blank with value_as_concept_id 618772 = the reading was attempted and could not be obtained, which is a finding about the patient. Blank with an empty value_as_concept_id = nobody recorded it. These are different statements and must not be pooled: unobtainable readings cluster in shocked, arrhythmic and peripherally shut-down patients, so excluding them as missing data drops the sickest cases and makes the cohort look healthier than it was",
    sourceTable: "PreoperativeAssessment", sourceColumn: "bpSystolic",
    versionIntroduced: "3.0.0",
  },
  {
    name: "bpDiastolic",
    exportName: "measurement.value_as_number (LOINC:8462-4)",
    meaning: "Preoperative diastolic blood pressure",
    unit: "mmHg",
    type: "integer",
    allowedValues: "5–200",
    missingnessRule: "Blank with value_as_concept_id 618772 = the reading was attempted and could not be obtained, which is a finding about the patient. Blank with an empty value_as_concept_id = nobody recorded it. These are different statements and must not be pooled: unobtainable readings cluster in shocked, arrhythmic and peripherally shut-down patients, so excluding them as missing data drops the sickest cases and makes the cohort look healthier than it was",
    sourceTable: "PreoperativeAssessment", sourceColumn: "bpDiastolic",
    versionIntroduced: "3.0.0",
  },
  {
    name: "heartRate",
    exportName: "measurement.value_as_number (LOINC:8867-4)",
    meaning: "Preoperative heart rate",
    unit: "bpm",
    type: "integer",
    allowedValues: "10–350",
    missingnessRule: "Blank with value_as_concept_id 618772 = the reading was attempted and could not be obtained, which is a finding about the patient. Blank with an empty value_as_concept_id = nobody recorded it. These are different statements and must not be pooled: unobtainable readings cluster in shocked, arrhythmic and peripherally shut-down patients, so excluding them as missing data drops the sickest cases and makes the cohort look healthier than it was",
    sourceTable: "PreoperativeAssessment", sourceColumn: "heartRate",
    versionIntroduced: "3.0.0",
  },
  {
    name: "spO2",
    exportName: "measurement.value_as_number (LOINC:59408-5)",
    meaning: "Preoperative peripheral oxygen saturation",
    unit: "%",
    type: "integer",
    allowedValues: "0–100",
    missingnessRule: "Blank with value_as_concept_id 618772 = the reading was attempted and could not be obtained, which is a finding about the patient. Blank with an empty value_as_concept_id = nobody recorded it. These are different statements and must not be pooled: unobtainable readings cluster in shocked, arrhythmic and peripherally shut-down patients, so excluding them as missing data drops the sickest cases and makes the cohort look healthier than it was",
    sourceTable: "PreoperativeAssessment", sourceColumn: "spO2",
    versionIntroduced: "3.0.0",
  },
  {
    name: "temperature",
    exportName: "measurement.value_as_number (LOINC:8310-5)",
    meaning: "Preoperative body temperature",
    unit: "°C",
    type: "float",
    allowedValues: "25–45",
    missingnessRule: "Blank with value_as_concept_id 618772 = the reading was attempted and could not be obtained, which is a finding about the patient. Blank with an empty value_as_concept_id = nobody recorded it. These are different statements and must not be pooled: unobtainable readings cluster in shocked, arrhythmic and peripherally shut-down patients, so excluding them as missing data drops the sickest cases and makes the cohort look healthier than it was",
    sourceTable: "PreoperativeAssessment", sourceColumn: "temperature",
    versionIntroduced: "3.0.0",
  },
  {
    name: "respiratoryRate",
    exportName: "measurement.value_as_number (LOINC:9279-1)",
    meaning: "Preoperative respiratory rate",
    unit: "breaths/min",
    type: "integer",
    allowedValues: "0–150",
    missingnessRule: "Blank with value_as_concept_id 618772 = the reading was attempted and could not be obtained, which is a finding about the patient. Blank with an empty value_as_concept_id = nobody recorded it. These are different statements and must not be pooled: unobtainable readings cluster in shocked, arrhythmic and peripherally shut-down patients, so excluding them as missing data drops the sickest cases and makes the cohort look healthier than it was",
    sourceTable: "PreoperativeAssessment", sourceColumn: "respiratoryRate",
    versionIntroduced: "3.0.0",
  },
  // ── Preop scores ──────────────────────────────────────────────────────────────
  {
    name: "asaScore",
    exportName: "measurement.value_as_concept_id (LOSPOR:ASA_CLASS)",
    meaning: "ASA Physical Status Classification, as SNOMED concept 4199571 with "
      + "the class in value_as_concept_id (1=4186042, 2=4184967, 3=4186043, "
      + "4=4211334, 5=4186044, 6=4186045). The reported string, including any E "
      + "suffix, stays in value_source_value; urgency itself is carried by "
      + "emergencySurgery, as there is no ASA-with-E concept.",
    type: "concept_id",
    allowedValues: "'1'|'2'|'3'|'4'|'5'|'6', optionally suffixed 'E' in value_source_value",
    missingnessRule: "Absent row = not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "asaScore",
    versionIntroduced: "3.0.0",
  },
  {
    name: "rcriIschemicHeart",
    exportName: "observation.value_as_concept_id (LOSPOR:RCRI_ISCHEMIC_HEART)",
    meaning: "Ischaemic heart disease, as a Revised Cardiac Risk Index factor. Answered 4188539 (Yes) or 4188540 (No). The score totals exported and the factors did not, so an RCRI of 3 never said which three -- and for validating or recalibrating a risk model the factors are the data and the total is the derivation.",
    type: "boolean",
    missingnessRule: "No row = the question was not asked. The column is nullable, so a recorded false is exported as No and is a different statement from silence",
    sourceTable: "PreoperativeAssessment", sourceColumn: "rcriIschemicHeart",
    versionIntroduced: "4.3.0",
  },
  {
    name: "rcriCHF",
    exportName: "observation.value_as_concept_id (LOSPOR:RCRI_CHF)",
    meaning: "Congestive heart failure, as an RCRI factor. Answered 4188539 (Yes) or 4188540 (No). The score totals exported and the factors did not, so an RCRI of 3 never said which three -- and for validating or recalibrating a risk model the factors are the data and the total is the derivation.",
    type: "boolean",
    missingnessRule: "No row = the question was not asked. The column is nullable, so a recorded false is exported as No and is a different statement from silence",
    sourceTable: "PreoperativeAssessment", sourceColumn: "rcriCHF",
    versionIntroduced: "4.3.0",
  },
  {
    name: "rcriCVD",
    exportName: "observation.value_as_concept_id (LOSPOR:RCRI_CVD)",
    meaning: "Cerebrovascular disease, as an RCRI factor. Answered 4188539 (Yes) or 4188540 (No). The score totals exported and the factors did not, so an RCRI of 3 never said which three -- and for validating or recalibrating a risk model the factors are the data and the total is the derivation.",
    type: "boolean",
    missingnessRule: "No row = the question was not asked. The column is nullable, so a recorded false is exported as No and is a different statement from silence",
    sourceTable: "PreoperativeAssessment", sourceColumn: "rcriCVD",
    versionIntroduced: "4.3.0",
  },
  {
    name: "rcriInsulinDM",
    exportName: "observation.value_as_concept_id (LOSPOR:RCRI_INSULIN_DM)",
    meaning: "Insulin-treated diabetes, as an RCRI factor. Answered 4188539 (Yes) or 4188540 (No). The score totals exported and the factors did not, so an RCRI of 3 never said which three -- and for validating or recalibrating a risk model the factors are the data and the total is the derivation.",
    type: "boolean",
    missingnessRule: "No row = the question was not asked. The column is nullable, so a recorded false is exported as No and is a different statement from silence",
    sourceTable: "PreoperativeAssessment", sourceColumn: "rcriInsulinDM",
    versionIntroduced: "4.3.0",
  },
  {
    name: "rcriCreatinine",
    exportName: "observation.value_as_concept_id (LOSPOR:RCRI_CREATININE)",
    meaning: "Creatinine above the RCRI threshold, as an RCRI factor. Answered 4188539 (Yes) or 4188540 (No). The score totals exported and the factors did not, so an RCRI of 3 never said which three -- and for validating or recalibrating a risk model the factors are the data and the total is the derivation.",
    type: "boolean",
    missingnessRule: "No row = the question was not asked. The column is nullable, so a recorded false is exported as No and is a different statement from silence",
    sourceTable: "PreoperativeAssessment", sourceColumn: "rcriCreatinine",
    versionIntroduced: "4.3.0",
  },
  {
    name: "apfelPONVHistory",
    exportName: "observation.value_as_concept_id (LOSPOR:APFEL_PONV_HISTORY)",
    meaning: "History of postoperative nausea and vomiting or motion sickness, as an Apfel factor. Answered 4188539 (Yes) or 4188540 (No). The score totals exported and the factors did not, so an RCRI of 3 never said which three -- and for validating or recalibrating a risk model the factors are the data and the total is the derivation.",
    type: "boolean",
    missingnessRule: "No row = the question was not asked. The column is nullable, so a recorded false is exported as No and is a different statement from silence",
    sourceTable: "PreoperativeAssessment", sourceColumn: "apfelPONVHistory",
    versionIntroduced: "4.3.0",
  },
  {
    name: "apfelPostopOpioids",
    exportName: "observation.value_as_concept_id (LOSPOR:APFEL_POSTOP_OPIOIDS)",
    meaning: "Expected postoperative opioids, as an Apfel factor. Answered 4188539 (Yes) or 4188540 (No). The score totals exported and the factors did not, so an RCRI of 3 never said which three -- and for validating or recalibrating a risk model the factors are the data and the total is the derivation.",
    type: "boolean",
    missingnessRule: "No row = the question was not asked. The column is nullable, so a recorded false is exported as No and is a different statement from silence",
    sourceTable: "PreoperativeAssessment", sourceColumn: "apfelPostopOpioids",
    versionIntroduced: "4.3.0",
  },
  {
    name: "stopbangSnoring",
    exportName: "observation.value_as_concept_id (LOSPOR:STOPBANG_SNORING)",
    meaning: "Loud snoring, as a STOP-BANG factor. Answered 4188539 (Yes) or 4188540 (No). The score totals exported and the factors did not, so an RCRI of 3 never said which three -- and for validating or recalibrating a risk model the factors are the data and the total is the derivation.",
    type: "boolean",
    missingnessRule: "No row = the question was not asked. The column is nullable, so a recorded false is exported as No and is a different statement from silence",
    sourceTable: "PreoperativeAssessment", sourceColumn: "stopbangSnoring",
    versionIntroduced: "4.3.0",
  },
  {
    name: "stopbangTired",
    exportName: "observation.value_as_concept_id (LOSPOR:STOPBANG_TIRED)",
    meaning: "Daytime tiredness, as a STOP-BANG factor. Answered 4188539 (Yes) or 4188540 (No). The score totals exported and the factors did not, so an RCRI of 3 never said which three -- and for validating or recalibrating a risk model the factors are the data and the total is the derivation.",
    type: "boolean",
    missingnessRule: "No row = the question was not asked. The column is nullable, so a recorded false is exported as No and is a different statement from silence",
    sourceTable: "PreoperativeAssessment", sourceColumn: "stopbangTired",
    versionIntroduced: "4.3.0",
  },
  {
    name: "stopbangObserved",
    exportName: "observation.value_as_concept_id (LOSPOR:STOPBANG_OBSERVED_APNOEA)",
    meaning: "Observed apnoea, as a STOP-BANG factor. Answered 4188539 (Yes) or 4188540 (No). The score totals exported and the factors did not, so an RCRI of 3 never said which three -- and for validating or recalibrating a risk model the factors are the data and the total is the derivation.",
    type: "boolean",
    missingnessRule: "No row = the question was not asked. The column is nullable, so a recorded false is exported as No and is a different statement from silence",
    sourceTable: "PreoperativeAssessment", sourceColumn: "stopbangObserved",
    versionIntroduced: "4.3.0",
  },
  {
    name: "stopbangBP",
    exportName: "observation.value_as_concept_id (LOSPOR:STOPBANG_BP)",
    meaning: "Treated hypertension, as a STOP-BANG factor. Answered 4188539 (Yes) or 4188540 (No). The score totals exported and the factors did not, so an RCRI of 3 never said which three -- and for validating or recalibrating a risk model the factors are the data and the total is the derivation.",
    type: "boolean",
    missingnessRule: "No row = the question was not asked. The column is nullable, so a recorded false is exported as No and is a different statement from silence",
    sourceTable: "PreoperativeAssessment", sourceColumn: "stopbangBP",
    versionIntroduced: "4.3.0",
  },
  {
    name: "stopbangNeck",
    exportName: "observation.value_as_concept_id (LOSPOR:STOPBANG_NECK)",
    meaning: "Neck circumference above the threshold, as a STOP-BANG factor. Answered 4188539 (Yes) or 4188540 (No). The score totals exported and the factors did not, so an RCRI of 3 never said which three -- and for validating or recalibrating a risk model the factors are the data and the total is the derivation.",
    type: "boolean",
    missingnessRule: "No row = the question was not asked. The column is nullable, so a recorded false is exported as No and is a different statement from silence",
    sourceTable: "PreoperativeAssessment", sourceColumn: "stopbangNeck",
    versionIntroduced: "4.3.0",
  },
  {
    name: "povocSurgeryAtLeast30Minutes",
    exportName: "observation.value_as_concept_id (LOSPOR:POVOC_SURGERY_30_MIN)",
    meaning: "Surgery lasting at least 30 minutes, as a POVOC factor. Answered 4188539 (Yes) or 4188540 (No). The score totals exported and the factors did not, so an RCRI of 3 never said which three -- and for validating or recalibrating a risk model the factors are the data and the total is the derivation.",
    type: "boolean",
    missingnessRule: "No row = the question was not asked. The column is nullable, so a recorded false is exported as No and is a different statement from silence",
    sourceTable: "PreoperativeAssessment", sourceColumn: "povocSurgeryAtLeast30Minutes",
    versionIntroduced: "4.3.0",
  },
  {
    name: "povocAgeAtLeast3Years",
    exportName: "observation.value_as_concept_id (LOSPOR:POVOC_AGE_3_YEARS)",
    meaning: "Age at least three years, as a POVOC factor. Answered 4188539 (Yes) or 4188540 (No). The score totals exported and the factors did not, so an RCRI of 3 never said which three -- and for validating or recalibrating a risk model the factors are the data and the total is the derivation.",
    type: "boolean",
    missingnessRule: "No row = the question was not asked. The column is nullable, so a recorded false is exported as No and is a different statement from silence",
    sourceTable: "PreoperativeAssessment", sourceColumn: "povocAgeAtLeast3Years",
    versionIntroduced: "4.3.0",
  },
  {
    name: "povocStrabismusSurgery",
    exportName: "observation.value_as_concept_id (LOSPOR:POVOC_STRABISMUS)",
    meaning: "Strabismus surgery, as a POVOC factor. Answered 4188539 (Yes) or 4188540 (No). The score totals exported and the factors did not, so an RCRI of 3 never said which three -- and for validating or recalibrating a risk model the factors are the data and the total is the derivation.",
    type: "boolean",
    missingnessRule: "No row = the question was not asked. The column is nullable, so a recorded false is exported as No and is a different statement from silence",
    sourceTable: "PreoperativeAssessment", sourceColumn: "povocStrabismusSurgery",
    versionIntroduced: "4.3.0",
  },
  {
    name: "povocHistory",
    exportName: "observation.value_as_concept_id (LOSPOR:POVOC_HISTORY)",
    meaning: "Patient or family history of postoperative vomiting, as a POVOC factor. Answered 4188539 (Yes) or 4188540 (No). The score totals exported and the factors did not, so an RCRI of 3 never said which three -- and for validating or recalibrating a risk model the factors are the data and the total is the derivation.",
    type: "boolean",
    missingnessRule: "No row = the question was not asked. The column is nullable, so a recorded false is exported as No and is a different statement from silence",
    sourceTable: "PreoperativeAssessment", sourceColumn: "povocHistory",
    versionIntroduced: "4.3.0",
  },
  {
    name: "rcriScore",
    exportName: "measurement.value_as_number (LOSPOR:RCRI)",
    meaning: "Revised Cardiac Risk Index score",
    type: "integer",
    allowedValues: "0–6",
    missingnessRule: "NULL = not computed (missing inputs)",
    derivationRule: "Sum of 6 binary risk factors selected by clinician",
    sourceTable: "PreoperativeAssessment", sourceColumn: "rcriScore",
    versionIntroduced: "3.0.0",
  },
  {
    name: "apfelScore",
    exportName: "observation.value_as_number (LOSPOR:APFEL)",
    meaning: "Apfel score for PONV risk",
    type: "integer",
    allowedValues: "0–4",
    missingnessRule: "NULL = not computed",
    derivationRule: "Sum of 4 binary risk factors",
    sourceTable: "PreoperativeAssessment", sourceColumn: "apfelScore",
    versionIntroduced: "3.0.0",
  },
  {
    name: "stopBangScore",
    exportName: "measurement.value_as_number (LOSPOR:STOP_BANG)",
    meaning: "STOP-BANG obstructive sleep apnoea screening score",
    type: "integer",
    allowedValues: "0–8",
    missingnessRule: "NULL = not computed",
    derivationRule: "Sum of 8 binary screening items",
    sourceTable: "PreoperativeAssessment", sourceColumn: "stopBangScore",
    versionIntroduced: "3.0.0",
  },
  {
    name: "emergencySurgery",
    exportName: "procedure_occurrence.modifier_concept_id",
    meaning: "Whether the procedure was performed as an emergency. Carried "
      + "only on the operation itself, as "
      + "procedure_occurrence.modifier_concept_id, using SNOMED Qualifier "
      + "Values: 4093606 (Emergency) against 4013731 (Elective). A qualifier on "
      + "the operation rather than a second procedure, so one operation still "
      + "counts as one. The two are one toggle in the form and cannot both be "
      + "true; a case recorded before the field existed carries modifier 0. "
      + "There used to be a LOSPOR:EMERGENCY_SURGERY observation carrying the "
      + "same fact at concept 0; it was removed, because a query counting both "
      + "counted every emergency case twice.",
    type: "boolean",
    missingnessRule: "NULL = not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "emergencySurgery",
    versionIntroduced: "3.0.0",
  },
  {
    name: "highRiskSurgery",
    exportName: "observation.value_as_string (LOSPOR:HIGH_RISK_SURGERY)",
    meaning: "Whether the procedure was classified as high-risk. Carries SNOMED "
      + "4250613 (At increased risk for perioperative injury), which is an "
      + "approximation and should be read as one: RCRI defines high-risk by "
      + "operation type — intraperitoneal, intrathoracic, suprainguinal "
      + "vascular — and no concept exists for that category. Anyone pooling on "
      + "4250613 across sites is pooling this operation-type flag with other "
      + "sites' patient-risk assessments. The operation itself is exported with "
      + "its own concept, so the category can be derived from it instead.",
    type: "boolean",
    missingnessRule: "NULL = not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "highRiskSurgery",
    versionIntroduced: "3.0.0",
  },
  {
    name: "elective",
    exportName: "procedure_occurrence.modifier_concept_id (LOSPOR:ELECTIVE_SURGERY)",
    meaning: "An elective case, as SNOMED Qualifier Value 4013731 on the "
      + "operation. Derived from emergencySurgery being false rather than "
      + "stored separately: the form records one urgency toggle. Until 4.3.0 "
      + "this left the building nowhere at all — only emergency did, so an "
      + "elective case was indistinguishable from one where urgency was never "
      + "recorded.",
    type: "concept_id",
    missingnessRule: "Modifier 0 = urgency not recorded, which is a case predating the field",
    sourceTable: "PreoperativeAssessment", sourceColumn: "emergencySurgery",
    versionIntroduced: "4.3.0",
  },
  {
    name: "difficultAirwayHistory",
    exportName: "observation.value_as_concept_id (LOSPOR:DIFFICULT_AIRWAY_HISTORY)",
    meaning: "History of difficult airway, as SNOMED 37397718 (Difficult "
      + "intubation) answered with 4188539 (Yes) or 4188540 (No). The "
      + "vocabulary's own history shape — question 1340204 (History of event) "
      + "with this concept as the value — is deliberately not used: it can only "
      + "state that a difficult intubation happened, and a documented 'no known "
      + "difficult airway' would then be expressed by an absent row, which "
      + "cannot be told apart from never having asked. A previous difficult "
      + "intubation outweighs every bedside test, so the denial is itself a "
      + "finding another anaesthetist relies on.",
    type: "concept_id",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "difficultAirwayHistory",
    versionIntroduced: "3.0.0",
  },
  {
    name: "mallampati",
    exportName: "measurement.value_as_concept_id (LOSPOR:MALLAMPATI)",
    meaning: "Mallampati airway classification",
    type: "enum",
    allowedValues: "'I'|'II'|'III'|'IV'",
    missingnessRule: "NULL = not assessed",
    sourceTable: "PreoperativeAssessment", sourceColumn: "mallampati",
    versionIntroduced: "3.0.0",
  },
  // ── Intraop ───────────────────────────────────────────────────────────────────
  {
    name: "durationMinutes",
    exportName: "observation.value_as_number (LOSPOR:ANAESTHESIA_DURATION_MIN)",
    meaning: "Total anaesthesia duration",
    unit: "minutes",
    type: "float",
    allowedValues: "0–1440",
    missingnessRule: "NULL = start or end time not recorded",
    derivationRule: "Derived from intraop.startTime and intraop.endTime if both present, else stored value",
    sourceTable: "IntraoperativeRecord", sourceColumn: "durationMinutes",
    versionIntroduced: "3.0.0",
  },
  {
    name: "techniques",
    // One procedure row per technique, not one observation carrying a list.
    // The dictionary named an observation code that has never been emitted, so
    // a researcher filtering observations for LOSPOR:ANAESTHESIA_TECHNIQUE got
    // nothing back and would have read that as "no technique recorded".
    exportName: "procedure_occurrence.procedure_concept_id",
    meaning: "Anaesthesia techniques used (multi-select), one procedure row per "
      + "technique, each source value prefixed ANAESTHESIA_TECHNIQUE:. Coded as "
      + "SNOMED: 4174669 (Administration of general anesthetic), 4332593 "
      + "(Spinal anesthesia), 4078199 (Epidural anesthesia), 4219502 "
      + "(Sedation). GENERAL is 4174669 rather than 4171773 (Operative general "
      + "anesthesia), which looked like the obvious parent and is not one: "
      + "4171773 is a sibling of GENERAL_INHALATION and GENERAL_TIVA under "
      + "4174669, not their ancestor, so a cohort built on 4171773 and its "
      + "descendants misses every inhalational and every TIVA case -- the "
      + "opposite of what a general-anaesthetic filter should return. 4174669 "
      + "is verified, against CONCEPT_ANCESTOR, as the true parent of all three "
      + "maintenance routes, and its descendant set stops at general "
      + "anaesthesia: sedation sits elsewhere, under 4249997, so this does not "
      + "also sweep in sedation cases. "
      + "The technique tree is deeper than the vocabulary, so a node below a "
      + "coded one takes its nearest coded ancestor -- SPINAL_SINGLE_LUMBAR is "
      + "coded as spinal anaesthesia -- and the exact node stays in "
      + "procedure_source_value, so nothing is flattened away. A node with no "
      + "coded ancestor is 0. The block regions are coded from the matching "
      + "SNOMED family -- 4140397 (Local anesthetic nerve block), 4332443 "
      + "(upper limb), 4333960 (lower limb), 4125199 (trunk) -- so most named "
      + "blocks inherit something true. Beneath GENERAL, the three maintenance "
      + "routes are coded individually: 4118897 (Inhalation general "
      + "anesthesia) or 4086418 (Total intravenous anesthesia). A balanced "
      + "anaesthetic stays at 4171773 (Operative general anesthesia) on "
      + "purpose rather than inheriting GENERAL's own concept: TIVA means "
      + "total intravenous, so a case running a volatile is not TIVA, and it "
      + "is not inhalation-only either, so neither sibling is true of it and "
      + "4171773 is the correct answer rather than a fallback. The drug rows "
      + "distinguish maintenance "
      + "route more precisely in any case, including a case that switched "
      + "mid-operation, which no single technique code expresses. "
      + "The neuraxial family carries 4228322 "
      + "(Neuraxial nerve block), 4335024 (combined spinal-epidural) and "
      + "37159083 (dural puncture epidural), each its own concept rather than a "
      + "neighbour. The eye blocks are coded per leaf -- 4123785 peribulbar, "
      + "4123784 retrobulbar, 4335044 topical -- because the umbrella that "
      + "would cover them, 4123783 (Ocular infiltration), is false for the "
      + "topical case. Sub-Tenon block has no concept in any vocabulary here "
      + "and inherits the peripheral umbrella; that is a gap in the vocabulary, "
      + "not an omission. Named peripheral leaves are being mapped in batches: "
      + "so far TAP (44783705, the international SNOMED concept rather than "
      + "the UK national extension 44808433 for the same procedure), femoral "
      + "(4336456), adductor canal (4333280, coded as the saphenous nerve "
      + "block it procedurally is -- no 'adductor canal block' procedure "
      + "concept exists in this vocabulary) and interscalene (4333843). "
      + "BLOCK_SCIATIC carries 4215528, Local anesthetic sciatic nerve block; "
      + "lateral approach, by product decision rather than derived fact: "
      + "SNOMED splits the sciatic block by approach with no unqualified "
      + "concept, and the form does not record which approach was used, so "
      + "this states one specific approach for every case. Revisit if the form "
      + "gains an approach field. The remaining three brachial plexus "
      + "approaches are also mapped: 4332444 supraclavicular, 4332445 "
      + "infraclavicular, 4336448 axillary. Intercostal carries 4332575. "
      + "Ilioinguinal/iliohypogastric is the same shape of gap as the sciatic "
      + "approach: the form has one checkbox for both nerves and SNOMED has two "
      + "concepts with no combined one, so 4333290 (ilioinguinal) is coded and "
      + "the iliohypogastric half (4332577) is not, by product decision. "
      + "PECS I carries 37017575, Local anesthetic pectoral compartment nerve "
      + "block: no concept is literally named PECS I, but 37017575 is the "
      + "vocabulary's own parent of PECS II (37397715), one level up, mirroring "
      + "the clinical relationship between the two techniques rather than "
      + "standing in for a missing name. Serratus plane carries 37018762. ESP "
      + "carries 37311663, the only ESP concept here, which names ultrasound "
      + "guidance the form does not record -- accepted because ESP is not a "
      + "landmark technique in current practice. Paravertebral carries 4205280, "
      + "unqualified, rather than the thoracic or lumbar variants, because the "
      + "form does not ask which level. Wrist (4332447), elbow (4332446, "
      + "unqualified rather than ulnar/radial/median-at-elbow) and digital "
      + "(4333956, the hand-specific concept, scoped correctly since this leaf "
      + "sits under Upper extremity) complete the named upper-limb blocks. "
      + "Bier block carries 4117443, Local anesthetic intravenous regional "
      + "block: there is no concept literally named Bier block, and IVRA is "
      + "the technical term this maps to exactly. "
      + "LOCAL carries 4124873, Wound infiltration of local anesthetic, and "
      + "not 4303995 (Local anesthesia): that concept looked like the obvious "
      + "umbrella and is verified, against CONCEPT_ANCESTOR, as the parent of "
      + "the entire nerve block family too, so using it would give a plain "
      + "wound infiltration the same lineage as a spinal or a TAP block. "
      + "Popliteal is coded the same way and for the same reason as sciatic: "
      + "4215528 (lateral approach), since a popliteal block is a sciatic "
      + "block at the popliteal fossa with no procedure concept of its own. "
      + "REGIONAL now carries 4100052, mapped only once the tree beneath it "
      + "was finished so mapping it would not silently mark undecided work as "
      + "done. Three nodes still resolve to 0 before reaching it: BLOCK_QL "
      + "(quadratus lumborum) and BLOCK_RECTUS (rectus sheath) have no "
      + "procedure concept anywhere in this vocabulary, only anatomy and, for "
      + "QL, a syndrome; BLOCK_SUB_TENONS has nothing at all, since the only "
      + "matches for 'tenon' are drug names and orbital inflammation. All "
      + "three are confirmed gaps in the vocabulary rather than undecided "
      + "work, and they inherit their nearer region ancestor rather than "
      + "REGIONAL itself. There is no plain "
      + "General anesthesia concept in this vocabulary; the ones that exist are "
      + "CIEL, MeSH, SUS and NDFRT, which do not ship here.",
    type: "string",
    allowedValues: "ANAESTHESIA_TECHNIQUE:<technique>",
    missingnessRule: "No row = no technique recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "techniques",
    versionIntroduced: "3.0.0",
  },
  {
    name: "medications",
    exportName: "drug_exposure.drug_concept_id (via ATC→OMOP map)",
    meaning: "A medication the patient reported taking at home, coded where "
      + "an ATC code resolves one. drug_type_concept_id is 32865, Patient "
      + "self-report -- this is what was told to the assessor, not something "
      + "witnessed being given, which is what separates it from the same drug "
      + "recorded as a premedication or an intraop dose (both 32818, EHR "
      + "administration record; see event.atcCode). An allergy is not "
      + "included here: Medication.kind ALLERGY is the opposite claim and is "
      + "exported as an observation instead, so it can never be read as a dose.",
    type: "concept_id",
    missingnessRule: "No row = no current medications recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "medications",
    versionIntroduced: "3.0.0",
  },
  {
    name: "smoking",
    exportName: "observation.value_as_concept_id (LOSPOR:SMOKING)",
    meaning: "Whether the patient currently smokes, as LOINC 43054909 (Tobacco "
      + "smoking status) answered with SNOMED 4188539 (Yes) or 4188540 (No). "
      + "Answered rather than characterised on purpose: a value concept such as "
      + "'Never smoked' would state what the form did not ask, since this "
      + "boolean covers the never-smoker and the ex-smoker alike and they carry "
      + "different perioperative risk. value_as_string keeps 'true'/'false'.",
    type: "concept_id",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "smoking",
    versionIntroduced: "3.8.0",
  },
  {
    name: "substanceAbuse",
    exportName: "observation.value_as_concept_id (LOSPOR:SUBSTANCE_ABUSE)",
    meaning: "Whether the patient reports substance misuse, as SNOMED 4234597 "
      + "(Misuses drugs) answered with 4188539 (Yes) or 4188540 (No). Answered "
      + "rather than asserted as a condition, so a denial is recorded as a "
      + "denial: a condition row can only say yes, and would lose both the "
      + "denial and its difference from an unasked question. The concept is "
      + "drug-specific while the question a clinician answers may include "
      + "alcohol, so read it as the nearest available rather than exact.",
    type: "concept_id",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "substanceAbuse",
    versionIntroduced: "3.8.0",
  },
  {
    name: "latexAllergy",
    exportName: "observation.value_as_concept_id (LOSPOR:LATEX_ALLERGY)",
    meaning: "Latex allergy, as SNOMED 43530807 (Allergic disposition) " +
      "answered with 4188539 (Yes) or 4188540 (No). One row: the source concept " +
      "604826 (Allergy to latex) carries a Maps to and a Maps to value, and the " +
      "OHDSI convention puts both halves in a single row rather than two. The " +
      "allergen is in the source value rather than coded, because the answer " +
      "column carries Yes or No -- a denial is a documented safety check and " +
      "has to stay distinguishable from a question nobody asked.",
    type: "concept_id",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "latexAllergy",
    versionIntroduced: "3.8.0",
  },
  {
    name: "familyAnesthesiaProblems",
    exportName: "observation.value_as_concept_id (LOSPOR:FAMILY_ANAESTHESIA_PROBLEMS)",
    meaning: "Family history of anaesthetic problems, such as malignant "
      + "hyperthermia or suxamethonium apnoea, as SNOMED 764557 (Family history "
      + "of complication of anesthesia) answered with 4188539 (Yes) or 4188540 "
      + "(No). Deliberately the broad concept: this replaces a family-history-of"
      + "-malignant-hyperthermia concept, which is narrower than the question "
      + "and would have coded a reported apnoea or difficult intubation as an MH "
      + "history. familyAnesthesiaDetails carries what was actually reported.",
    type: "concept_id",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "familyAnesthesiaProblems",
    versionIntroduced: "3.8.0",
  },
  {
    name: "familyAnesthesiaDetails",
    exportName: "observation.value_as_string (LOSPOR:FAMILY_ANAESTHESIA_DETAILS)",
    meaning: "Free-text detail of the family anaesthetic history. Redacted for PII before export.",
    type: "string",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "familyAnesthesiaDetails",
    versionIntroduced: "3.8.0",
  },
  {
    name: "dentalProsthetics",
    exportName: "observation.value_as_concept_id (LOSPOR:DENTAL_PROSTHETICS)",
    meaning: "Dental prosthetics present — dentures, crowns, caps or bridges — "
      + "as LOINC 3029182 (Dental prosthesis) answered with 4188539 (Yes) or "
      + "4188540 (No). The broad concept on purpose: the denture-specific ones "
      + "would miss the patient with anterior crowns, and crowns are what a "
      + "laryngoscope chips.",
    type: "concept_id",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "dentalProsthetics",
    versionIntroduced: "3.8.0",
  },
  {
    name: "looseTeeth",
    exportName: "observation.value_as_concept_id (LOSPOR:LOOSE_TEETH)",
    meaning: "Loose teeth, as SNOMED 4002000 (Abnormal tooth mobility) answered "
      + "with 4188539 (Yes) or 4188540 (No). The abnormality rather than the "
      + "neutral 'Tooth mobility' finding, so that a No means no abnormal "
      + "mobility was found rather than saying nothing at all.",
    type: "concept_id",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "looseTeeth",
    versionIntroduced: "3.8.0",
  },
  {
    name: "heartArrhythmia",
    exportName: "observation.value_as_concept_id (LOSPOR:HEART_ARRHYTHMIA)",
    meaning: "Cardiac arrhythmia present, as SNOMED 44784217 (Cardiac "
      + "arrhythmia) answered with 4188539 (Yes) or 4188540 (No). The umbrella "
      + "concept, which is the level the question asks at: atrial fibrillation, "
      + "flutter, block and ectopics all answer it, and the specific rhythm is "
      + "not recorded here.",
    type: "concept_id",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "heartArrhythmia",
    versionIntroduced: "3.8.0",
  },
  {
    name: "allergyDetails",
    exportName: "observation.value_as_string (LOSPOR:ALLERGY_DETAILS)",
    meaning: "Free-text allergy detail, carrying allergens never resolved to a drug. Substances that were resolved also appear as LOSPOR:DRUG_ALLERGY observations. Redacted for PII before export.",
    type: "string",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "allergyDetails",
    versionIntroduced: "3.8.0",
  },
  {
    name: "bmi",
    exportName: "measurement.value_as_number (LOSPOR:BMI)",
    meaning: "Body mass index as stored, not recomputed at export time, because the height and weight it came from may since have been corrected.",
    type: "float",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "bmi",
    versionIntroduced: "3.8.0",
  },
  {
    name: "bloodType",
    exportName: "measurement.value_as_concept_id (LOSPOR:BLOOD_GROUP)",
    meaning: "ABO group and rhesus together, as LOINC 3003694 (ABO and Rh group "
      + "[Type] in Blood) with one of the eight SNOMED combinations in "
      + "value_as_concept_id — 4082948 A+, 4080397 A-, 4175555 B+, 4080398 B-, "
      + "4080396 AB+, 4082949 AB-, 4080395 O+, 4082947 O-. One row because a "
      + "blood group is one fact: 'A positive' is what a crossmatch label says "
      + "and what a transfusion query asks for. value_as_concept_id is 0 when "
      + "only one half was recorded, since 'A, rhesus unknown' is not one of the "
      + "eight and guessing the other half would invent a crossmatch. "
      + "value_source_value carries the group as written.",
    type: "concept_id",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "bloodType",
    versionIntroduced: "3.8.0",
  },
  {
    name: "rhFactor",
    exportName: "measurement.value_as_concept_id (LOSPOR:BLOOD_GROUP)",
    meaning: "The rhesus half of the blood group. Exported in the same row as "
      + "bloodType rather than separately — see that entry for the concepts.",
    type: "concept_id",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "rhFactor",
    versionIntroduced: "3.8.0",
  },
  {
    name: "gutaScore",
    exportName: "observation.value_as_number (LOSPOR:GUTA_SCORE)",
    meaning: "GUTA airway assessment score",
    type: "float",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "gutaScore",
    versionIntroduced: "3.8.0",
  },
  {
    name: "mouthOpeningCm",
    exportName: "measurement.value_as_number (LOSPOR:MOUTH_OPENING_CM)",
    meaning: "Interincisor distance on maximal mouth opening",
    type: "float",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "mouthOpeningCm",
    versionIntroduced: "3.8.0",
  },
  {
    name: "thyromental",
    exportName: "measurement.value_as_number (LOSPOR:THYROMENTAL_DISTANCE_CM)",
    meaning: "Thyromental distance",
    type: "float",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "thyromental",
    versionIntroduced: "3.8.0",
  },
  {
    name: "neckMobility",
    exportName: "measurement.value_as_concept_id (LOSPOR:NECK_MOBILITY)",
    meaning: "Cervical spine mobility on examination, as SNOMED 4039256 (Active " +
      "neck movements) with the range found in value_as_concept_id: FULL 4124732 " +
      "(normal range), LIMITED 4119643 (decreased range), FIXED 4124734 (no " +
      "movement). An airway that could not be assessed carries 618772 " +
      "(Unobtainable), the same qualifier the airway distances use. SNOMED also " +
      "has an increased-range concept, which this form has no state for.",
    type: "concept_id",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "neckMobility",
    versionIntroduced: "3.8.0",
  },
  {
    name: "upperLipBiteTest",
    exportName: "observation.value_as_string (LOSPOR:UPPER_LIP_BITE_TEST)",
    meaning: "Upper lip bite test class",
    type: "string",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "upperLipBiteTest",
    versionIntroduced: "3.8.0",
  },
  {
    name: "retrognathia",
    exportName: "observation.value_as_concept_id (LOSPOR:RETROGNATHIA)",
    meaning: "Retrognathia on examination, as SNOMED 4142490 (Mandibular "
      + "retrognathism) answered with 4188539 (Yes) or 4188540 (No).",
    type: "concept_id",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "retrognathia",
    versionIntroduced: "3.8.0",
  },
  {
    name: "prominentIncisors",
    exportName: "observation.value_as_concept_id (LOSPOR:PROMINENT_INCISORS)",
    meaning: "Prominent incisors on examination, as SNOMED 4033016 (Protrusion "
      + "of tooth) answered with 4188539 (Yes) or 4188540 (No).",
    type: "concept_id",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "prominentIncisors",
    versionIntroduced: "3.8.0",
  },
  {
    name: "facialHair",
    exportName: "observation.value_as_string (LOSPOR:FACIAL_HAIR)",
    meaning: "Facial hair, which affects mask seal. Deliberately uncoded: the "
      + "vocabulary's facial-hair concepts all mean hirsutism, a pathological "
      + "finding, and an ordinary beard is not that. See "
      + "anticipatedDifficultAirway, which is the conclusion a beard feeds and "
      + "which is coded.",
    type: "boolean",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "facialHair",
    versionIntroduced: "3.8.0",
  },
  {
    name: "difficultAirwayNotes",
    exportName: "observation.value_as_string (LOSPOR:DIFFICULT_AIRWAY_NOTES)",
    meaning: "Free-text detail of the difficult-airway history. Redacted for PII before export.",
    type: "string",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "difficultAirwayNotes",
    versionIntroduced: "3.8.0",
  },
  {
    name: "anticipatedDifficultAirway",
    exportName: "observation.value_as_concept_id (LOSPOR:ANTICIPATED_DIFFICULT_AIRWAY)",
    meaning: "Whether the assessor expects this airway to be difficult, as "
      + "SNOMED 37159176 (At increased risk for difficult tracheal intubation) "
      + "answered with 4188539 (Yes) or 4188540 (No). A risk statement rather "
      + "than the available 'Expected difficult tracheal intubation', because "
      + "bedside airway tests predict poorly and most patients flagged here are "
      + "intubated uneventfully. Its outcome counterpart, 37397717 (Unexpected "
      + "difficult airway), is not written by anything yet.",
    type: "concept_id",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "anticipatedDifficultAirway",
    versionIntroduced: "4.3.0",
  },
  {
    name: "malignantHyperthermiaHistory",
    exportName: "observation.value_as_concept_id (LOSPOR:MALIGNANT_HYPERTHERMIA_HISTORY)",
    meaning: "Malignant hyperthermia in this patient, as SNOMED 440285 "
      + "(Malignant hyperthermia) answered with 4188539 (Yes) or 4188540 (No). "
      + "Distinct from familyAnesthesiaProblems, which asks about relatives.",
    type: "concept_id",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "malignantHyperthermiaHistory",
    versionIntroduced: "4.3.0",
  },
  {
    name: "unexplainedAnaesthesiaComplications",
    exportName: "observation.value_as_concept_id (LOSPOR:UNEXPLAINED_ANAESTHESIA_COMPLICATIONS)",
    meaning: "Something went wrong under a previous anaesthetic and was never "
      + "explained, as SNOMED 37017043 (Complication due to anesthesia during "
      + "surgery) answered with 4188539 (Yes) or 4188540 (No). The operative "
      + "setting is part of the question, so the unqualified umbrella (4142195) "
      + "is not used; nor is any drug-reaction concept, since naming a cause is "
      + "what this record cannot do.",
    type: "concept_id",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "unexplainedAnaesthesiaComplications",
    versionIntroduced: "4.3.0",
  },
  {
    name: "labAbnormalFlag",
    exportName: "observation.value_as_string (LOSPOR:LAB_ABNORMAL_FLAG)",
    meaning: "Whether a laboratory result was flagged abnormal, as \"<measurement_source_value>=<flag>\" so it joins to the MEASUREMENT row. CDM 5.4 has no abnormal-flag column, and value_as_concept_id would need a standard concept this export does not assign.",
    type: "string",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "LabResult", sourceColumn: "abnormalFlag",
    versionIntroduced: "3.8.0",
  },
  {
    name: "vascularAccessDepthCm",
    exportName: "observation.value_as_number (LOSPOR:VASCULAR_ACCESS_DEPTH_CM)",
    meaning: "Insertion depth of a vascular line, as \"<site>=<depth>\"",
    type: "float",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "VascularAccess", sourceColumn: "depthCm",
    versionIntroduced: "3.8.0",
  },
  {
    name: "vascularAccessLumens",
    exportName: "observation.value_as_number (LOSPOR:VASCULAR_ACCESS_LUMENS)",
    meaning: "Number of lumens on a vascular line, as \"<site>=<lumens>\"",
    type: "float",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "VascularAccess", sourceColumn: "lumens",
    versionIntroduced: "3.8.0",
  },
  {
    name: "vascularAccessPreexisting",
    exportName: "observation.value_as_string (LOSPOR:VASCULAR_ACCESS_PREEXISTING)",
    meaning: "Whether the line was already in place, as \"<site>=<true|false>\". A pre-existing line was not placed during this case, so it emits no PROCEDURE_OCCURRENCE row at all -- counting one would credit this team with an insertion somebody else performed. It is stated instead as an observation under the line's own VASCULAR_ACCESS source value, coded 1340204 (History of event) with the line's concept as the value. This flag is kept alongside that because it carries the negative answer too, which a history row cannot.",
    type: "boolean",
    missingnessRule: "No row = the question was not asked, or the value was not recorded",
    sourceTable: "VascularAccess", sourceColumn: "preexisting",
    versionIntroduced: "3.8.0",
  },
  {
    name: "airwayDevice",
    exportName: "observation.value_as_string (LOSPOR:AIRWAY_DEVICE) + device_exposure.device_concept_id",
    // The device also leaves as a device_exposure row carrying its Device-domain concept, which is the CDM table for a thing that was in the patient. Both are emitted on purpose: the observation preserves the exact option the anaesthetist chose, and the device_exposure row is what a concept-set search can actually find.
    meaning: "Airway device used. One row per device; the legacy single-device column and the current device list are merged and de-duplicated, so a case written across that change exports each device once.",
    type: "string",
    allowedValues: "FACE_MASK | OPA | NPA | LMA | ORAL_ETT | NASAL_ETT | DOUBLE_LUMEN_TUBE | ENDOBRONCHIAL_TUBE | SURGICAL_AIRWAY",
    missingnessRule: "No row = no device recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "airwayDevices",
    versionIntroduced: "3.0.0",
  },
  {
    name: "airwayManagementProcedure",
    exportName: "procedure_occurrence.procedure_concept_id (AIRWAY_MANAGEMENT:<act>)",
    meaning: "The act of placing an airway device, derived from the devices "
      + "recorded. A device is a state of the patient; placing it is something "
      + "done to them, and only the second belongs in a procedure count. "
      + "Devices that are applied rather than instrumented — face mask, oral "
      + "and nasal airways — produce no row. Coded as SNOMED: "
      + "TRACHEAL_INTUBATION_ORAL 4335481 (Orotracheal intubation), "
      + "SUPRAGLOTTIC_AIRWAY_PLACEMENT 4314149 (Laryngeal mask airway "
      + "insertion — not 40431308, the same concept under a deprecated id), "
      + "TRACHEAL_INTUBATION_NASAL 4337616 (Nasotracheal intubation, not "
      + "'Nasal intubation awake' or 'Blind nasal intubation', which each "
      + "assert something the form does not record), "
      + "DOUBLE_LUMEN_TUBE_PLACEMENT 37116698 (Insertion of double lumen "
      + "tracheobronchial tube), ENDOBRONCHIAL_TUBE_PLACEMENT 4335585 "
      + "(Endobronchial intubation, the deliberate placement, not 4134538 "
      + "Unintended endobronchial intubation, the complication of an ordinary "
      + "tube slipping too far). SURGICAL_AIRWAY is 4068680 (Cricothyroidotomy, "
      + "unqualified): checked against a tracheostomy reading, and this device "
      + "list never records one -- a tracheostomy is a separate planned "
      + "procedure done by a different team, and both tracheostomy concepts in "
      + "this vocabulary are deprecated regardless. Not 4134560 (Emergency "
      + "cricothyroidotomy): real-world use of this device is almost always an "
      + "emergency, but the form does not record emergency or elective for it, "
      + "so this states what is known rather than what is likely.",
    type: "string",
    allowedValues: "SUPRAGLOTTIC_AIRWAY_PLACEMENT | TRACHEAL_INTUBATION_ORAL | TRACHEAL_INTUBATION_NASAL | DOUBLE_LUMEN_TUBE_PLACEMENT | ENDOBRONCHIAL_TUBE_PLACEMENT | SURGICAL_AIRWAY",
    missingnessRule: "No row = no instrumented airway recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "airwayDevices",
    versionIntroduced: "3.8.0",
  },
  {
    name: "cormackLehane",
    exportName: "measurement.value_as_concept_id (LOSPOR:CORMACK_LEHANE)",
    meaning: "Cormack-Lehane grade of the laryngoscopic view",
    type: "string",
    allowedValues: "I | IIa | IIb | III | IV",
    missingnessRule: "No row = not recorded, which is not the same as an easy view",
    sourceTable: "IntraoperativeRecord", sourceColumn: "cormackLehane",
    versionIntroduced: "3.8.0",
  },
  {
    name: "airwayTools",
    exportName: "observation.value_as_string (LOSPOR:AIRWAY_TOOL) + device_exposure.device_concept_id",
    // The device also leaves as a device_exposure row carrying its Device-domain concept, which is the CDM table for a thing that was in the patient. Both are emitted on purpose: the observation preserves the exact option the anaesthetist chose, and the device_exposure row is what a concept-set search can actually find.
    meaning: "Instruments and techniques used to secure the airway. One row per tool.",
    type: "string",
    allowedValues: "VIDEO_LARY | DIRECT_LARY | FOB | BOUGIE | STYLET | AWAKE | RETROGRADE | SUPRAGLOTTIC",
    missingnessRule: "No row = no tool recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "airwayTools",
    versionIntroduced: "3.8.0",
  },
  {
    name: "fob",
    exportName: "observation.value_as_string (LOSPOR:FIBREOPTIC_BRONCHOSCOPY)",
    meaning: "Fibreoptic bronchoscopy used. Recorded separately from the airwayTools list, which may also carry FOB.",
    type: "boolean",
    missingnessRule: "No row = not recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "fob",
    versionIntroduced: "3.8.0",
  },
  {
    name: "lmaSize",
    exportName: "observation.value_as_number (LOSPOR:LMA_SIZE)",
    meaning: "Supraglottic airway size. The picker offers 1, 1.5, 2, 2.5, 3, 4 and 5.",
    type: "float",
    allowedValues: "1–5",
    missingnessRule: "No row = no LMA, or size not recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "lmaSize",
    versionIntroduced: "3.8.0",
  },
  {
    name: "oralTubeSize",
    exportName: "measurement.value_as_number (LOSPOR:ORAL_TUBE_SIZE)",
    meaning: "Oral endotracheal tube internal diameter, offered in half sizes, "
      + "as LOINC 21491186 (Endotracheal tube Diameter), a Measurement-domain concept -- the same concept covers every tube whose diameter is recorded, and which tube it was stays in measurement_source_value. A size that will not parse as a number emits no row rather than a zero, since a tube of size zero does not exist.",
    unit: "mm",
    type: "float",
    allowedValues: "2–10",
    missingnessRule: "No row = no oral ETT, or size not recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "oralTubeSize",
    versionIntroduced: "3.8.0",
  },
  {
    name: "oralCuffed",
    exportName: "observation.value_as_string (LOSPOR:ORAL_TUBE_CUFFED)",
    meaning: "Whether the oral endotracheal tube was cuffed",
    type: "boolean",
    missingnessRule: "No row = no oral ETT, or not recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "oralCuffed",
    versionIntroduced: "3.8.0",
  },
  {
    name: "nasalTubeSize",
    exportName: "measurement.value_as_number (LOSPOR:NASAL_TUBE_SIZE)",
    meaning: "Nasal endotracheal tube internal diameter, offered in half sizes, "
      + "as LOINC 21491186 (Endotracheal tube Diameter), a Measurement-domain concept -- the same concept covers every tube whose diameter is recorded, and which tube it was stays in measurement_source_value. A size that will not parse as a number emits no row rather than a zero, since a tube of size zero does not exist.",
    unit: "mm",
    type: "float",
    allowedValues: "2–10",
    missingnessRule: "No row = no nasal ETT, or size not recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "nasalTubeSize",
    versionIntroduced: "3.8.0",
  },
  {
    name: "nasalCuffed",
    exportName: "observation.value_as_string (LOSPOR:NASAL_TUBE_CUFFED)",
    meaning: "Whether the nasal endotracheal tube was cuffed",
    type: "boolean",
    missingnessRule: "No row = no nasal ETT, or not recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "nasalCuffed",
    versionIntroduced: "3.8.0",
  },
  {
    name: "dltType",
    exportName: "observation.value_as_string (LOSPOR:DLT_TYPE)",
    meaning: "Double lumen tube type",
    type: "string",
    allowedValues: "Carlens | Robertshaw",
    missingnessRule: "No row = no DLT, or not recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "dltType",
    versionIntroduced: "3.8.0",
  },
  {
    name: "dltSide",
    exportName: "observation.value_as_string (LOSPOR:DLT_SIDE)",
    meaning: "Side of the double lumen tube",
    type: "string",
    allowedValues: "Left | Right",
    missingnessRule: "No row = no DLT, or not recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "dltSide",
    versionIntroduced: "3.8.0",
  },
  {
    name: "dltSize",
    exportName: "observation.value_as_number (LOSPOR:DLT_SIZE)",
    meaning: "Double lumen tube size. The picker offers 26, 28, 32, 35, 37, 39 and 41.",
    unit: "Fr",
    type: "float",
    allowedValues: "20–50",
    missingnessRule: "No row = no DLT, or size not recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "dltSize",
    versionIntroduced: "3.8.0",
  },
  {
    name: "endobronchialSize",
    exportName: "observation.value_as_number (LOSPOR:ENDOBRONCHIAL_TUBE_SIZE)",
    meaning: "Endobronchial tube internal diameter, offered in half sizes.",
    unit: "mm",
    type: "float",
    allowedValues: "2–10",
    missingnessRule: "No row = no endobronchial tube, or size not recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "endobronchialSize",
    versionIntroduced: "3.8.0",
  },
  {
    name: "tubeSize",
    exportName: "measurement.value_as_number (LOSPOR:TUBE_SIZE_LEGACY)",
    meaning: "Airway device size from before per-device columns existed, shared by LMA and oral/nasal ETT. Exported under its own name because which device it describes cannot be recovered; it is the only size older rows carry.",
    type: "float",
    missingnessRule: "No row = not a legacy row, or size not recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "tubeSize",
    versionIntroduced: "3.8.0",
    allowedValues: "2–12",
  },
  {
    name: "cuffed",
    exportName: "observation.value_as_string (LOSPOR:TUBE_CUFFED_LEGACY)",
    meaning: "Cuff status from before per-device columns existed. See tubeSize.",
    type: "boolean",
    missingnessRule: "No row = not a legacy row, or not recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "cuffed",
    versionIntroduced: "3.8.0",
  },
  {
    name: "ventilationModes",
    exportName: "measurement.value_as_concept_id (LOSPOR:VENTILATION_MODE)",
    meaning: "Ventilation modes used during the case. One row per mode, since a case may move between them. Coded where the vocabulary has a concept for the mode (most do; PAV does not) -- the mode name is kept as text in value_source_value either way.",
    type: "string",
    missingnessRule: "No row = no mode recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "ventilationModes",
    versionIntroduced: "3.8.0",
  },
  {
    name: "ippv",
    exportName: "observation.value_as_string (LOSPOR:IPPV)",
    meaning: "Intermittent positive pressure ventilation used",
    type: "boolean",
    missingnessRule: "No row = not recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "ippv",
    versionIntroduced: "3.8.0",
  },
  {
    name: "jetVentilation",
    exportName: "observation.value_as_string (LOSPOR:JET_VENTILATION)",
    meaning: "Jet ventilation used",
    type: "boolean",
    missingnessRule: "No row = not recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "jetVentilation",
    versionIntroduced: "3.8.0",
  },
  {
    name: "presentsIntubated",
    exportName: "observation.value_as_concept_id (LOSPOR:PRESENTS_INTUBATED)",
    meaning: "The patient arrived with a tracheal tube already in place, put "
      + "there by somebody else. Exported as SNOMED 1340204 (History of event) "
      + "with value 4013354 (Insertion of endotracheal tube) -- the "
      + "decomposition Athena itself prescribes for the non-standard "
      + "\"Endotracheal tube present\" (4168966). No procedure_occurrence row "
      + "is written, because this team did not perform the intubation.",
    type: "boolean",
    missingnessRule: "No row = the patient did not arrive intubated, or it was not recorded. Only the positive assertion is exported; the airway rows themselves describe the ordinary case",
    derivationRule: "Independent of airwayNotApplicable and of the device and tool lists. A patient can arrive from the ICU already intubated AND have had no airway intervention here, which is both flags at once; and one who arrived with a tube may still have it exchanged, re-sited or removed, which is this team's work and appears as devices",
    sourceTable: "IntraoperativeRecord", sourceColumn: "presentsIntubated",
    versionIntroduced: "4.3.0",
  },
  {
    name: "airwayNotApplicable",
    exportName: "observation.value_as_concept_id (LOSPOR:AIRWAY_NOT_APPLICABLE)",
    meaning: "No airway intervention was performed at all -- a regional or "
      + "sedation case where the patient kept their own airway throughout. "
      + "Exported as SNOMED 4303568 (Airway management) answered 4188540 (No). "
      + "CDM has no way to record a procedure that did not happen, since a "
      + "procedure_occurrence row asserts that it did, so the negative is "
      + "carried as an observation -- the same shape ippv and jetVentilation use.",
    type: "boolean",
    missingnessRule: "No row = airway management was performed, or the question was not recorded. Only the positive assertion is exported",
    sourceTable: "IntraoperativeRecord", sourceColumn: "airwayNotApplicable",
    versionIntroduced: "4.3.0",
  },
  {
    name: "peepCmH2O",
    exportName: "measurement.value_as_number (LOSPOR:PEEP_CMH2O)",
    meaning: "Positive end-expiratory pressure, as LOINC 3022875 (Positive "
      + "end expiratory pressure setting Ventilator) -- the ventilator setting "
      + "an anaesthetist charts, not 3016226, the measured airway pressure. "
      + "Measurement domain.",
    unit: "cmH2O",
    type: "float",
    missingnessRule: "No row = not recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "peepCmH2O",
    versionIntroduced: "3.8.0",
    allowedValues: "0–40",
  },
  {
    name: "crystalloidsMl",
    exportName: "observation.value_as_number (LOSPOR:CRYSTALLOIDS_ML)",
    meaning: "Total crystalloid fluid administered intraoperatively. Unlike "
      + "colloidsMl and bloodMl this never gains a companion procedure fact: "
      + "SNOMED names the specific fluid (Hartmann's, dextrose, saline) and "
      + "this is a pooled total that does not say which, so every specific "
      + "concept could be false, and the generic alternative (4030886, "
      + "Intravenous infusion) is equally true of a drug or a transfusion and "
      + "would distinguish nothing.",
    unit: "mL",
    type: "integer",
    allowedValues: "0–50000",
    missingnessRule: "NULL = not recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "crystalloidsMl",
    versionIntroduced: "3.0.0",
  },
  {
    name: "colloidsMl",
    exportName: "observation.value_as_number (LOSPOR:COLLOIDS_ML)",
    meaning: "Total colloid fluid administered intraoperatively. The volume "
      + "stays uncoded -- PROCEDURE_OCCURRENCE has no volume column, in this "
      + "export or in the CDM spec, whose nearest field is an integer count "
      + "rather than a continuous measurement -- but a positive total also "
      + "emits a separate procedure_occurrence row, 44790654 (Intravenous "
      + "fluid colloid administration), stating the fact that colloid was "
      + "given. A recorded 0 emits neither the fact nor a false one: 0 means "
      + "none was given, not that it is unknown.",
    unit: "mL",
    type: "integer",
    allowedValues: "0–20000",
    missingnessRule: "NULL = not recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "colloidsMl",
    versionIntroduced: "3.0.0",
  },
  {
    name: "bloodMl",
    exportName: "observation.value_as_number (LOSPOR:BLOOD_PRODUCTS_ML)",
    meaning: "Total blood products administered intraoperatively. Same "
      + "pattern as colloidsMl: the volume stays uncoded, and a positive total "
      + "also emits procedure_occurrence 4024656 (Transfusion of blood "
      + "product) as a separate fact. A recorded 0 emits neither row.",
    unit: "mL",
    type: "integer",
    allowedValues: "0–20000",
    missingnessRule: "NULL = not recorded",
    sourceTable: "IntraoperativeRecord", sourceColumn: "bloodMl",
    versionIntroduced: "3.0.0",
  },
  {
    name: "urineMl",
    exportName: "measurement.value_as_number (LOSPOR:URINE_OUTPUT_ML)",
    meaning: "Urine output during the procedure, as LOINC 3014315 (Urine "
      + "output), unqualified -- not the 1-hour or 8-hour variants, which "
      + "assert a collection window this does not record. Measurement domain. "
      + "A recorded zero is exported as zero and a figure that was never "
      + "recorded emits no row at all.",
    unit: "mL",
    type: "integer",
    allowedValues: "0–20000",
    missingnessRule: "NULL = not measured",
    sourceTable: "IntraoperativeRecord", sourceColumn: "urineMl",
    versionIntroduced: "3.0.0",
  },
  {
    name: "bloodLossMl",
    exportName: "observation.value_as_number (LOSPOR:BLOOD_LOSS_ML)",
    meaning: "Estimated blood loss during the procedure",
    unit: "mL",
    type: "integer",
    allowedValues: "0–20000",
    missingnessRule: "NULL = not recorded (distinct from a recorded 0)",
    sourceTable: "IntraoperativeRecord", sourceColumn: "bloodLossMl",
    versionIntroduced: "4.2.0",
  },
  // ── Intraop events (vitals) ───────────────────────────────────────────────────
  {
    name: "event.systolic",
    exportName: "measurement.value_as_number (LOINC:8480-6)",
    meaning: "Intraoperative systolic blood pressure reading",
    unit: "mmHg",
    type: "integer",
    missingnessRule: "NULL = not recorded in this event",
    sourceTable: "CaseEvent", sourceColumn: "systolic",
    versionIntroduced: "3.0.0",
  },
  {
    name: "event.diastolic",
    exportName: "measurement.value_as_number (LOINC:8462-4)",
    meaning: "Intraoperative diastolic blood pressure reading",
    unit: "mmHg",
    type: "integer",
    missingnessRule: "NULL = not recorded in this event",
    sourceTable: "CaseEvent", sourceColumn: "diastolic",
    versionIntroduced: "3.0.0",
  },
  {
    name: "event.heartRate",
    exportName: "measurement.value_as_number (LOINC:8867-4)",
    meaning: "Intraoperative heart rate",
    unit: "bpm",
    type: "integer",
    missingnessRule: "NULL = not recorded in this event",
    sourceTable: "CaseEvent", sourceColumn: "heartRate",
    versionIntroduced: "3.0.0",
  },
  {
    name: "event.spO2",
    exportName: "measurement.value_as_number (LOINC:59408-5)",
    meaning: "Intraoperative peripheral oxygen saturation",
    unit: "%",
    type: "integer",
    missingnessRule: "NULL = not recorded",
    sourceTable: "CaseEvent", sourceColumn: "spO2",
    versionIntroduced: "3.0.0",
  },
  {
    name: "event.etco2",
    exportName: "measurement.value_as_number (LOINC:19889-5)",
    meaning: "End-tidal CO2",
    unit: "mmHg",
    type: "float",
    missingnessRule: "NULL = not recorded",
    sourceTable: "CaseEvent", sourceColumn: "etco2",
    versionIntroduced: "3.0.0",
  },
  {
    name: "event.temp",
    exportName: "measurement.value_as_number (LOINC:8310-5)",
    meaning: "Intraoperative temperature",
    unit: "°C",
    type: "float",
    missingnessRule: "NULL = not recorded",
    sourceTable: "CaseEvent", sourceColumn: "temp",
    versionIntroduced: "3.0.0",
  },
  {
    name: "event.fgfLitersPerMin",
    exportName: "observation.value_as_number (LOSPOR:FGF_L_PER_MIN)",
    meaning: "Fresh gas flow rate, as SNOMED 4108006 (Fresh gas flow). In "
      + "observation rather than measurement because that is the concept's own "
      + "OMOP domain, even though it reads as a number beside the inspired "
      + "oxygen measurement recorded from the same gas event.",
    unit: "L/min",
    type: "float",
    allowedValues: "0–100",
    missingnessRule: "NULL = not recorded",
    sourceTable: "CaseEvent", sourceColumn: "fgfLitersPerMin",
    versionIntroduced: "3.0.0",
  },
  {
    name: "event.fio2Percent",
    exportName: "measurement.value_as_number (LOINC:3150-0)",
    meaning: "Fraction of inspired oxygen",
    unit: "%",
    type: "float",
    allowedValues: "21–100",
    missingnessRule: "NULL = not recorded",
    sourceTable: "CaseEvent", sourceColumn: "fio2Percent",
    versionIntroduced: "3.0.0",
  },
  {
    name: "event.carrierGas",
    exportName: "observation.value_as_string (LOSPOR:CARRIER_GAS)",
    meaning: "Carrier gas used with oxygen",
    type: "enum",
    allowedValues: "'air'|'n2o'",
    missingnessRule: "NULL = not recorded",
    sourceTable: "CaseEvent", sourceColumn: "carrierGas",
    versionIntroduced: "3.0.0",
  },
  {
    name: "event.agentPercent",
    exportName: "measurement.value_as_number (LOSPOR:VOLATILE_AGENT_PERCENT)",
    meaning: "Volatile anaesthetic agent concentration, as SNOMED 4354275 "
      + "(Inspired anesthetic agent concentration) -- the dial setting, which "
      + "is what this records, rather than 4107998 (End tidal), a different "
      + "measured quantity, or the unqualified 4353943. Measurement domain.",
    unit: "%",
    type: "float",
    missingnessRule: "NULL = no volatile agent used or not recorded",
    sourceTable: "CaseEvent", sourceColumn: "agentPercent",
    versionIntroduced: "3.0.0",
  },
  // ── Intraop drug events ───────────────────────────────────────────────────────
  {
    name: "event.inn",
    exportName: "drug_exposure.drug_source_value",
    meaning: "International nonproprietary name of drug administered",
    type: "string",
    missingnessRule: "NULL = drug unidentified or not recorded",
    sourceTable: "CaseEvent", sourceColumn: "inn",
    versionIntroduced: "3.0.0",
  },
  {
    name: "event.atcCode",
    exportName: "drug_exposure.drug_concept_id (via ATC→OMOP map)",
    meaning: "ATC code of the administered drug, resolved at write time from "
      + "either the event itself or, for the fluid and volatile-agent surfaces "
      + "that carry no code of their own, a name lookup against the "
      + "intraoperative catalogue -- the same lookup a vocabulary re-seed can "
      + "re-run to bring an older row forward. drug_type_concept_id is "
      + "32818 (EHR administration record), and drug_source_value is prefixed "
      + "INTRAOP:. Both exist to distinguish this row from the same drug given "
      + "as a premedication (also 32818, prefixed PREMED: instead) or reported "
      + "as a home medication (32865, Patient self-report, no phase prefix): "
      + "OMOP's Type Concept vocabulary encodes where the data came from, not "
      + "which phase of anaesthetic care it happened in, so nothing about "
      + "drug_type_concept_id alone would tell a premedication apart from an "
      + "intraop dose of the same drug -- before this, they were the same "
      + "concept id, the same type, and the same source-value string.",
    unit: "ATC",
    type: "string",
    missingnessRule: "NULL = ATC code not available",
    sourceTable: "CaseEvent", sourceColumn: "atcCode",
    versionIntroduced: "3.0.0",
  },
  {
    name: "event.drugRoute",
    // Carried as the source value: LOSPOR has no reviewed mapping to the OMOP
    // route vocabulary, and route_concept_id is not emitted at all.
    exportName: "drug_exposure.route_source_value",
    meaning: "Administration route, as recorded",
    type: "string",
    missingnessRule: "NULL = not recorded",
    sourceTable: "CaseEvent", sourceColumn: "drugRoute",
    versionIntroduced: "3.0.0",
  },
  {
    name: "event.concentrationValue",
    exportName: "observation.value_as_number (LOSPOR:DRUG_CONCENTRATION)",
    meaning: "Numeric concentration selected when the drug was administered. The same row's value_as_string carries the canonical rendering with its unit, such as \"0.5%\"",
    type: "float",
    missingnessRule: "NULL = legacy event, no concentration required, or not recorded",
    sourceTable: "CaseEvent", sourceColumn: "concentrationValue",
    versionIntroduced: "3.1.0",
  },
  {
    name: "event.concentrationUnit",
    exportName: "observation.value_as_string (LOSPOR:DRUG_CONCENTRATION)",
    meaning: "Unit for the selected numeric concentration, including percent where applicable",
    type: "string",
    allowedValues: "PERCENT | MCG_PER_ML | MG_PER_ML | IU_PER_ML | MMOL_PER_ML | MEQ_PER_ML",
    missingnessRule: "NULL = legacy event, no concentration required, or not recorded",
    sourceTable: "CaseEvent", sourceColumn: "concentrationUnit",
    versionIntroduced: "3.1.0",
  },
  {
    name: "event.formulation",
    exportName: "observation.value_as_string (LOSPOR:DRUG_FORMULATION)",
    meaning: "Canonical local-anaesthetic density formulation",
    type: "string",
    allowedValues: "HYPOBARIC | ISOBARIC | HYPERBARIC",
    missingnessRule: "NULL = formulation not applicable or legacy event",
    sourceTable: "CaseEvent", sourceColumn: "formulation",
    versionIntroduced: "3.1.0",
  },
  {
    name: "event.calculationBasis",
    exportName: "observation.value_as_string (LOSPOR:DOSE_CALCULATION_BASIS)",
    meaning: "Body-size basis used to calculate the selected dose",
    type: "string",
    missingnessRule: "NULL = manual dose or legacy event",
    sourceTable: "CaseEvent", sourceColumn: "calculationBasis",
    versionIntroduced: "3.1.0",
  },
  {
    name: "event.calculationWeightKg",
    exportName: "measurement.value_as_number (LOSPOR:DOSE_CALCULATION_WEIGHT_KG)",
    meaning: "Frozen weight value used by the dose calculation",
    unit: "kg",
    type: "float",
    missingnessRule: "NULL = non-weight-based, manual, unavailable, or legacy event",
    sourceTable: "CaseEvent", sourceColumn: "calculationWeightKg",
    versionIntroduced: "3.1.0",
  },
  {
    name: "event.calculationMethod",
    exportName: "observation.value_as_string (LOSPOR:DOSE_CALCULATION_METHOD)",
    meaning: "Versioned method used to derive dose inputs, such as McLaren or Devine",
    type: "string",
    missingnessRule: "NULL = direct/manual calculation or legacy event",
    sourceTable: "CaseEvent", sourceColumn: "calculationMethod",
    versionIntroduced: "3.1.0",
  },
  {
    name: "event.clinicalRuleKey",
    exportName: "observation.value_as_string (LOSPOR:CLINICAL_RULE_KEY)",
    meaning: "Stable route-profile rule identifier used for the dose selection",
    type: "string",
    missingnessRule: "NULL = manual or legacy event",
    sourceTable: "CaseEvent", sourceColumn: "clinicalRuleKey",
    versionIntroduced: "3.1.0",
  },
  {
    name: "event.clinicalRuleVersion",
    exportName: "observation.value_as_string (LOSPOR:CLINICAL_RULE_VERSION)",
    meaning: "Immutable version of the selected route-profile rule",
    type: "string",
    missingnessRule: "NULL = manual or legacy event",
    sourceTable: "CaseEvent", sourceColumn: "clinicalRuleVersion",
    versionIntroduced: "3.1.0",
  },
  {
    name: "event.clinicalRuleSourceIds",
    exportName: "observation.value_as_string (LOSPOR:CLINICAL_RULE_SOURCE_IDS)",
    meaning: "Ordered immutable ruleset/source identifiers contributing to the selected rule",
    type: "json",
    missingnessRule: "NULL = manual or legacy event",
    sourceTable: "CaseEvent", sourceColumn: "clinicalRuleSourceIds",
    versionIntroduced: "3.1.0",
  },
  {
    name: "event.clinicalPresetId",
    exportName: "observation.value_as_string (LOSPOR:CLINICAL_PRESET_ID)",
    meaning: "Immutable effective ruleset snapshot identifier used when selecting the dose",
    type: "string",
    missingnessRule: "NULL = manual or legacy event",
    sourceTable: "CaseEvent", sourceColumn: "clinicalPresetId",
    versionIntroduced: "3.1.0",
  },
  {
    name: "event.clinicalPresetVersion",
    exportName: "observation.value_as_number (LOSPOR:CLINICAL_PRESET_VERSION)",
    meaning: "Version number of the effective ruleset snapshot",
    type: "integer",
    missingnessRule: "NULL = manual or legacy event",
    sourceTable: "CaseEvent", sourceColumn: "clinicalPresetVersion",
    versionIntroduced: "3.1.0",
  },
  {
    name: "event.clinicalPresetScope",
    exportName: "observation.value_as_string (LOSPOR:CLINICAL_PRESET_SCOPE)",
    meaning: "Scope from which the effective ruleset snapshot was selected",
    type: "enum",
    allowedValues: "PLATFORM | INSTITUTION | USER",
    missingnessRule: "NULL = manual or legacy event",
    sourceTable: "CaseEvent", sourceColumn: "clinicalPresetScope",
    versionIntroduced: "3.1.0",
  },
  {
    name: "event.rate",
    exportName: "drug_exposure.dose_unit_source_value (rate)",
    meaning: "Infusion rate",
    unit: "varies (e.g. mcg/kg/min)",
    type: "float",
    missingnessRule: "NULL = not an infusion or rate not recorded",
    sourceTable: "CaseEvent", sourceColumn: "rate",
    versionIntroduced: "3.0.0",
  },
  // ── Postop ────────────────────────────────────────────────────────────────────
  {
    name: "aldreteTotal",
    exportName: "measurement.value_as_number (LOSPOR:ALDRETE_TOTAL)",
    meaning: "Total modified Aldrete recovery score, as SNOMED 40488911 "
      + "(Modified Aldrete score). The five subscores it sums have no concept "
      + "of their own in this vocabulary -- only the total is a scored entity "
      + "in SNOMED, the same shape as RCRI's criteria -- so they stay "
      + "LOSPOR-only observations at concept 0.",
    type: "integer",
    allowedValues: "0–10",
    missingnessRule: "NULL = not all subscores recorded",
    derivationRule: "Sum of 5 Aldrete subscores (activity, respiration, circulation, consciousness, SpO2)",
    sourceTable: "PostoperativeRecord", sourceColumn: "aldreteTotal",
    versionIntroduced: "3.0.0",
  },
  {
    name: "aldreteActivity",
    exportName: "observation.value_as_number (LOSPOR:ALDRETE_ACTIVITY)",
    meaning: "Modified Aldrete activity subscore at PACU discharge",
    type: "integer",
    allowedValues: "0–2",
    missingnessRule: "NULL = this subscore was not recorded",
    sourceTable: "PostoperativeRecord", sourceColumn: "aldreteActivity",
    versionIntroduced: "4.0.0",
  },
  {
    name: "aldreteRespiration",
    exportName: "observation.value_as_number (LOSPOR:ALDRETE_RESPIRATION)",
    meaning: "Modified Aldrete respiration subscore at PACU discharge",
    type: "integer",
    allowedValues: "0–2",
    missingnessRule: "NULL = this subscore was not recorded",
    sourceTable: "PostoperativeRecord", sourceColumn: "aldreteRespiration",
    versionIntroduced: "4.0.0",
  },
  {
    name: "aldreteCirculation",
    exportName: "observation.value_as_number (LOSPOR:ALDRETE_CIRCULATION)",
    meaning: "Modified Aldrete circulation subscore at PACU discharge",
    type: "integer",
    allowedValues: "0–2",
    missingnessRule: "NULL = this subscore was not recorded",
    sourceTable: "PostoperativeRecord", sourceColumn: "aldreteCirculation",
    versionIntroduced: "4.0.0",
  },
  {
    name: "aldreteConsciousness",
    exportName: "observation.value_as_number (LOSPOR:ALDRETE_CONSCIOUSNESS)",
    meaning: "Modified Aldrete consciousness subscore at PACU discharge",
    type: "integer",
    allowedValues: "0–2",
    missingnessRule: "NULL = this subscore was not recorded",
    sourceTable: "PostoperativeRecord", sourceColumn: "aldreteConsciousness",
    versionIntroduced: "4.0.0",
  },
  {
    name: "aldreteSpO2",
    exportName: "observation.value_as_number (LOSPOR:ALDRETE_SPO2)",
    meaning: "Modified Aldrete spo2 subscore at PACU discharge",
    type: "integer",
    allowedValues: "0–2",
    missingnessRule: "NULL = this subscore was not recorded",
    sourceTable: "PostoperativeRecord", sourceColumn: "aldreteSpO2",
    versionIntroduced: "4.0.0",
  },
  {
    name: "recoveryTemperature",
    exportName: "measurement.value_as_number (POSTOP_LOINC:8310-5)",
    meaning: "Temperature at PACU exit",
    unit: "Cel",
    type: "float",
    allowedValues: "25–45",
    missingnessRule: "Blank with value_as_concept_id 618772 = the reading was attempted and could not be obtained. Blank with an empty value_as_concept_id = nobody recorded it. The recovery-room flags work exactly as the preoperative ones do, and the same warning applies: pooling the two drops the patients who were hardest to measure",
    sourceTable: "PostoperativeRecord", sourceColumn: "temperatureCelsius",
    versionIntroduced: "4.0.0",
  },
  {
    name: "postop.complication",
    exportName: "observation.value_as_string (LOSPOR:POSTOP_COMPLICATION)",
    meaning: "A complication recorded against the postoperative period, with its note where one was written. Emitted here only when the complication has no reviewed OMOP concept yet; a curated one reaches condition_occurrence instead (condition_source_value carries LOSPOR_COMPLICATION:<item>).",
    type: "string",
    missingnessRule: "No row = no complication recorded for this case; absence is not evidence none occurred",
    sourceTable: "CaseComplication", sourceColumn: "label",
    versionIntroduced: "4.0.0",
  },
  {
    name: "postop.complication.note",
    exportName: "observation.value_as_string (LOSPOR:POSTOP_COMPLICATION_NOTE)",
    meaning: "The free-text note on a complication that DOES have a reviewed OMOP concept. condition_occurrence has no column for it, so it stays a companion observation alongside the coded condition row, redacted the same way every other free-text field in this export is.",
    type: "string",
    missingnessRule: "No row = either no complication was recorded, or the recorded complication carried no note",
    sourceTable: "CaseComplication", sourceColumn: "note",
    versionIntroduced: "4.3.0",
  },
  {
    name: "event.fiAirPercent",
    exportName: "measurement.value_as_number (LOSPOR:FIAIR_PERCENT)",
    meaning: "Inspired air fraction of the fresh gas mixture",
    unit: "%",
    type: "float",
    allowedValues: "0–100",
    missingnessRule: "NULL = not recorded for this gas setting",
    sourceTable: "CaseEvent", sourceColumn: "fiAirPercent",
    versionIntroduced: "4.0.0",
  },
  {
    name: "event.fiN2OPercent",
    exportName: "observation.value_as_number (LOSPOR:FIN2O_PERCENT)",
    meaning: "Inspired nitrous oxide fraction of the fresh gas mixture, as "
      + "SNOMED 4354273 (Inspired nitrous oxide concentration). Observation "
      + "domain, unlike the inspired oxygen recorded from the same event, "
      + "which is a Measurement-domain LOINC concept -- the split follows the "
      + "vocabulary, not this export.",
    unit: "%",
    type: "float",
    allowedValues: "0–100",
    missingnessRule: "NULL = not recorded for this gas setting",
    sourceTable: "CaseEvent", sourceColumn: "fiN2OPercent",
    versionIntroduced: "4.0.0",
  },
  {
    name: "monitoring.ecg",
    exportName: "procedure_occurrence.procedure_concept_id (LOSPOR:INTRAOP_MONITORING)",
    meaning: "ECG monitoring was used for this case. Coded as 4187078. The row lands in PROCEDURE_OCCURRENCE because that is the concept's own OMOP domain -- monitoring modalities are not all one domain, and a procedure of monitoring, an observation about the patient and a measurement are different claims.",
    type: "boolean",
    missingnessRule: "No row = the modality was not selected. Absence is not evidence it was unused: only a positive selection is recorded, so this cannot distinguish a case that did not use it from one where nobody ticked it",
    sourceTable: "CaseSelection", sourceColumn: "value",
    versionIntroduced: "4.3.0",
  },
  {
    name: "monitoring.spO2Monitor",
    exportName: "observation.value_as_concept_id (LOSPOR:INTRAOP_MONITORING)",
    meaning: "Pulse oximetry was used for this case. Coded as 4155650. The row lands in OBSERVATION because that is the concept's own OMOP domain -- monitoring modalities are not all one domain, and a procedure of monitoring, an observation about the patient and a measurement are different claims.",
    type: "boolean",
    missingnessRule: "No row = the modality was not selected. Absence is not evidence it was unused: only a positive selection is recorded, so this cannot distinguish a case that did not use it from one where nobody ticked it",
    sourceTable: "CaseSelection", sourceColumn: "value",
    versionIntroduced: "4.3.0",
  },
  {
    name: "monitoring.nbpMonitor",
    exportName: "observation.value_as_concept_id (LOSPOR:INTRAOP_MONITORING)",
    meaning: "Non-invasive arterial pressure was used for this case. Coded as 4064646. The row lands in OBSERVATION because that is the concept's own OMOP domain -- monitoring modalities are not all one domain, and a procedure of monitoring, an observation about the patient and a measurement are different claims.",
    type: "boolean",
    missingnessRule: "No row = the modality was not selected. Absence is not evidence it was unused: only a positive selection is recorded, so this cannot distinguish a case that did not use it from one where nobody ticked it",
    sourceTable: "CaseSelection", sourceColumn: "value",
    versionIntroduced: "4.3.0",
  },
  {
    name: "monitoring.etco2Monitor",
    exportName: "observation.value_as_string (LOSPOR:INTRAOP_MONITORING)",
    meaning: "Capnography was used for this case. No standard concept exists for this in the vocabulary on this appliance, which is genuinely surprising for a modality this routine -- it is a confirmed gap rather than an oversight, and the row carries concept 0 with its name in the source value so it is still findable.",
    type: "boolean",
    missingnessRule: "No row = the modality was not selected. Absence is not evidence it was unused: only a positive selection is recorded, so this cannot distinguish a case that did not use it from one where nobody ticked it",
    sourceTable: "CaseSelection", sourceColumn: "value",
    versionIntroduced: "4.3.0",
  },
  {
    name: "monitoring.tempMonitor",
    exportName: "observation.value_as_concept_id (LOSPOR:INTRAOP_MONITORING)",
    meaning: "Temperature monitoring was used for this case. Coded as 4045951. The row lands in OBSERVATION because that is the concept's own OMOP domain -- monitoring modalities are not all one domain, and a procedure of monitoring, an observation about the patient and a measurement are different claims.",
    type: "boolean",
    missingnessRule: "No row = the modality was not selected. Absence is not evidence it was unused: only a positive selection is recorded, so this cannot distinguish a case that did not use it from one where nobody ticked it",
    sourceTable: "CaseSelection", sourceColumn: "value",
    versionIntroduced: "4.3.0",
  },
  {
    name: "monitoring.invasiveBP",
    exportName: "observation.value_as_concept_id (LOSPOR:INTRAOP_MONITORING)",
    meaning: "Invasive arterial pressure was used for this case. Coded as 4301474. The row lands in OBSERVATION because that is the concept's own OMOP domain -- monitoring modalities are not all one domain, and a procedure of monitoring, an observation about the patient and a measurement are different claims.",
    type: "boolean",
    missingnessRule: "No row = the modality was not selected. Absence is not evidence it was unused: only a positive selection is recorded, so this cannot distinguish a case that did not use it from one where nobody ticked it",
    sourceTable: "CaseSelection", sourceColumn: "value",
    versionIntroduced: "4.3.0",
  },
  {
    name: "monitoring.cvpMonitor",
    exportName: "observation.value_as_concept_id (LOSPOR:INTRAOP_MONITORING)",
    meaning: "Central venous pressure was used for this case. Coded as 4313586. The row lands in OBSERVATION because that is the concept's own OMOP domain -- monitoring modalities are not all one domain, and a procedure of monitoring, an observation about the patient and a measurement are different claims.",
    type: "boolean",
    missingnessRule: "No row = the modality was not selected. Absence is not evidence it was unused: only a positive selection is recorded, so this cannot distinguish a case that did not use it from one where nobody ticked it",
    sourceTable: "CaseSelection", sourceColumn: "value",
    versionIntroduced: "4.3.0",
  },
  {
    name: "monitoring.paCatheter",
    exportName: "observation.value_as_concept_id (LOSPOR:INTRAOP_MONITORING)",
    meaning: "Pulmonary artery catheter was used for this case. Coded as 4076945. The row lands in OBSERVATION because that is the concept's own OMOP domain -- monitoring modalities are not all one domain, and a procedure of monitoring, an observation about the patient and a measurement are different claims.",
    type: "boolean",
    missingnessRule: "No row = the modality was not selected. Absence is not evidence it was unused: only a positive selection is recorded, so this cannot distinguish a case that did not use it from one where nobody ticked it",
    sourceTable: "CaseSelection", sourceColumn: "value",
    versionIntroduced: "4.3.0",
  },
  {
    name: "monitoring.tee",
    exportName: "procedure_occurrence.procedure_concept_id (LOSPOR:INTRAOP_MONITORING)",
    meaning: "Transoesophageal echocardiography was used for this case. Coded as 4019824. The row lands in PROCEDURE_OCCURRENCE because that is the concept's own OMOP domain -- monitoring modalities are not all one domain, and a procedure of monitoring, an observation about the patient and a measurement are different claims.",
    type: "boolean",
    missingnessRule: "No row = the modality was not selected. Absence is not evidence it was unused: only a positive selection is recorded, so this cannot distinguish a case that did not use it from one where nobody ticked it",
    sourceTable: "CaseSelection", sourceColumn: "value",
    versionIntroduced: "4.3.0",
  },
  {
    name: "monitoring.bis",
    exportName: "observation.value_as_string (LOSPOR:INTRAOP_MONITORING)",
    meaning: "Bispectral index was used for this case. No standard concept exists for this in the vocabulary on this appliance, which is genuinely surprising for a modality this routine -- it is a confirmed gap rather than an oversight, and the row carries concept 0 with its name in the source value so it is still findable.",
    type: "boolean",
    missingnessRule: "No row = the modality was not selected. Absence is not evidence it was unused: only a positive selection is recorded, so this cannot distinguish a case that did not use it from one where nobody ticked it",
    sourceTable: "CaseSelection", sourceColumn: "value",
    versionIntroduced: "4.3.0",
  },
  {
    name: "monitoring.entropyMonitor",
    exportName: "observation.value_as_string (LOSPOR:INTRAOP_MONITORING)",
    meaning: "Entropy was used for this case. No standard concept exists for this in the vocabulary on this appliance, which is genuinely surprising for a modality this routine -- it is a confirmed gap rather than an oversight, and the row carries concept 0 with its name in the source value so it is still findable.",
    type: "boolean",
    missingnessRule: "No row = the modality was not selected. Absence is not evidence it was unused: only a positive selection is recorded, so this cannot distinguish a case that did not use it from one where nobody ticked it",
    sourceTable: "CaseSelection", sourceColumn: "value",
    versionIntroduced: "4.3.0",
  },
  {
    name: "monitoring.nirsMonitor",
    exportName: "measurement.measurement_concept_id (LOSPOR:INTRAOP_MONITORING)",
    meaning: "Cerebral oximetry (NIRS) was used for this case. Coded as 37206739. The row lands in MEASUREMENT because that is the concept's own OMOP domain -- monitoring modalities are not all one domain, and a procedure of monitoring, an observation about the patient and a measurement are different claims.",
    type: "boolean",
    missingnessRule: "No row = the modality was not selected. Absence is not evidence it was unused: only a positive selection is recorded, so this cannot distinguish a case that did not use it from one where nobody ticked it",
    sourceTable: "CaseSelection", sourceColumn: "value",
    versionIntroduced: "4.3.0",
  },
  {
    name: "monitoring.evokedPotentials",
    exportName: "observation.value_as_concept_id (LOSPOR:INTRAOP_MONITORING)",
    meaning: "Evoked potentials was used for this case. Coded as 4154582. The row lands in OBSERVATION because that is the concept's own OMOP domain -- monitoring modalities are not all one domain, and a procedure of monitoring, an observation about the patient and a measurement are different claims.",
    type: "boolean",
    missingnessRule: "No row = the modality was not selected. Absence is not evidence it was unused: only a positive selection is recorded, so this cannot distinguish a case that did not use it from one where nobody ticked it",
    sourceTable: "CaseSelection", sourceColumn: "value",
    versionIntroduced: "4.3.0",
  },
  {
    name: "monitoring.tofMonitor",
    exportName: "observation.value_as_concept_id (LOSPOR:INTRAOP_MONITORING)",
    meaning: "Neuromuscular monitoring (TOF) was used for this case. Coded as 4152647. The row lands in OBSERVATION because that is the concept's own OMOP domain -- monitoring modalities are not all one domain, and a procedure of monitoring, an observation about the patient and a measurement are different claims.",
    type: "boolean",
    missingnessRule: "No row = the modality was not selected. Absence is not evidence it was unused: only a positive selection is recorded, so this cannot distinguish a case that did not use it from one where nobody ticked it",
    sourceTable: "CaseSelection", sourceColumn: "value",
    versionIntroduced: "4.3.0",
  },
  {
    name: "monitoring.urinaryCatheter",
    exportName: "observation.value_as_concept_id (LOSPOR:INTRAOP_MONITORING)",
    meaning: "Urine output was used for this case. Coded as 44813911. The row lands in OBSERVATION because that is the concept's own OMOP domain -- monitoring modalities are not all one domain, and a procedure of monitoring, an observation about the patient and a measurement are different claims.",
    type: "boolean",
    missingnessRule: "No row = the modality was not selected. Absence is not evidence it was unused: only a positive selection is recorded, so this cannot distinguish a case that did not use it from one where nobody ticked it",
    sourceTable: "CaseSelection", sourceColumn: "value",
    versionIntroduced: "4.3.0",
  },
  {
    name: "monitoring.stomachTube",
    exportName: "procedure_occurrence.procedure_concept_id (LOSPOR:INTRAOP_MONITORING)",
    meaning: "Nasogastric tube was used for this case. Coded as 4227418. The row lands in PROCEDURE_OCCURRENCE because that is the concept's own OMOP domain -- monitoring modalities are not all one domain, and a procedure of monitoring, an observation about the patient and a measurement are different claims.",
    type: "boolean",
    missingnessRule: "No row = the modality was not selected. Absence is not evidence it was unused: only a positive selection is recorded, so this cannot distinguish a case that did not use it from one where nobody ticked it",
    sourceTable: "CaseSelection", sourceColumn: "value",
    versionIntroduced: "4.3.0",
  },
  {
    name: "monitoring",
    exportName: "observation.value_as_string (LOSPOR:INTRAOP_MONITORING)",
    meaning: "One row per monitoring modality selected for the case, from the institution's option library. This is the default table for a curated modality's own OMOP domain; a handful route elsewhere by the same 'domain governs table' rule complications follow -- ECG, TEE and nasogastric tube are Procedure-domain concepts and reach procedure_occurrence (procedure_source_value carries the same LOSPOR:INTRAOP_MONITORING code) and cerebral oximetry (NIRS) is Measurement-domain and reaches measurement (measurement_source_value). A modality with no reviewed concept still lands in observation with observation_concept_id 0.",
    type: "string",
    missingnessRule: "No row = that modality was not selected",
    sourceTable: "CaseSelection", sourceColumn: "value",
    versionIntroduced: "4.0.0",
  },
  {
    name: "premedication",
    exportName: "observation.value_as_string (LOSPOR:PREMEDICATION_PHASE) + procedure_occurrence.procedure_concept_id",
    meaning: "Premedication recorded for the case, by phase (evening before "
      + "or morning of surgery). Each row also emits a procedure_occurrence "
      + "fact, 4169397 (Premedication for anesthetic procedure) -- the phase "
      + "observation says when, the drug_exposure row (see premedicationRows) "
      + "says what, and this says the clinical act itself occurred.",
    type: "string",
    missingnessRule: "No row = no premedication recorded for that phase",
    sourceTable: "IntraoperativeRecord", sourceColumn: "premedicationEvening / premedicationMorning",
    versionIntroduced: "4.0.0",
  },
  {
    name: "premedicationRows",
    exportName: "drug_exposure.drug_concept_id (via ATC→OMOP map)",
    meaning: "The premedication drug itself, as an administration -- the phase "
      + "entry above records when, this records what and gives it a coded "
      + "concept where an ATC code resolves one. drug_type_concept_id is "
      + "32818 (EHR administration record), the same as an intraop dose,  "
      + "because both are witnessed administrations rather than a patient's "
      + "self-reported history; drug_source_value carries a PREMED: prefix so "
      + "the two remain distinguishable despite sharing a type -- see "
      + "event.atcCode for why drug_type_concept_id alone cannot do that job.",
    type: "concept_id",
    missingnessRule: "No row = no premedication drug recorded for that phase",
    sourceTable: "IntraoperativeRecord", sourceColumn: "premedicationRows",
    versionIntroduced: "4.0.0",
  },
  {
    name: "lab.result",
    exportName: "measurement.value_as_number (LOINC:<code>, or LAB:<test name> where unmapped)",
    meaning: "A laboratory result, preoperative or drawn during the case. The source value carries the LOINC code when the analyte is mapped, and the laboratory's own test name when it is not. Preoperative and intraoperative results are the same clinical object and share this row shape; they are told apart by measurement_datetime, and at source by LabResult.section.",
    type: "float",
    missingnessRule: "No row = that analyte was not resulted; the set of analytes varies by case",
    derivationRule: "One row per LabResult. Unmapped analytes keep their source name rather than being dropped. measurement_datetime is the specimen's own takenAt where one was recorded, falling back to the record's date when it was not -- so repeated intraoperative draws of the same analyte stay distinguishable, and a falling trend is visible.",
    sourceTable: "LabResult", sourceColumn: "value",
    versionIntroduced: "4.0.0",
  },
  {
    name: "ageValue",
    exportName: "observation.value_as_string (LOSPOR:AGE_AT_PROCEDURE_EXACT)",
    meaning: "Age at operation as it was recorded, with its own unit — a neonate is charted in days, not as a fraction of a year",
    type: "string",
    allowedValues: "e.g. \"14 DAYS\", \"7 MONTHS\", \"5 YEARS\"",
    missingnessRule: "No row = an exact age with a unit was not recorded; ageYears may still be present",
    sourceTable: "PreoperativeAssessment", sourceColumn: "ageValue / ageUnit",
    versionIntroduced: "4.0.0",
  },
  {
    name: "ageApproxDays",
    exportName: "observation.value_as_number (LOSPOR:AGE_AT_PROCEDURE_APPROX_DAYS)",
    meaning: "Age at operation normalised to days, so ages recorded in different units can be compared or banded",
    unit: "days",
    type: "integer",
    missingnessRule: "No row = age was not recorded",
    derivationRule: "Months are converted at 30.436875 days and years at 365.2425, so a value is approximate by design",
    sourceTable: "PreoperativeAssessment", sourceColumn: "ageApproxDays",
    versionIntroduced: "4.0.0",
  },
  {
    name: "bodySurfaceAreaM2",
    exportName: "measurement.value_as_number (LOSPOR:BODY_SURFACE_AREA_M2)",
    meaning: "Body surface area, used where a dose is prescribed per square "
      + "metre rather than per kilogram, as LOINC 3005424 (Body surface area) "
      + "in square metres (unit 8617). In measurement rather than observation "
      + "because that is the concept's own OMOP domain.",
    unit: "m2",
    type: "float",
    allowedValues: "0.01–5",
    missingnessRule: "No row = height or weight was missing, so it could not be derived",
    derivationRule: "Mosteller formula from height and weight",
    sourceTable: "PreoperativeAssessment", sourceColumn: "bodySurfaceAreaM2",
    versionIntroduced: "4.0.0",
  },
  {
    name: "povocScore",
    exportName: "observation.value_as_number (LOSPOR:POVOC_SCORE)",
    meaning: "Postoperative vomiting in children risk score",
    type: "integer",
    allowedValues: "0–4",
    missingnessRule: "No row = not scored for this case",
    sourceTable: "PreoperativeAssessment", sourceColumn: "povocScore",
    versionIntroduced: "4.0.0",
  },
  {
    name: "povocRiskPercent",
    exportName: "observation.value_as_number (LOSPOR:POVOC_RISK_PERCENT)",
    meaning: "Predicted risk of postoperative vomiting corresponding to the POVOC score",
    unit: "%",
    type: "float",
    allowedValues: "0–100",
    missingnessRule: "No row = no POVOC score, so no predicted risk",
    derivationRule: "Derived from povocScore; it is a prediction, not an observed outcome",
    sourceTable: "PreoperativeAssessment", sourceColumn: "povocRiskPercent",
    versionIntroduced: "4.0.0",
  },
  {
    name: "coldsScore",
    exportName: "observation.value_as_number (LOSPOR:COLDS_SCORE)",
    meaning: "COLDS score: perioperative respiratory risk in a child with a current or recent upper respiratory infection",
    type: "integer",
    allowedValues: "5–25",
    missingnessRule: "No row = not scored; a child with no respiratory infection is not scored rather than scored zero",
    sourceTable: "PreoperativeAssessment", sourceColumn: "coldsScore",
    versionIntroduced: "4.0.0",
  },
  {
    name: "paedScore",
    exportName: "observation.value_as_number (LOSPOR:PAED_SCORE)",
    meaning: "Paediatric Anaesthesia Emergence Delirium scale, scored in recovery",
    type: "integer",
    allowedValues: "0–20",
    missingnessRule: "No row = not scored in recovery",
    sourceTable: "PostoperativeRecord", sourceColumn: "paedScore",
    versionIntroduced: "4.0.0",
  },
  {
    name: "pediatricPainScore.FLACC",
    exportName: "measurement.value_as_number (LOSPOR:PEDIATRIC_PAIN_FLACC_0_10)",
    meaning: "Paediatric pain score on the FLACC scale, as SNOMED 3037051 "
      + "(FLACC pain assessment panel). Face, Legs, Activity, Cry, "
      + "Consolability — observed by staff, for a child too young or unwell to "
      + "self-report. In measurement rather than observation, because SNOMED "
      + "puts this concept in the Measurement domain -- FPS-R below stays in "
      + "observation because the vocabulary puts that one there instead; the "
      + "split is the vocabulary's own choice.",
    type: "integer",
    allowedValues: "0–10",
    missingnessRule: "No row = no pain score recorded on this scale for this case",
    derivationRule: "The scale is part of the code because a score of 4 is not the same finding on an observed scale as on a self-reported one; the three are not interchangeable",
    sourceTable: "PostoperativeRecord", sourceColumn: "pediatricPainScore",
    versionIntroduced: "4.0.0",
  },
  {
    name: "pediatricPainScore.FPS_R",
    exportName: "observation.value_as_number (LOSPOR:PEDIATRIC_PAIN_FPS_R_0_10)",
    meaning: "Paediatric pain score on the FPS-R scale, as SNOMED 40760807 "
      + "(Pain severity FPS-R). Faces Pain Scale-Revised — the child chooses a "
      + "face, so it is self-reported.",
    type: "integer",
    allowedValues: "0–10",
    missingnessRule: "No row = no pain score recorded on this scale for this case",
    derivationRule: "The scale is part of the code because a score of 4 is not the same finding on an observed scale as on a self-reported one; the three are not interchangeable",
    sourceTable: "PostoperativeRecord", sourceColumn: "pediatricPainScore",
    versionIntroduced: "4.0.0",
  },
  {
    name: "pediatricPainScore.NRS",
    exportName: "measurement.value_as_number (LOSPOR:PEDIATRIC_PAIN_NRS_0_10)",
    meaning: "Paediatric pain score on the NRS scale. Numeric Rating Scale — the child states a number, so it is self-reported",
    type: "integer",
    allowedValues: "0–10",
    missingnessRule: "No row = no pain score recorded on this scale for this case",
    derivationRule: "The scale is part of the code because a score of 4 is not the same finding on an observed scale as on a self-reported one; the three are not interchangeable",
    sourceTable: "PostoperativeRecord", sourceColumn: "pediatricPainScore",
    versionIntroduced: "4.0.0",
  },
  {
    name: "pediatricFasting",
    exportName: "observation.observation_concept_id (LOSPOR:PEDIATRIC_FASTING_ASSESSMENT)",
    meaning: "The recorded fasting assessment for a child, as a JSON object of the fasting intervals entered",
    type: "json",
    missingnessRule: "No row = no fasting assessment was recorded",
    sourceTable: "PreoperativeAssessment", sourceColumn: "pediatricFasting",
    versionIntroduced: "4.0.0",
  },
  {
    name: "clinicalRulesVersion",
    exportName: "observation.value_as_string (LOSPOR:CLINICAL_RULES_VERSION)",
    meaning: "Version of the clinical ruleset snapshot the case was documented against, which fixes the doses the chart was suggesting at the time",
    type: "string",
    missingnessRule: "No row = the case predates ruleset versioning",
    sourceTable: "Case", sourceColumn: "clinicalRulesVersion",
    versionIntroduced: "4.0.0",
  },
  {
    name: "painScoreNRS",
    exportName: "measurement.value_as_number (LOINC:72514-3)",
    meaning: "Numeric Rating Scale pain score at PACU discharge, as LOINC "
      + "43055141 (Pain severity - 0-10 verbal numeric rating [Score] - "
      + "Reported). Previously exported at concept 0 with a note that no "
      + "reviewed mapping existed, which was true of the vocabulary bundle "
      + "shipping at the time; the concept is standard and Measurement-domain, "
      + "so the row moved out of observation. pediatricPainScore.NRS carries "
      + "the same concept -- it is the same scale.",
    type: "integer",
    allowedValues: "0–10",
    missingnessRule: "NULL = not assessed",
    sourceTable: "PostoperativeRecord", sourceColumn: "painScoreNRS",
    versionIntroduced: "3.0.0",
  },
  {
    name: "ponv",
    exportName: "condition_occurrence.condition_concept_id (LOSPOR:PONV)",
    meaning: "Post-operative nausea and vomiting present in PACU, as SNOMED "
      + "4032472 (Postoperative nausea and vomiting). Moved from an "
      + "observation into condition_occurrence: this is a condition that "
      + "occurred, not an observation about one, the same domain routing "
      + "already used for comorbidities and diagnoses.",
    type: "boolean",
    missingnessRule: "No row = not recorded or not present -- only a positive finding is exported, the same rule as every other 'recorded only when present' field",
    sourceTable: "PostoperativeRecord", sourceColumn: "ponv",
    versionIntroduced: "3.0.0",
  },
  {
    name: "disposition",
    exportName: "observation.observation_concept_id (LOSPOR:DISPOSITION)",
    meaning: "Patient destination after PACU: WARD codes to SNOMED 4142136 "
      + "(Discharge to ward), ICU to 4138933 (Admission to intensive care "
      + "unit). Each is its own fact rather than an answer to one shared "
      + "question concept -- the two are different SNOMED concepts with "
      + "nothing standard linking them the way Yes/No links an answer to a "
      + "question. PACU has no concept in this vocabulary: the nearest match, "
      + "'Post Anesthesia Care Unit' (45880582), is a Meas Value/Answer "
      + "concept rather than a fact that belongs in observation_concept_id, "
      + "and nothing else names remaining in recovery as an event, so it stays "
      + "at 0.",
    type: "enum",
    allowedValues: "'WARD'|'PACU'|'ICU'",
    missingnessRule: "NULL = not recorded",
    sourceTable: "PostoperativeRecord", sourceColumn: "disposition",
    versionIntroduced: "3.0.0",
  },
  {
    name: "recoveryBpSystolic",
    exportName: "measurement.value_as_number (POSTOP_LOINC:8480-6)",
    meaning: "Systolic BP at PACU exit",
    unit: "mmHg",
    type: "integer",
    allowedValues: "10–300",
    missingnessRule: "Blank with value_as_concept_id 618772 = the reading was attempted and could not be obtained. Blank with an empty value_as_concept_id = nobody recorded it. The recovery-room flags work exactly as the preoperative ones do, and the same warning applies: pooling the two drops the patients who were hardest to measure",
    sourceTable: "PostoperativeRecord", sourceColumn: "recoveryBpSystolic",
    versionIntroduced: "3.0.0",
  },
  {
    name: "recoveryBpDiastolic",
    exportName: "measurement.value_as_number (POSTOP_LOINC:8462-4)",
    meaning: "Diastolic BP at PACU exit",
    unit: "mmHg",
    type: "integer",
    allowedValues: "5–200",
    missingnessRule: "Blank with value_as_concept_id 618772 = the reading was attempted and could not be obtained. Blank with an empty value_as_concept_id = nobody recorded it. The recovery-room flags work exactly as the preoperative ones do, and the same warning applies: pooling the two drops the patients who were hardest to measure",
    sourceTable: "PostoperativeRecord", sourceColumn: "recoveryBpDiastolic",
    versionIntroduced: "3.0.0",
  },
  {
    name: "recoveryHeartRate",
    exportName: "measurement.value_as_number (POSTOP_LOINC:8867-4)",
    meaning: "Heart rate at PACU exit",
    unit: "bpm",
    type: "integer",
    allowedValues: "10–350",
    missingnessRule: "Blank with value_as_concept_id 618772 = the reading was attempted and could not be obtained. Blank with an empty value_as_concept_id = nobody recorded it. The recovery-room flags work exactly as the preoperative ones do, and the same warning applies: pooling the two drops the patients who were hardest to measure",
    sourceTable: "PostoperativeRecord", sourceColumn: "recoveryHeartRate",
    versionIntroduced: "3.0.0",
  },
  {
    name: "recoverySpO2",
    exportName: "measurement.value_as_number (POSTOP_LOINC:59408-5)",
    meaning: "SpO2 at PACU exit",
    unit: "%",
    type: "integer",
    allowedValues: "0–100",
    missingnessRule: "Blank with value_as_concept_id 618772 = the reading was attempted and could not be obtained. Blank with an empty value_as_concept_id = nobody recorded it. The recovery-room flags work exactly as the preoperative ones do, and the same warning applies: pooling the two drops the patients who were hardest to measure",
    sourceTable: "PostoperativeRecord", sourceColumn: "recoverySpO2",
    versionIntroduced: "3.0.0",
  },
  // ── Coded rows (condition, procedure, drug, measurement) ──────────────────────
  {
    name: "diagnosis.standardConceptId",
    exportName: "condition_occurrence.condition_concept_id",
    meaning: "OMOP standard concept ID for the diagnosis (SNOMED preferred)",
    unit: "OMOP concept_id",
    type: "concept_id",
    missingnessRule: "0 = no confident OMOP mapping; source vocabulary row preserved",
    sourceTable: "PreopDiagnosis", sourceColumn: "standardConceptId",
    versionIntroduced: "3.0.0",
  },
  {
    name: "procedure.standardConceptId",
    exportName: "procedure_occurrence.procedure_concept_id",
    meaning: "OMOP standard concept ID for the planned procedure",
    unit: "OMOP concept_id",
    type: "concept_id",
    missingnessRule: "0 = no confident OMOP mapping; source vocabulary row preserved",
    sourceTable: "PreopProcedure", sourceColumn: "standardConceptId",
    versionIntroduced: "3.0.0",
  },
  {
    name: "lab.loincCode",
    exportName: "measurement.measurement_concept_id (via LOINC→OMOP map)",
    meaning: "LOINC code for the laboratory test",
    unit: "LOINC",
    type: "string",
    missingnessRule: "NULL = no LOINC mapping available for this test",
    sourceTable: "LabResult", sourceColumn: "loincCode",
    versionIntroduced: "3.0.0",
  },
  {
    name: "lab.valueNum",
    exportName: "measurement.value_as_number",
    meaning: "Numeric result of the laboratory test",
    type: "float",
    missingnessRule: "NULL = non-numeric result or not recorded",
    sourceTable: "LabResult", sourceColumn: "valueNum",
    versionIntroduced: "3.0.0",
  },
  {
    name: "lab.unitCanon",
    exportName: "measurement.unit_source_value",
    meaning: "Canonical unit for the lab result",
    type: "string",
    missingnessRule: "NULL = unit not available",
    sourceTable: "LabResult", sourceColumn: "unitCanon",
    versionIntroduced: "3.0.0",
  },
]
