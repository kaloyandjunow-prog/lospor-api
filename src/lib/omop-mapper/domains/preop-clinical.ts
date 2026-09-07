import type { CaseMapperCtx } from "../case-context"
import type { CaseRow } from "../types"
import {
  ASA_CLASS_CONCEPTS, NECK_MOBILITY_CONCEPTS, UNOBTAINABLE_CONCEPT_ID,
  VITAL_CONCEPTS, YES_CONCEPT_ID, NO_CONCEPT_ID, AIRWAY_MEASUREMENTS,
  bloodGroupConceptFor,
} from "../concepts"
import { isoDate } from "../date-helpers"
import { nextId } from "../ids"

/** Preoperative vitals, labs, comorbidities, diagnoses, risk scores and findings. */
export function mapPreopClinicalToOmop(
  ctx: CaseMapperCtx,
  c: CaseRow,
  preop: NonNullable<CaseRow["preop"]>,
): void {
  const vitDate = isoDate(c.createdAt)
  if (preop.ageValue != null && preop.ageUnit) {
    ctx.sourceObservation("LOSPOR:AGE_AT_PROCEDURE_EXACT", `${preop.ageValue} ${preop.ageUnit}`, vitDate)
  }
  ctx.sourceObservation("LOSPOR:AGE_AT_PROCEDURE_APPROX_DAYS", preop.ageApproxDays, vitDate)
  // 3005424, Body surface area -- a Measurement-domain concept, so it
  // moves out of observation.
  ctx.sourceMeasurement("LOSPOR:BODY_SURFACE_AREA_M2", preop.bodySurfaceAreaM2, 3005424, 8617, "m2", vitDate)
  // Age as a measurement rather than an untyped observation, because it is
  // a quantity with a standard concept and a unit.
  //
  // OMOP tooling normally derives age from person.year_of_birth and a visit
  // date, and would here too -- but this register deliberately coarsens the
  // birth year, so the recorded age is the more precise of the two and is
  // worth carrying in its own right.
  if (preop.ageYears != null) {
    ctx.measurements.push({
      measurement_id:              nextId(),
      person_id:                   ctx.personId,
      measurement_concept_id:      4314456,
      measurement_date:            vitDate,
      measurement_datetime:        vitDate,
      measurement_type_concept_id: 32817,
      value_as_number:             preop.ageYears,
      value_as_concept_id:         null,
      unit_concept_id:             9448,
      unit_source_value:           "a",
      measurement_source_value:    "LOSPOR:AGE_YEARS",
      value_source_value:          String(preop.ageYears),
      range_low:                   null,
      range_high:                  null,
      visit_occurrence_id:         ctx.visitId,
    })
  }
  // Urgency is not emitted here. It is a modifier on the planned procedure
  // -- 4093606 Emergency or 4013731 Elective -- which is where a statement
  // about how an operation was performed belongs. This used to emit the
  // same fact a second time as an observation at concept 0, so a query that
  // counted both would have counted every emergency case twice. It also
  // still appears as the conventional "E" suffix on the ASA class below,
  // which is a display convention rather than a second row.
  // An RCRI criterion, and the one that is not a patient condition — the
  // other four are ordinary diagnoses and reach condition_occurrence as
  // themselves. RCRI defines this by operation type (intraperitoneal,
  // intrathoracic, suprainguinal vascular), which SNOMED has no concept
  // for; this is the nearest and says "at increased risk" rather than
  // "high-risk operation", so it is an approximation and the dictionary
  // says so. It stays an observation because urgency owns the procedure's
  // modifier column, and because a statement about risk is about the
  // patient rather than about how the operation was performed.
  ctx.sourceObservation("LOSPOR:HIGH_RISK_SURGERY", preop.highRiskSurgery, vitDate, null, 4250613)
  ctx.sourceObservation("LOSPOR:POVOC_SCORE", preop.povocScore, vitDate)
  ctx.sourceObservation("LOSPOR:POVOC_RISK_PERCENT", preop.povocRiskPercent, vitDate)
  ctx.sourceObservation("LOSPOR:COLDS_SCORE", preop.coldsScore, vitDate)

  // The five COLDS factors, and the gate that says the score applies.
  //
  // Same fault as the four adult risk scores had until this release: the
  // total exported and the factors did not, so a COLDS of 4 never said
  // whether it was the two-week-old coryza or the tracheal tube. COLDS
  // decides whether a child with a runny nose is postponed, which makes
  // the factors the part worth pooling across cases.
  //
  // The five are nullable strings, so an absent one is genuinely absent.
  // coldsApplicable is not -- it is Boolean (false), so a false
  // means "either not applicable or nobody looked", and exporting it would
  // assert the first. Only a true is emitted, and it means the assessment
  // was made.
  if (preop.coldsApplicable) {
    ctx.sourceObservation("LOSPOR:COLDS_APPLICABLE", true, vitDate, null, 0, YES_CONCEPT_ID)
  }
  ctx.sourceObservation("LOSPOR:COLDS_CURRENT_SYMPTOMS", preop.coldsCurrentSymptoms, vitDate)
  ctx.sourceObservation("LOSPOR:COLDS_ONSET", preop.coldsOnset, vitDate)
  ctx.sourceObservation("LOSPOR:COLDS_LUNG_DISEASE", preop.coldsLungDisease, vitDate)
  ctx.sourceObservation("LOSPOR:COLDS_AIRWAY_DEVICE", preop.coldsAirwayDevice, vitDate)
  ctx.sourceObservation("LOSPOR:COLDS_SURGERY", preop.coldsSurgery, vitDate)
  // 3031632, Fasting status - Reported: the question is coded, and the
  // JSON detail of which intervals were fasted stays in the value, since
  // no vocabulary models a per-interval fasting assessment.
  ctx.sourceObservation(
    "LOSPOR:PEDIATRIC_FASTING_ASSESSMENT",
    preop.pediatricFasting == null ? null : JSON.stringify(preop.pediatricFasting),
    vitDate,
    null,
    3031632,
  )
  // One flag can qualify more than one reading: a blood pressure that could
  // not be obtained is neither a systolic nor a diastolic, so both rows
  // carry the qualifier. Height and weight have no flag — a case cannot
  // reach the intraoperative form without them.
  const vitalMap: [keyof typeof VITAL_CONCEPTS, number | null | undefined, boolean][] = [
    ["systolic",        preop.bpSystolic,      Boolean(preop.bpUnobtainable)],
    ["diastolic",       preop.bpDiastolic,     Boolean(preop.bpUnobtainable)],
    ["heartRate",       preop.heartRate,       Boolean(preop.heartRateUnobtainable)],
    ["spO2",            preop.spO2,            Boolean(preop.spO2Unobtainable)],
    ["temp",            preop.temperature,     Boolean(preop.temperatureUnobtainable)],
    ["respiratoryRate", preop.respiratoryRate, Boolean(preop.respiratoryRateUnobtainable)],
    ["heightCm",        preop.heightCm,        false],
    ["weightKg",        preop.weightKg,        false],
  ]
  for (const [key, val, unobtainable] of vitalMap) {
    // A recorded value wins over the flag: if a number is present the
    // measurement was obtained, whatever the tickbox says.
    if (val == null && !unobtainable) continue
    const cfg = VITAL_CONCEPTS[key]
    ctx.measurements.push({
      measurement_id:            nextId(),
      person_id:                 ctx.personId,
      measurement_concept_id:    cfg.concept_id,
      measurement_date:          vitDate,
      measurement_datetime:      vitDate,
      measurement_type_concept_id: 32817,
      value_as_number:           val ?? null,
      value_as_concept_id:       val == null ? UNOBTAINABLE_CONCEPT_ID : null,
      unit_concept_id:           cfg.unitConceptId,
      unit_source_value:         cfg.unit,
      measurement_source_value:  `${cfg.system ?? "LOINC"}:${cfg.code}`,
      // Vitals carry no source text and no laboratory reference range.
      value_source_value:        null,
      range_low:                 null,
      range_high:                null,
      visit_occurrence_id:       ctx.visitId,
    })
  }

  // ── Lab results from LabResult rows -> MEASUREMENT ────────────────────
  // Use SQL LabResult rows (LOINC-coded) instead of raw JSON
  ctx.emitLabRows(preop.labRows ?? [], vitDate)

  // ── Comorbidities -> CONDITION_OCCURRENCE ─────────────────────────────
  for (const co of preop.comorbidityRows ?? []) {
    ctx.trackMapping(co.mappingStatus)
    ctx.conditions.push({
      condition_occurrence_id:    nextId(),
      person_id:                 ctx.personId,
      condition_concept_id:      co.standardConceptId ?? 0,
      condition_start_date:      isoDate(c.createdAt),
      condition_type_concept_id: 32817,
      condition_source_value:    ctx.sourceValue("COMORBIDITY", co.sourceVocabulary, co.sourceCode, co.labelEn ?? co.labelBg ?? co.label),
      visit_occurrence_id:       ctx.visitId,
    })
  }

  // Primary diagnosis -> CONDITION_OCCURRENCE
  const diagRows = preop.diagnoses ?? []
  if (diagRows.length > 0) {
    for (const diag of diagRows) {
      ctx.trackMapping(diag.mappingStatus)
      ctx.conditions.push({
        condition_occurrence_id:    nextId(),
        person_id:                 ctx.personId,
        condition_concept_id:      diag.standardConceptId ?? 0,
        condition_start_date:      isoDate(c.createdAt),
        condition_type_concept_id: 32817,
        condition_source_value:    ctx.sourceValue("DIAGNOSIS", diag.sourceVocabulary, diag.sourceCode, diag.labelEn ?? diag.labelBg ?? diag.label),
        visit_occurrence_id:       ctx.visitId,
      })
    }
  } else if (preop.diagnosis) {
    ctx.conditions.push({
      condition_occurrence_id:    nextId(),
      person_id:                 ctx.personId,
      condition_concept_id:      0,
      condition_start_date:      isoDate(c.createdAt),
      condition_type_concept_id: 32817,
      condition_source_value:    preop.diagnosis,
      visit_occurrence_id:       ctx.visitId,
    })
  }

  // ── Observations: ASA, RCRI, Apfel, STOP-BANG, airway ───────────────
  const preopDate = isoDate(c.createdAt)
  if (preop.asaScore) {
    ctx.measurements.push({
      measurement_id:              nextId(),
      person_id:                   ctx.personId,
      // The scale, with the class as a coded answer — the same shape the
      // airway grades use, and the shape ASA has in SNOMED.
      //
      // This replaces observation_concept_id 4173987, which was on every
      // exported ASA class and is "Ethacrynic acid overdose". It is a
      // standard, valid concept, so nothing automated objected; only
      // reading the concept's name catches it. Every existing dataset
      // carries that error and is keyed by LOSPOR:ASA_CLASS, which is why
      // the source value is unchanged.
      measurement_concept_id:      4199571,
      measurement_date:            preopDate,
      measurement_datetime:        preopDate,
      measurement_type_concept_id: 32817,
      value_as_number:             null,
      value_as_concept_id:         ASA_CLASS_CONCEPTS[String(preop.asaScore)] ?? 0,
      unit_concept_id:             0,
      unit_source_value:           null,
      range_low:                   null,
      range_high:                  null,
      // The E suffix is kept as reported, but it is not what carries the
      // urgency: emergencySurgery exports separately as a procedure. There
      // is no ASA-with-E concept, and inventing one from the two would be a
      // claim the vocabulary does not make.
      value_source_value:       preop.asaScore + (preop.emergencySurgery ? "E" : ""),
      measurement_source_value: "LOSPOR:ASA_CLASS",
      visit_occurrence_id:      ctx.visitId,
    })
  }
  // The risk scores are counts of risk factors: they are summed, banded and
  // thresholded, so they belong in value_as_number.
  // Two of the five scores have a concept of their own, so they leave as
  // measurements a tool can find. SNOMED models each as a single scale with
  // no decomposition — there is no concept for "RCRI criterion 2" — which
  // is why the criteria themselves are exported as the ordinary conditions
  // they are, and reconstructing the score means looking for those.
  for (const [key, concept, value] of [
    ["LOSPOR:RCRI", 40488922, preop.rcriScore],
    ["LOSPOR:STOP_BANG", 46286812, preop.stopBangScore],
  ] as const) {
    if (value == null) continue
    ctx.measurements.push({
      measurement_id:              nextId(),
      person_id:                   ctx.personId,
      measurement_concept_id:      concept,
      measurement_date:            preopDate,
      measurement_datetime:        preopDate,
      measurement_type_concept_id: 32817,
      value_as_number:             value,
      value_as_concept_id:         0,
      unit_concept_id:             0,
      unit_source_value:           null,
      range_low:                   null,
      range_high:                  null,
      value_source_value:          String(value),
      measurement_source_value:    key,
      visit_occurrence_id:         ctx.visitId,
    })
  }
  // Apfel, POVOC and COLDS have no concept in any vocabulary here — the
  // near matches are all postoperative vomiting itself, which is the
  // outcome these predict rather than the prediction. They stay source
  // values, and their components are the route to making them poolable.
  ctx.sourceObservation("LOSPOR:APFEL", preop.apfelScore, preopDate)

  // The factors behind the four scores.
  //
  // Every total above exported and not one factor did, so a researcher
  // could read an RCRI of 3 and never learn which three. For validating or
  // recalibrating a risk model in a new population -- which is a register
  // is for -- the factors are the data and the total is the derivation.
  //
  // Emitted as answers rather than as findings: value_as_concept_id says
  // yes or no, so a false is a recorded negative rather than an absence.
  // All sixteen columns are nullable, so null still means nobody asked and
  // sourceObservation skips it.
  //
  // No question concept yet. Several of these are real SNOMED conditions
  // and could carry one, but a concept per factor is sixteen individual
  // verifications and guessing at them would be worse than a source value
  // that is at least honest about being LOSPOR's own.
  const riskFactor = (source: string, value: boolean | null | undefined) => {
    if (value == null) return
    ctx.sourceObservation(source, value, preopDate, null, 0, value ? YES_CONCEPT_ID : NO_CONCEPT_ID)
  }
  riskFactor("LOSPOR:RCRI_ISCHEMIC_HEART", preop.rcriIschemicHeart)
  riskFactor("LOSPOR:RCRI_CHF", preop.rcriCHF)
  riskFactor("LOSPOR:RCRI_CVD", preop.rcriCVD)
  riskFactor("LOSPOR:RCRI_INSULIN_DM", preop.rcriInsulinDM)
  riskFactor("LOSPOR:RCRI_CREATININE", preop.rcriCreatinine)
  riskFactor("LOSPOR:APFEL_PONV_HISTORY", preop.apfelPONVHistory)
  riskFactor("LOSPOR:APFEL_POSTOP_OPIOIDS", preop.apfelPostopOpioids)
  riskFactor("LOSPOR:STOPBANG_SNORING", preop.stopbangSnoring)
  riskFactor("LOSPOR:STOPBANG_TIRED", preop.stopbangTired)
  riskFactor("LOSPOR:STOPBANG_OBSERVED_APNOEA", preop.stopbangObserved)
  riskFactor("LOSPOR:STOPBANG_BP", preop.stopbangBP)
  riskFactor("LOSPOR:STOPBANG_NECK", preop.stopbangNeck)
  riskFactor("LOSPOR:POVOC_SURGERY_30_MIN", preop.povocSurgeryAtLeast30Minutes)
  riskFactor("LOSPOR:POVOC_AGE_3_YEARS", preop.povocAgeAtLeast3Years)
  riskFactor("LOSPOR:POVOC_STRABISMUS", preop.povocStrabismusSurgery)
  riskFactor("LOSPOR:POVOC_HISTORY", preop.povocHistory)
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
  // The finding as the question, answered Yes or No.
  //
  // The vocabulary's own shape for a history is a pair — "History of
  // difficult intubation" (4175851) maps to "History of event" with this
  // concept as the value — and it is not used here, deliberately. That pair
  // can only say a difficult intubation happened; a documented "no known
  // difficult airway" would have to be expressed by the absence of a row,
  // which is indistinguishable from never having asked.
  //
  // For this field that distinction is the point. A previous difficult
  // intubation outweighs every bedside test, so an anaesthetist who asked
  // and was told no has recorded something another anaesthetist will rely
  // on, and it has to survive the export as a finding rather than a gap.
  ctx.sourceObservation("LOSPOR:DIFFICULT_AIRWAY_HISTORY", preop.difficultAirwayHistory, preopDate, null, 37397718,
    preop.difficultAirwayHistory ? YES_CONCEPT_ID : NO_CONCEPT_ID)
  // Mallampati is a graded scale: the grade is the answer, so it goes in
  // value_as_concept_id rather than being flattened to text. SNOMED has a
  // dedicated concept for a score that could not be assessed, which is more
  // specific than the generic Unobtainable qualifier and is used instead.
  ctx.emitAirwayGrade("mallampati", preop.mallampati, preopDate, Boolean(preop.airwayUnobtainable))

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
  // Tobacco smoking status. The field is a plain yes/no, which is what this
  // register records, so the answer stays in value_as_string rather than
  // being forced into a smoker/former/never value concept it does not have.
  // Tobacco smoking status, answered Yes or No rather than with a value
  // concept of its own. "Never smoked" would assert what the form did not
  // ask: this boolean means "not currently smoking", which is true of the
  // never-smoker and the ex-smoker alike, and they carry different
  // perioperative risk.
  ctx.sourceObservation("LOSPOR:SMOKING", preop.smoking, preopDate, null, 43054909,
    preop.smoking ? YES_CONCEPT_ID : NO_CONCEPT_ID)
  // Answered Yes or No rather than asserted, so a denial is recorded as a
  // denial and an unasked question stays absent.
  ctx.sourceObservation("LOSPOR:SUBSTANCE_ABUSE", preop.substanceAbuse, preopDate, null, 4234597,
    preop.substanceAbuse ? YES_CONCEPT_ID : NO_CONCEPT_ID)
  // One row, answered Yes or No.
  //
  // The question concept comes from the non-standard "Allergy to latex"
  // (604826) through its Maps to. That source concept also has a Maps to
  // value — the RxNorm ingredient — and the OHDSI convention is to put both
  // halves in one row: the target concept in the question, the value
  // concept in the answer. An earlier attempt here emitted them as two
  // rows, which is not what the pair means and made one latex-allergic
  // patient count twice under observation_concept_id 43530807.
  //
  // The allergen is therefore in the source value rather than coded, which
  // is the cost of answering Yes or No instead. It is worth paying: a
  // denial is a documented safety check a theatre acts on, and coding the
  // substance in the answer would leave "latex allergy: no" with nothing to
  // say and no way to tell it from a question nobody asked.
  ctx.sourceObservation("LOSPOR:LATEX_ALLERGY", preop.latexAllergy, preopDate, null, 43530807,
    preop.latexAllergy ? YES_CONCEPT_ID : NO_CONCEPT_ID)
  // "Complication of anesthesia" rather than malignant hyperthermia, which
  // is what this used to carry. The question is the broader one a
  // pre-assessment asks — it catches suxamethonium apnoea, a family
  // pattern of difficult intubation, severe PONV — and coding all of that
  // as an MH history would put a specific and frightening claim on records
  // where the family reported something else. The detail beside it carries
  // what was actually reported.
  ctx.sourceObservation("LOSPOR:FAMILY_ANAESTHESIA_PROBLEMS", preop.familyAnesthesiaProblems, preopDate, null, 764557,
    preop.familyAnesthesiaProblems ? YES_CONCEPT_ID : NO_CONCEPT_ID)
  ctx.sourceObservation("LOSPOR:FAMILY_ANAESTHESIA_DETAILS", preop.familyAnesthesiaDetails, preopDate)
  // "Dental prosthesis" rather than any of the denture concepts, because
  // the question is broader than dentures: crowns, caps and bridges are
  // what a laryngoscope chips, and dental damage is the commonest claim
  // against an anaesthetist. A denture-specific concept would miss the
  // patient with anterior crowns, who is the higher risk of the two.
  ctx.sourceObservation("LOSPOR:DENTAL_PROSTHETICS", preop.dentalProsthetics, preopDate, null, 3029182,
    preop.dentalProsthetics ? YES_CONCEPT_ID : NO_CONCEPT_ID)
  // "Abnormal tooth mobility", which is what the question means and what
  // makes a No worth recording: no abnormal mobility found. The neutral
  // "Tooth mobility" concept would leave a No saying nothing.
  ctx.sourceObservation("LOSPOR:LOOSE_TEETH", preop.looseTeeth, preopDate, null, 4002000,
    preop.looseTeeth ? YES_CONCEPT_ID : NO_CONCEPT_ID)
  // The umbrella, which is the level the question asks at: atrial
  // fibrillation, flutter, block and ectopics all answer it. "Irregular
  // heart beat" is what a patient reports rather than what a
  // pre-assessment records, and the irregularly-irregular pulse is one
  // arrhythmia rather than the class.
  ctx.sourceObservation("LOSPOR:HEART_ARRHYTHMIA", preop.heartArrhythmia, preopDate, null, 44784217,
    preop.heartArrhythmia ? YES_CONCEPT_ID : NO_CONCEPT_ID)

  // "History of allergies, reported", which is the question a
  // pre-assessment actually asks, and it takes a Yes or a No.
  //
  // Named allergens do leave, one DRUG_ALLERGY observation per substance
  // off the medication list. What that cannot carry is the negative: a
  // patient asked and found to have no allergies produces no allergen
  // rows and no detail text, so without this the export cannot tell a
  // documented "no known allergies" from a question nobody put. The column
  // is Boolean? precisely so a recorded No is a real answer, and it is the
  // answer a theatre acts on when choosing a relaxant.
  //
  // Not 43530807, which the latex flag below already uses: a researcher
  // counting that concept would otherwise count a latex-allergic patient
  // twice and have only the source value to separate them.
  ctx.sourceObservation("LOSPOR:ALLERGY_PRESENT", preop.allergies, preopDate, null, 3013237,
    preop.allergies ? YES_CONCEPT_ID : NO_CONCEPT_ID)
  // The free-text detail carries allergens that were never resolved to a
  // drug -- redacted upstream like every other note.
  ctx.sourceObservation("LOSPOR:ALLERGY_DETAILS", preop.allergyDetails, preopDate)

  // Body mass index is stored, not derived at export time, because the
  // height and weight it was computed from may since have been corrected.
  // Body mass index as a measurement rather than an observation, because it
  // is a quantity with a standard concept and a unit. Stored rather than
  // recomputed at export time, since the height and weight it came from may
  // since have been corrected.
  if (preop.bmi != null) {
    ctx.measurements.push({
      measurement_id:              nextId(),
      person_id:                   ctx.personId,
      measurement_concept_id:      4245997,
      measurement_date:            preopDate,
      measurement_datetime:        preopDate,
      measurement_type_concept_id: 32817,
      value_as_number:             preop.bmi,
      value_as_concept_id:         0,
      // 9531, UCUM kg/m2.
      unit_concept_id:             9531,
      unit_source_value:           "kg/m2",
      range_low:                   null,
      range_high:                  null,
      value_source_value:          String(preop.bmi),
      measurement_source_value:    "LOSPOR:BMI",
      visit_occurrence_id:         ctx.visitId,
    })
  }

  // ABO and Rh as one fact, which is how a blood group is read and how a
  // crossmatch query wants it. Two rows would say "group A" and "Rh
  // positive" as separate findings, and SNOMED has a concept for each of
  // the eight combinations, so there is no reason to split them.
  const bloodGroupConcept = bloodGroupConceptFor(preop.bloodType, preop.rhFactor)
  if (preop.bloodType || preop.rhFactor) {
    const groupText = `${preop.bloodType ?? "?"}${
      preop.rhFactor === "POSITIVE" ? "+" : preop.rhFactor === "NEGATIVE" ? "-" : "?"}`
    ctx.measurements.push({
      measurement_id:              nextId(),
      person_id:                   ctx.personId,
      measurement_concept_id:      3003694,
      measurement_date:            preopDate,
      measurement_datetime:        preopDate,
      measurement_type_concept_id: 32817,
      value_as_number:             null,
      // 0 when only one half was recorded: "A, Rh unknown" is not one of
      // the eight, and guessing the other half would invent a crossmatch.
      value_as_concept_id:         bloodGroupConcept,
      unit_concept_id:             0,
      unit_source_value:           null,
      range_low:                   null,
      range_high:                  null,
      value_source_value:          groupText,
      measurement_source_value:    "LOSPOR:BLOOD_GROUP",
      visit_occurrence_id:         ctx.visitId,
    })
  }
  ctx.sourceObservation("LOSPOR:GUTA_SCORE", preop.gutaScore, preopDate)

  // ── The airway examination ───────────────────────────────────────────
  //
  // Distinct from the difficult-airway history: this is what the
  // anaesthetist found on examining this patient, and it is what a
  // predictive study needs alongside the Cormack-Lehane grade the intraop
  // record now carries.
  // The two airway distances are quantities with standard concepts, so they
  // are measurements now rather than LOSPOR-only observations. When the
  // examination could not be performed they carry the same Unobtainable
  // qualifier the vitals use.
  const airwayNotAssessable = Boolean(preop.airwayUnobtainable)
  const airwayDistances: [keyof typeof AIRWAY_MEASUREMENTS, number | null | undefined][] = [
    ["mouthOpeningCm", preop.mouthOpeningCm],
    ["thyromental", preop.thyromental],
  ]
  for (const [key, val] of airwayDistances) {
    if (val == null && !airwayNotAssessable) continue
    const cfg = AIRWAY_MEASUREMENTS[key]
    ctx.measurements.push({
      measurement_id:              nextId(),
      person_id:                   ctx.personId,
      measurement_concept_id:      cfg.concept_id,
      measurement_date:            preopDate,
      measurement_datetime:        preopDate,
      measurement_type_concept_id: 32817,
      value_as_number:             val ?? null,
      value_as_concept_id:         val == null ? UNOBTAINABLE_CONCEPT_ID : null,
      unit_concept_id:             cfg.unitConceptId,
      unit_source_value:           cfg.unit,
      measurement_source_value:    cfg.source,
      value_source_value:          null,
      range_low:                   null,
      range_high:                  null,
      visit_occurrence_id:         ctx.visitId,
    })
  }
  // Neck mobility as a graded scale, like the other airway grades: the
  // examination is the question and the range found is the coded answer.
  // SNOMED's cervical-movement values are an exact fit for the three the
  // form offers, and an unassessable airway takes the same Unobtainable
  // qualifier the distances above use rather than the string it carried.
  if (preop.neckMobility != null || airwayNotAssessable) {
    ctx.measurements.push({
      measurement_id:              nextId(),
      person_id:                   ctx.personId,
      measurement_concept_id:      4039256,
      measurement_date:            preopDate,
      measurement_datetime:        preopDate,
      measurement_type_concept_id: 32817,
      value_as_number:             null,
      value_as_concept_id: preop.neckMobility == null
        ? UNOBTAINABLE_CONCEPT_ID
        : NECK_MOBILITY_CONCEPTS[preop.neckMobility] ?? 0,
      unit_concept_id:             0,
      unit_source_value:           null,
      measurement_source_value:    "LOSPOR:NECK_MOBILITY",
      value_source_value:          preop.neckMobility ?? null,
      range_low:                   null,
      range_high:                  null,
      visit_occurrence_id:         ctx.visitId,
    })
  }
  // The upper lip bite test has no concept in any vocabulary here. Two
  // searches, lexical and semantic, returned nothing above 0.75 and the
  // best of those was "Functional tests in the oral cavity" — a French
  // procedure code for something else. It stays a source value.
  ctx.sourceObservation("LOSPOR:UPPER_LIP_BITE_TEST", preop.upperLipBiteTest, preopDate)
  if (airwayNotAssessable) {
    // The upper lip bite test has no standard concept, so its
    // unassessability is carried the way its values are — as a source
    // value. Neck mobility no longer needs this: it carries the
    // Unobtainable qualifier in its own row above.
    ctx.sourceObservation("LOSPOR:UPPER_LIP_BITE_TEST", "unobtainable", preopDate)
  }
  ctx.sourceObservation("LOSPOR:RETROGNATHIA", preop.retrognathia, preopDate, null, 4142490,
    preop.retrognathia ? YES_CONCEPT_ID : NO_CONCEPT_ID)
  // "Protrusion of tooth", which is the finding the assessor made. An
  // earlier pass here concluded no concept existed and left this at 0; that
  // was a search that only tried dysmorphology phrasings and came back with
  // HPO entries this product does not ship. The plain SNOMED term was there
  // the whole time.
  //
  // Not "Horizontal overbite", which is the orthodontic measurement every
  // mouth has some of, and not "Prominent maxilla", which is the jaw rather
  // than the teeth the laryngoscope meets.
  ctx.sourceObservation("LOSPOR:PROMINENT_INCISORS", preop.prominentIncisors, preopDate, null, 4033016,
    preop.prominentIncisors ? YES_CONCEPT_ID : NO_CONCEPT_ID)
  // Deliberately uncoded, and this is the record of why rather than an
  // omission waiting to be tidied up.
  //
  // The vocabulary has nothing for facial hair as a clinical finding. What
  // it has is anatomy — "Structure of beard hair" — which would say
  // "beard hair structure: present" and be looked for by nobody. The
  // tempting bridge is "Failed mask ventilation", which is standard and
  // real and would be flatly false: that is an outcome, and a beard is a
  // predictor of one.
  //
  // A beard is recorded here for exactly one reason, mask seal, and the
  // conclusion it feeds — whether difficulty is anticipated — is the thing
  // worth coding. This stays a source value beneath it.
  ctx.sourceObservation("LOSPOR:FACIAL_HAIR", preop.facialHair, preopDate)
  ctx.sourceObservation("LOSPOR:DIFFICULT_AIRWAY_NOTES", preop.difficultAirwayNotes, preopDate)
  // "At increased risk for difficult tracheal intubation" rather than
  // "Expected difficult tracheal intubation", which is the closer wording
  // and the weaker claim. What the assessor puts in this box is a
  // prediction from bedside tests, and bedside tests predict poorly: most
  // patients flagged here are intubated without trouble. A risk statement
  // is what the evidence supports, and it is also what stays true when the
  // intubation turns out to be easy -- an expectation the case then
  // contradicts reads, in a database, like an error rather than a
  // precaution that paid off.
  //
  // Its outcome counterpart is 37397717, Unexpected difficult airway, which
  // nothing writes yet.
  ctx.sourceObservation("LOSPOR:ANTICIPATED_DIFFICULT_AIRWAY", preop.anticipatedDifficultAirway, preopDate, null,
    37159176, preop.anticipatedDifficultAirway ? YES_CONCEPT_ID : NO_CONCEPT_ID)
  // Malignant hyperthermia in this patient, as distinct from the family
  // history above. A personal MH history is the one anaesthetic fact that
  // changes the whole plan -- no volatile agent, no suxamethonium, a
  // flushed machine -- and it had no field at all until now, so a patient
  // who told the assessor could only have it written into free text.
  ctx.sourceObservation("LOSPOR:MALIGNANT_HYPERTHERMIA_HISTORY", preop.malignantHyperthermiaHistory, preopDate, null,
    440285, preop.malignantHyperthermiaHistory ? YES_CONCEPT_ID : NO_CONCEPT_ID)
  // "Complication due to anesthesia during surgery" -- the operative
  // setting is part of what is being asked. The unqualified umbrella
  // (4142195) would also admit a reaction to a dental local, which is a
  // different and much weaker signal than something going wrong in theatre.
  //
  // The field exists for the events nobody could explain afterwards, so it
  // is deliberately not coded as a drug reaction: naming a cause is exactly
  // what the record cannot do.
  ctx.sourceObservation("LOSPOR:UNEXPLAINED_ANAESTHESIA_COMPLICATIONS", preop.unexplainedAnaesthesiaComplications,
    preopDate, null, 37017043,
    preop.unexplainedAnaesthesiaComplications ? YES_CONCEPT_ID : NO_CONCEPT_ID)
}
