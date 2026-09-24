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
/**
 * One condition row per standard concept. OMOP decomposes some ICD-10
 * combination codes (E11.2: type 2 diabetes, and a kidney disorder due to it),
 * and the OMOP way to record that is a row for each, sharing the source value.
 */
function conditionConceptIds(row: { standardConceptId?: number | null; standardConceptIds?: number[] }): number[] {
  return row.standardConceptIds?.length ? row.standardConceptIds : [row.standardConceptId ?? 0]
}

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
  // Whether COLDS applied at all is a catalogue question and leaves with the
  // other answers below.
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
    for (const conceptId of conditionConceptIds(co)) {
      ctx.conditions.push({
        condition_occurrence_id:    nextId(),
        person_id:                 ctx.personId,
        condition_concept_id:      conceptId,
        condition_start_date:      isoDate(c.createdAt),
        condition_type_concept_id: 32817,
        condition_source_value:    ctx.sourceValue("COMORBIDITY", co.sourceVocabulary, co.sourceCode, co.labelEn ?? co.labelBg ?? co.label),
        visit_occurrence_id:       ctx.visitId,
      })
    }
  }

  // Primary diagnosis -> CONDITION_OCCURRENCE
  const diagRows = preop.diagnoses ?? []
  if (diagRows.length > 0) {
    for (const diag of diagRows) {
      ctx.trackMapping(diag.mappingStatus)
      for (const conceptId of conditionConceptIds(diag)) {
        ctx.conditions.push({
          condition_occurrence_id:    nextId(),
          person_id:                 ctx.personId,
          condition_concept_id:      conceptId,
          condition_start_date:      isoDate(c.createdAt),
          condition_type_concept_id: 32817,
          condition_source_value:    ctx.sourceValue("DIAGNOSIS", diag.sourceVocabulary, diag.sourceCode, diag.labelEn ?? diag.labelBg ?? diag.label),
          visit_occurrence_id:       ctx.visitId,
        })
      }
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

  // The factors behind the four scores are catalogue questions and leave
  // with the answers at the end, each under its own concept where one
  // exists. POVOC's age factor is derived from the age rather than asked, so
  // it stays here: a yes/no, recorded for yes and for no, skipped when null.
  const riskFactor = (source: string, value: boolean | null | undefined) => {
    if (value == null) return
    ctx.sourceObservation(source, value, preopDate, null, 0, value ? YES_CONCEPT_ID : NO_CONCEPT_ID)
  }
  riskFactor("LOSPOR:POVOC_AGE_3_YEARS", preop.povocAgeAtLeast3Years)
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

  ctx.sourceObservation("LOSPOR:FAMILY_ANAESTHESIA_DETAILS", preop.familyAnesthesiaDetails, preopDate)

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

  // Every catalogue question -- baseline and additions alike -- leaves from
  // the answer rows, and only from there. The concept of each question lives
  // in the catalogue (lib/preop/catalog.ts, with the reasoning for each id).
  // NOT_ASKED is absence; a recorded yes/no is an observation even when the
  // question has no standard concept (then 0, under its LOSPOR source value).
  // A3 is the one question whose positive answer belongs in
  // CONDITION_OCCURRENCE. Urgency is a modifier on the planned procedure and
  // is exported there.
  for (const answer of preop.assessmentAnswers ?? []) {
    if (answer.state === "NOT_ASKED") continue
    if (answer.question.omopDomain === "procedure_modifier") continue
    const source = answer.question.omopSourceCode ?? "LOSPOR:PREOP_" + answer.question.stableKey
    const response = answer.optionKey ?? answer.valueText ?? answer.state
    const provenance = answer.provenance && typeof answer.provenance === "object"
      ? answer.provenance as Record<string, unknown>
      : null
    if (answer.question.stableKey === "A3_UNINTENTIONAL_WEIGHT_LOSS"
      && answer.state === "YES"
      && !provenance?.linkedDiagnosisId) {
      ctx.conditions.push({
        condition_occurrence_id: nextId(),
        person_id: ctx.personId,
        condition_concept_id: 40491502,
        condition_start_date: preopDate,
        condition_type_concept_id: 32817,
        condition_source_value: source,
        visit_occurrence_id: ctx.visitId,
      })
      continue
    }
    ctx.sourceObservation(
      source,
      response,
      preopDate,
      answer.valueNumber ?? null,
      answer.question.omopConceptId ?? 0,
      // An option with its own concept (high/low surgical risk) says what the
      // answer means; otherwise the state does.
      answer.option?.omopConceptId
        ?? (answer.state === "YES" ? YES_CONCEPT_ID : answer.state === "NO" ? NO_CONCEPT_ID : 0),
    )
  }
}
