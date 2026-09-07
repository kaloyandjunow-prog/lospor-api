import type { CaseMapperCtx } from "../case-context"
import type { CaseRow } from "../types"
import { COMPLICATION_OBSERVATION_DOMAIN_CONCEPTS, COMPLICATION_PROCEDURE_DOMAIN_CONCEPTS } from "../concepts"
import { isoDate } from "../date-helpers"
import { nextId } from "../ids"

/** Recorded complications -> the OMOP table its curated concept's domain routes it to. */
export function mapComplicationsToOmop(ctx: CaseMapperCtx, c: CaseRow): void {
  for (const comp of c.complications ?? []) {
    ctx.trackMapping(comp.mappingStatus)
    const compDate = isoDate(comp.timestamp) ?? (comp.section === "postop" ? ctx.endDate : ctx.startDate)
    if (comp.standardConceptId != null && COMPLICATION_OBSERVATION_DOMAIN_CONCEPTS.has(comp.standardConceptId)) {
      // A handful of curated complications -- "Difficult intubation",
      // "Failed intubation of trachea" -- are themselves Observation-domain
      // SNOMED findings (an assessment, not a diagnosed condition), unlike
      // the rest of the catalogue. They stay in OBSERVATION with their real
      // concept, rather than defaulting into CONDITION_OCCURRENCE with the
      // rest and putting an Observation-domain concept in the wrong table.
      ctx.observations.push({
        observation_id: nextId(), person_id: ctx.personId,
        observation_concept_id: comp.standardConceptId,
        observation_date: compDate,
        observation_type_concept_id: 32817,
        value_as_number: null,
        value_as_string: comp.note ? `${comp.label}; ${comp.note}` : comp.label,
        value_as_concept_id: 0,
        observation_source_value: ctx.sourceValue("LOSPOR_COMPLICATION", comp.sourceVocabulary, comp.sourceCode, comp.label),
        visit_occurrence_id: ctx.visitId,
      })
    } else if (comp.standardConceptId != null && COMPLICATION_PROCEDURE_DOMAIN_CONCEPTS.has(comp.standardConceptId)) {
      // "Endobronchial intubation" is a Procedure-domain SNOMED concept --
      // something that was done to the patient, not a disorder found or an
      // assessment made -- so it reaches PROCEDURE_OCCURRENCE rather than
      // either of the other two tables.
      ctx.procedures.push({
        procedure_occurrence_id:   nextId(),
        person_id:                 ctx.personId,
        procedure_concept_id:      comp.standardConceptId,
        procedure_date:            compDate,
        procedure_type_concept_id: 32817,
        modifier_concept_id:       0,
        modifier_source_value:     null,
        procedure_source_value:    ctx.sourceValue("LOSPOR_COMPLICATION", comp.sourceVocabulary, comp.sourceCode, comp.label),
        visit_occurrence_id:       ctx.visitId,
      })
      if (comp.note) {
        ctx.sourceObservation(`LOSPOR:${comp.section.toUpperCase()}_COMPLICATION_NOTE`, `${comp.label}; ${comp.note}`, compDate)
      }
    } else if (comp.standardConceptId != null) {
      // Every other curated complication concept is a Condition-domain
      // SNOMED finding -- the catalogue names arrhythmias, infarctions,
      // injuries, things that happened to the patient, not observations
      // about them -- so a resolved complication belongs in
      // CONDITION_OCCURRENCE, the same table a comorbidity or a diagnosis
      // reaches. Unmapped complications (the majority, until the catalogue
      // is fully curated) keep the old shape below rather than exporting a
      // 0 into a table that implies a real diagnosis was made.
      ctx.conditions.push({
        condition_occurrence_id:    nextId(),
        person_id:                  ctx.personId,
        condition_concept_id:       comp.standardConceptId,
        condition_start_date:       compDate,
        condition_type_concept_id:  32817,
        condition_source_value:     ctx.sourceValue("LOSPOR_COMPLICATION", comp.sourceVocabulary, comp.sourceCode, comp.label),
        visit_occurrence_id:        ctx.visitId,
      })
      // The free-text note is not a fact CONDITION_OCCURRENCE has anywhere
      // to put -- it stays a companion observation, keyed to the same
      // complication, so it still passes through the redaction pipeline the
      // way every other free-text field in this export does.
      if (comp.note) {
        ctx.sourceObservation(`LOSPOR:${comp.section.toUpperCase()}_COMPLICATION_NOTE`, `${comp.label}; ${comp.note}`, compDate)
      }
    } else {
      ctx.observations.push({
        observation_id: nextId(), person_id: ctx.personId,
        observation_concept_id: 0,
        observation_date: compDate,
        observation_type_concept_id: 32817,
        value_as_number: null,
        value_as_string: comp.note ? `${comp.label}; ${comp.note}` : comp.label,
        value_as_concept_id: 0,
        observation_source_value: `LOSPOR:${comp.section.toUpperCase()}_COMPLICATION`,
        visit_occurrence_id: ctx.visitId,
      })
    }
  }
}
