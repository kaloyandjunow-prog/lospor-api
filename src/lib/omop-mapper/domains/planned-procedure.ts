import type { CaseMapperCtx } from "../case-context"
import type { CaseRow } from "../types"
import { numOrNull, isoDate } from "../date-helpers"
import { doseUnitOf } from "../concepts"
import { nextId } from "../ids"

/**
 * The planned operation -> PROCEDURE_OCCURRENCE, and the preoperative
 * medication/allergy list -> DRUG_EXPOSURE / allergy observation.
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

  const procedureRows = preop?.procedureRows ?? []
  if (procedureRows.length > 0) {
    for (const row of procedureRows) {
      ctx.trackMapping(row.mappingStatus)
      ctx.procedures.push({
        procedure_occurrence_id:    nextId(),
        person_id:                 ctx.personId,
        procedure_concept_id:      row.standardConceptId ?? 0,
        procedure_date:            ctx.startDate,
        procedure_type_concept_id: 32817,
        modifier_concept_id:       surgicalUrgencyConcept,
        modifier_source_value:     surgicalUrgencySource,
        procedure_source_value:    ctx.sourceValue("PROCEDURE", row.sourceVocabulary, row.sourceCode, row.group ?? row.description),
        visit_occurrence_id:       ctx.visitId,
      })
    }
  } else if (preop?.plannedProcedure) {
    ctx.procedures.push({
      procedure_occurrence_id:    nextId(),
      person_id:                 ctx.personId,
      procedure_concept_id:      0,
      procedure_date:            ctx.startDate,
      procedure_type_concept_id: 32817,
      modifier_concept_id:       surgicalUrgencyConcept,
      modifier_source_value:     surgicalUrgencySource,
      procedure_source_value:    preop.plannedProcedure,
      visit_occurrence_id:       ctx.visitId,
    })
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
    ctx.drugs.push({
      drug_exposure_id: nextId(),
      person_id: ctx.personId,
      drug_concept_id: med.standardConceptId ?? 0,
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
      dose_value: dose,
      dose_unit_source_value: doseUnitOf(med.dose),
      route_source_value: med.route,
      visit_occurrence_id: ctx.visitId,
    })
  }
}
