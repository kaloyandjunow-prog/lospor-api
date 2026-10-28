import type { CaseMapperCtx } from "../case-context"
import type { CaseRow } from "../types"
import { UNOBTAINABLE_CONCEPT_ID, VITAL_CONCEPTS } from "../concepts"
import { isoDate } from "../date-helpers"
import { nextId } from "../ids"

/** Postoperative recovery vitals, Aldrete scoring, pain scores and disposition. */
export function mapPostopToOmop(
  ctx: CaseMapperCtx,
  c: CaseRow,
  postop: NonNullable<CaseRow["postop"]>,
): void {
  const postDate = ctx.endDate ?? isoDate(c.createdAt)
  // Same qualifier as preop: recovery observations that could not be taken
  // are a finding about the patient, not an omission. One flag covers both
  // halves of a blood pressure.
  const postopVitals: [keyof typeof VITAL_CONCEPTS, number | null | undefined, boolean][] = [
    ["systolic", postop.recoveryBpSystolic, Boolean(postop.recoveryBpUnobtainable)],
    ["diastolic", postop.recoveryBpDiastolic, Boolean(postop.recoveryBpUnobtainable)],
    ["heartRate", postop.recoveryHeartRate, Boolean(postop.recoveryHeartRateUnobtainable)],
    ["spO2", postop.recoverySpO2, Boolean(postop.recoverySpO2Unobtainable)],
    ["temp", postop.temperatureCelsius, Boolean(postop.recoveryTemperatureUnobtainable)],
  ]
  for (const [key, val, unobtainable] of postopVitals) {
    if (val == null && !unobtainable) continue
    const cfg = VITAL_CONCEPTS[key]
    ctx.measurements.push({ measurement_id: nextId(), person_id: ctx.personId, measurement_concept_id: cfg.concept_id, measurement_date: postDate, measurement_datetime: postDate, measurement_type_concept_id: 32817, value_as_number: val ?? null, value_as_concept_id: val == null ? UNOBTAINABLE_CONCEPT_ID : null, unit_concept_id: cfg.unitConceptId, unit_source_value: cfg.unit, measurement_source_value: `POSTOP_LOINC:${cfg.code}`, value_source_value: null, range_low: null, range_high: null, visit_occurrence_id: ctx.visitId })
  }
  // Aldrete subscores and their total: 0-2 each, 0-10 summed. A discharge
  // threshold is a numeric comparison, so these have to be numbers.
  //
  // The five subscores have no concept in this vocabulary -- only the
  // total is a scored entity in SNOMED, the same shape as RCRI's
  // criteria. They stay observations at concept 0.
  ctx.sourceObservation("LOSPOR:ALDRETE_ACTIVITY", postop.aldreteActivity, postDate)
  ctx.sourceObservation("LOSPOR:ALDRETE_RESPIRATION", postop.aldreteRespiration, postDate)
  ctx.sourceObservation("LOSPOR:ALDRETE_CIRCULATION", postop.aldreteCirculation, postDate)
  ctx.sourceObservation("LOSPOR:ALDRETE_CONSCIOUSNESS", postop.aldreteConsciousness, postDate)
  ctx.sourceObservation("LOSPOR:ALDRETE_SPO2", postop.aldreteSpO2, postDate)
  // A child's Steward score (10.0.0). Neither it nor its components has a
  // concept in these vocabularies -- the nearest, "Post Anesthetic Recovery
  // score", is the Aldrete/PAR scale, and filing Steward under it would mix two
  // scales with different ranges -- so all four stay observations at concept 0.
  ctx.sourceObservation("LOSPOR:STEWARD_CONSCIOUSNESS", postop.stewardConsciousness, postDate)
  ctx.sourceObservation("LOSPOR:STEWARD_AIRWAY", postop.stewardAirway, postDate)
  ctx.sourceObservation("LOSPOR:STEWARD_MOVEMENT", postop.stewardMovement, postDate)
  ctx.sourceObservation("LOSPOR:STEWARD_TOTAL", postop.stewardTotal, postDate)
  // The total, unlike its subscores, is a scored entity in SNOMED, so it
  // moves to measurement.value_as_number the same way RCRI and STOP-BANG
  // did -- an OMOP measurement, not a LOSPOR-only observation.
  if (postop.aldreteTotal != null) {
    ctx.measurements.push({
      measurement_id:              nextId(),
      person_id:                   ctx.personId,
      measurement_concept_id:      40488911,
      measurement_date:            postDate,
      measurement_datetime:        postDate,
      measurement_type_concept_id: 32817,
      value_as_number:             postop.aldreteTotal,
      value_as_concept_id:         null,
      unit_concept_id:             0,
      unit_source_value:           null,
      measurement_source_value:    "LOSPOR:ALDRETE_TOTAL",
      value_source_value:          String(postop.aldreteTotal),
      range_low:                   null,
      range_high:                  null,
      visit_occurrence_id:         ctx.visitId,
    })
  }
  if (postop.pediatricPainScore != null && postop.pediatricPainScale) {
    const scale = postop.pediatricPainScale
    const scoreSource = `LOSPOR:PEDIATRIC_PAIN_${scale}_0_10`
    if (scale === "FLACC") {
      // FLACC is a Measurement-domain concept in SNOMED, unlike FPS-R
      // below, which the vocabulary itself puts in Observation -- that
      // split is the vocabulary's own choice, not an inconsistency here.
      ctx.measurements.push({
        measurement_id:              nextId(),
        person_id:                   ctx.personId,
        // 3036118, Pain severity total [Score] FLACC (LOINC 38215-0): the score
        // itself. This was 3037051, the FLACC panel, which is the assessment
        // form rather than a value (corrected in 10.0.0).
        measurement_concept_id:      3036118,
        measurement_date:            postDate,
        measurement_datetime:        postDate,
        measurement_type_concept_id: 32817,
        value_as_number:             postop.pediatricPainScore,
        value_as_concept_id:         null,
        unit_concept_id:             0,
        unit_source_value:           null,
        measurement_source_value:    scoreSource,
        value_source_value:          String(postop.pediatricPainScore),
        range_low:                   null,
        range_high:                  null,
        visit_occurrence_id:         ctx.visitId,
      })
    } else if (scale === "FPS_R") {
      ctx.sourceObservation(scoreSource, postop.pediatricPainScore, postDate, postop.pediatricPainScore, 40760807)
    } else {
      // NRS has no reviewed concept, the same as the adult NRS branch
      // below -- stays a source-only observation at concept 0.
      // The same 0-10 verbal numeric rating as the adult NRS below, so the
      // same concept. It was left uncoded when 43055141 was not in the
      // vocabulary bundle this product shipped with.
      ctx.sourceMeasurement(scoreSource, postop.pediatricPainScore, 43055141, 0, null, postDate)
    }
  } else if (postop.painScoreNRS != null) {
    // 43055141, Pain severity - 0-10 verbal numeric rating [Score].
    //
    // This was 3020891 once -- the concept for body temperature, copied
    // from the vital map -- which would have made a pain score of 3 show
    // up in any OHDSI temperature query. Correcting that left it at 0,
    // with a comment saying LOSPOR had no reviewed mapping for the NRS
    // concept. That was true of the vocabulary bundle shipping at the
    // time and is no longer: the concept is standard, Measurement-domain,
    // and exactly this scale, so the row moves to measurement.
    ctx.sourceMeasurement("LOINC:72514-3", postop.painScoreNRS, 43055141, 0, null, postDate)
  }
  ctx.sourceObservation("LOSPOR:PAED_SCORE", postop.paedScore, postDate)
  // Item-scored pain and delirium (10.0.0). FLACC's total and its five items
  // are LOINC concepts (38215-0 total, a Measurement; 38216-8 to 38220-0 the
  // items, Observations), NIPS's total is LOINC 98012-8 (its items have none),
  // FPS-R keeps the concept the single-scale entry used. PAED has no concept,
  // total or items, so its items join LOSPOR:PAED_SCORE at concept 0.
  ctx.sourceMeasurement("LOINC:38215-0", postop.flaccTotal, 3036118, 0, null, postDate)
  for (const [field, source, conceptId] of [
    ["flaccFace", "LOINC:38216-8", 3034302],
    ["flaccLegs", "LOINC:38217-6", 3037050],
    ["flaccActivity", "LOINC:38218-4", 3037008],
    ["flaccCry", "LOINC:38219-2", 3034255],
    ["flaccConsolability", "LOINC:38220-0", 3036142],
  ] as const) {
    ctx.sourceObservation(source, postop[field], postDate, postop[field], conceptId)
  }
  ctx.sourceObservation("LOSPOR:FPS_R", postop.fpsrScore, postDate, postop.fpsrScore, 40760807)
  ctx.sourceMeasurement("LOINC:98012-8", postop.nipsTotal, 1617629, 0, null, postDate)
  for (const [field, source] of [
    ["nipsFacialExpression", "LOSPOR:NIPS_FACIAL_EXPRESSION"],
    ["nipsCry", "LOSPOR:NIPS_CRY"],
    ["nipsBreathing", "LOSPOR:NIPS_BREATHING"],
    ["nipsArms", "LOSPOR:NIPS_ARMS"],
    ["nipsLegs", "LOSPOR:NIPS_LEGS"],
    ["nipsArousal", "LOSPOR:NIPS_AROUSAL"],
    ["paedEyeContact", "LOSPOR:PAED_EYE_CONTACT"],
    ["paedPurposeful", "LOSPOR:PAED_PURPOSEFUL"],
    ["paedAware", "LOSPOR:PAED_AWARE"],
    ["paedRestless", "LOSPOR:PAED_RESTLESS"],
    ["paedInconsolable", "LOSPOR:PAED_INCONSOLABLE"],
  ] as const) {
    ctx.sourceObservation(source, postop[field], postDate)
  }
  // A condition that occurred, not an observation about one -- the same
  // domain routing already used for comorbidities and diagnoses.
  // Recorded only when present, and as a fact rather than a count.
  if (postop.ponv) {
    ctx.conditions.push({
      condition_occurrence_id:    nextId(),
      person_id:                  ctx.personId,
      condition_concept_id:       4032472,
      condition_start_date:       postDate ?? ctx.startDate,
      condition_type_concept_id:  32817,
      condition_source_value:     "LOSPOR:PONV",
      visit_occurrence_id:        ctx.visitId,
    })
  }
  // Each value is its own fact rather than an answer to one reusable
  // question -- "Discharge to ward" and "Admission to intensive care
  // unit" are different SNOMED concepts with no shared question concept
  // between them, unlike a yes/no field. PACU has no concept in this
  // vocabulary: the nearest match, "Post Anesthesia Care Unit" (45880582),
  // is a Meas Value/Answer concept, not a fact that belongs in
  // observation_concept_id, and nothing else names remaining in recovery
  // as an event.
  const dispositionConcept = postop.disposition === "WARD" ? 4142136
    : postop.disposition === "ICU" ? 4138933
    : 0
  ctx.sourceObservation("LOSPOR:DISPOSITION", postop.disposition, postDate, null, dispositionConcept)
}
