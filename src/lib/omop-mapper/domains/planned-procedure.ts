import type { CaseMapperCtx } from "../case-context"
import type { CaseRow } from "../types"
import { numOrNull, isoDate, isoInstant } from "../date-helpers"
import { doseUnitOf } from "../concepts"
import { nextId } from "../ids"
import { UNDETERMINED_PROCEDURE } from "@lospor/core/procedure-codes"
import { CANCELLATION_REASONS } from "@lospor/core/case-cancellation"

/**
 * SNOMED 764869007 "Operative procedure canceled before anesthesia start
 * time" (Observation domain): a case is cancelled only before its anaesthesia
 * start is set, so the concept says exactly what happened (10.0.0).
 */
export const CANCELLED_BEFORE_ANAESTHESIA_CONCEPT = 35622708
/** SNOMED 419617009 "Reason for procedure cancelation". */
export const CANCELLATION_REASON_CONCEPT = 4306654

/** When the timeline says the operation began: the earlier of "Incision" and "Procedure started", or null. */
export function operationStartOf(c: Pick<CaseRow, "events">): Date | null {
  const starts = (c.events ?? [])
    .filter(event => event.type === "clinical_event" && (event.label === "Incision" || event.label === "Procedure started"))
    .map(event => new Date(event.timestamp))
    .sort((a, b) => a.getTime() - b.getTime())
  return starts[0] ?? null
}

/**
 * The planned operation -> OBSERVATION (and PROCEDURE_OCCURRENCE once the
 * timeline shows it happened), and the preoperative medication/allergy list
 * -> DRUG_EXPOSURE / allergy observation.
 *
 * Runs regardless of whether preop exists (it reads through optional
 * chaining), the same as the original inline code.
 */
export function mapPlannedProcedureAndMedicationsToOmop(
  ctx: CaseMapperCtx,
  c: CaseRow,
  preop: CaseRow["preop"],
): void {
  // Every planned procedure, not just the first. This read procedureRows[0]
  // and discarded the rest silently: a case with two planned procedures
  // exported one, with nothing to show the others had been dropped. A
  // combined operation therefore appeared in the register as a lesser one.
  //
  // The unstructured plannedProcedure text is the fallback for cases recorded
  // before procedure rows existed, and only when there are no rows at all.
  // Urgency, hung off the operation rather than emitted as an operation of
  // its own. As its own procedure_occurrence row it would make one
  // appendectomy count as two and add a spurious hit to any cohort defined
  // over a procedure concept set.
  //
  // SNOMED Qualifier Values, which is the concept class a modifier column is
  // for: Emergency 4093606 against Elective 4013731. The obvious-looking
  // "Emergency procedure" (4158569) is Procedure-domain — it names an
  // operation, not a way of performing one, and would have put a second
  // procedure concept in a qualifier slot. Urgent (4014167) and Routine
  // (4176260) are the same class if the form ever needs them.
  //
  // The two are one toggle in the form and cannot both be true, which is what
  // lets a single column carry the whole dimension. A case recorded before
  // the field existed has neither, and takes 0: unmodified, rather than a
  // guess that it was elective.
  const emergency = preop?.emergencySurgery
  const surgicalUrgencyConcept = emergency == null ? 0 : emergency ? 4093606 : 4013731
  const surgicalUrgencySource = emergency == null
    ? null
    : emergency ? "LOSPOR:EMERGENCY_SURGERY" : "LOSPOR:ELECTIVE_SURGERY"

  // A plan is not an action. The CDM keeps actions in PROCEDURE_OCCURRENCE
  // and, in the CDM team's words, "we generally don't store plans, only
  // actions" -- so the operation the assessment planned is an OBSERVATION:
  // SNOMED Planned procedure (405613005, 4226140), the operation as its value,
  // typed 32817 EHR like every other row: the type says where a row came
  // from, and the plan is typed into the record, not placed through an order
  // system (that would be 32833 EHR order). It used to be a procedure row, which
  // nothing told apart from an operation performed, so a case abandoned before
  // incision counted as one done.
  //
  // The operation itself is a PROCEDURE_OCCURRENCE only once the timeline
  // says it happened: an "Incision" or "Procedure started" milestone, dated by
  // the earlier of the two. Without either the plan is all the record shows,
  // and quality-warnings says so for a completed case.
  const operationStart = operationStartOf(c)

  const plans: { conceptId: number; source: string | null; label: string | null }[] = []
  const procedureRows = preop?.procedureRows ?? []
  if (procedureRows.length > 0) {
    for (const row of procedureRows) {
      ctx.trackMapping(row.mappingStatus)
      plans.push({
        conceptId: row.standardConceptId ?? 0,
        source: ctx.sourceValue("PROCEDURE", row.sourceVocabulary, row.sourceCode, row.group ?? row.description),
        label: row.description ?? row.group ?? null,
      })
    }
  } else if (preop?.procedureUndetermined) {
    // Planned as not yet known (10.0.0): SNOMED "Surgical procedure", which
    // claims nothing about which operation; the source value says why.
    plans.push({ conceptId: UNDETERMINED_PROCEDURE.conceptId, source: UNDETERMINED_PROCEDURE.sourceValue, label: UNDETERMINED_PROCEDURE.labelEn })
  } else if (preop?.plannedProcedure) {
    plans.push({ conceptId: 0, source: preop.plannedProcedure, label: preop.plannedProcedure })
  }

  // The procedure done, when recorded (10.0.0), is what was performed: it
  // replaces the plan as the operation's PROCEDURE_OCCURRENCE. The plan stays
  // an observation.
  const performed = (c.postop?.performedProcedureRows ?? []).map(row => {
    ctx.trackMapping(row.mappingStatus)
    return {
      conceptId: row.standardConceptId ?? 0,
      source: ctx.sourceValue("PROCEDURE", row.sourceVocabulary, row.sourceCode, row.group ?? row.description),
    }
  })

  // A cancelled procedure (10.0.0): the cancellation and its reason, dated
  // when it was cancelled. No operation follows (no anaesthesia start).
  if (c.status === "CANCELLED") {
    const date = isoDate(c.cancelledAt ?? c.createdAt)
    ctx.observations.push({
      observation_id: nextId(), person_id: ctx.personId,
      observation_concept_id: CANCELLED_BEFORE_ANAESTHESIA_CONCEPT, observation_date: date, observation_type_concept_id: 32817,
      value_as_number: null, value_as_string: null, value_as_concept_id: 0,
      qualifier_concept_id: 0, qualifier_source_value: null, unit_concept_id: 0, unit_source_value: null,
      observation_source_value: "LOSPOR:PROCEDURE_CANCELLED", visit_occurrence_id: ctx.visitId,
    })
    const reason = CANCELLATION_REASONS.find(item => item.code === c.cancellationReason)
    if (reason) {
      ctx.observations.push({
        observation_id: nextId(), person_id: ctx.personId,
        observation_concept_id: CANCELLATION_REASON_CONCEPT, observation_date: date, observation_type_concept_id: 32817,
        value_as_number: null, value_as_string: reason.labelEn, value_as_concept_id: 0,
        qualifier_concept_id: 0, qualifier_source_value: null, unit_concept_id: 0, unit_source_value: null,
        observation_source_value: `LOSPOR:CANCELLATION_REASON:${reason.code}`, visit_occurrence_id: ctx.visitId,
      })
    }
  }

  for (const plan of plans) {
    ctx.observations.push({
      observation_id:              nextId(),
      person_id:                   ctx.personId,
      observation_concept_id:      4226140,
      observation_date:            isoDate(c.createdAt),
      observation_type_concept_id: 32817,
      value_as_number:             null,
      value_as_string:             plan.label,
      value_as_concept_id:         plan.conceptId,
      // Urgency qualifies the plan as it does the operation: the booking was
      // elective or emergency whether or not the operation then happened.
      qualifier_concept_id:        surgicalUrgencyConcept,
      qualifier_source_value:      surgicalUrgencySource,
      unit_concept_id:             0,
      unit_source_value:           null,
      observation_source_value:    plan.source,
      visit_occurrence_id:         ctx.visitId,
    })
    if (!operationStart || performed.length > 0) continue
    ctx.procedures.push({
      procedure_occurrence_id:    nextId(),
      person_id:                 ctx.personId,
      procedure_concept_id:      plan.conceptId,
      procedure_date:            isoDate(operationStart),
      procedure_datetime:        isoInstant(operationStart),
      procedure_type_concept_id: 32817,
      modifier_concept_id:       surgicalUrgencyConcept,
      modifier_source_value:     surgicalUrgencySource,
      procedure_source_value:    plan.source,
      visit_occurrence_id:       ctx.visitId,
    })
  }

  // The procedure done: performed, dated by the operation's start when the
  // timeline has one, else by the case's.
  const performedAt = operationStart ?? c.intraop?.startedAt ?? null
  if (performedAt && c.status !== "CANCELLED") {
    for (const done of performed) {
      ctx.procedures.push({
        procedure_occurrence_id:    nextId(),
        person_id:                 ctx.personId,
        procedure_concept_id:      done.conceptId,
        procedure_date:            isoDate(performedAt),
        procedure_datetime:        isoInstant(performedAt),
        procedure_type_concept_id: 32817,
        modifier_concept_id:       surgicalUrgencyConcept,
        modifier_source_value:     surgicalUrgencySource,
        procedure_source_value:    done.source,
        visit_occurrence_id:       ctx.visitId,
      })
    }
  }

  // ── Intraop techniques -> PROCEDURE_OCCURRENCE ────────────────────────────
  for (const med of preop?.medications ?? []) {
    ctx.trackMapping(med.mappingStatus)
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
      ctx.sourceObservation(
        "LOSPOR:DRUG_ALLERGY",
        ctx.sourceValue("MEDICATION", med.sourceVocabulary, med.sourceCode, med.nameRaw),
        isoDate(c.createdAt),
      )
      continue
    }
    // Not `parseFloat(med.dose) || null`: that turns a recorded dose of 0
    // into "not recorded", the same class of bug the fluid figures below
    // were tested against and this line was not.
    const dose = numOrNull(med.dose)
    // A combination product with no combination concept of its own is one row
    // per ingredient (OMOP's convention), each carrying the product in
    // drug_source_value. The recorded dose is the product's, not any one
    // ingredient's, so those rows carry no dose.
    const concepts = med.standardConceptIds?.length ? med.standardConceptIds : [med.standardConceptId ?? 0]
    const split = concepts.length > 1
    for (const conceptId of concepts) ctx.drugs.push({
      drug_exposure_id: nextId(),
      person_id: ctx.personId,
      drug_concept_id: conceptId,
      drug_exposure_start_date: isoDate(c.createdAt),
      // A single administration, not an interval: no end to record.
      drug_exposure_end_date: null,
      // 32865, Patient self-report. This row is not a witnessed
      // administration -- it is what the patient (or an old chart) told the
      // assessor they take at home, which nobody here watched happen. That is
      // also what separates this row from a premedication or an intraop dose
      // sharing the same drug_concept_id: those are 32818, EHR administration
      // record, in the two sites below.
      drug_type_concept_id: 32865,
      drug_source_value: ctx.sourceValue("MEDICATION", med.sourceVocabulary, med.sourceCode, med.nameRaw),
      // The ATC/INN text is already carried by drug_source_value above. No
      // OMOP *source* concept is resolved for it today, so this stays null
      // rather than being filled with something that is not a concept id.
      drug_source_concept_id: null,
      dose_value: split ? null : dose,
      dose_unit_source_value: split ? null : doseUnitOf(med.dose),
      route_source_value: med.route,
      visit_occurrence_id: ctx.visitId,
    })
  }
}
