import type { CaseMapperCtx } from "../case-context"
import type { CaseRow } from "../types"
import { SELECTION_PROCEDURE_DOMAIN_CONCEPTS, SELECTION_MEASUREMENT_DOMAIN_CONCEPTS } from "../concepts"
import { nextId } from "../ids"

/** Selected option-library entries (position, monitoring, ...) -> the OMOP table its own concept's domain routes it to. */
export function mapSelectionsToOmop(ctx: CaseMapperCtx, c: CaseRow): void {
  for (const sel of c.selections ?? []) {
    // A selected option from the institution's option library — a label, not
    // a quantity, even when the label happens to read as a number.
    const sourceValue = `LOSPOR:${sel.section.toUpperCase()}_${sel.category.toUpperCase()}`
    // The option library's reviewed concept when there is one. CaseSelection
    // has carried standardConceptId all along; the export simply never
    // asked for it, so a mapped monitoring line still claimed to map to
    // nothing. Most curated categories (position) resolve to Observation
    // concepts, but a monitoring modality is often the SNOMED procedure of
    // performing that monitoring, or a Measurement-domain LOINC concept --
    // "domain governs table" applies here exactly as it does to
    // complications, so this routes per-concept rather than assuming
    // Observation for every category.
    if (sel.standardConceptId != null && SELECTION_PROCEDURE_DOMAIN_CONCEPTS.has(sel.standardConceptId)) {
      ctx.procedures.push({
        procedure_occurrence_id:   nextId(),
        person_id:                 ctx.personId,
        procedure_concept_id:      sel.standardConceptId,
        procedure_date:            ctx.startDate,
        procedure_type_concept_id: 32817,
        modifier_concept_id:       0,
        modifier_source_value:     null,
        procedure_source_value:    sourceValue,
        visit_occurrence_id:       ctx.visitId,
      })
    } else if (sel.standardConceptId != null && SELECTION_MEASUREMENT_DOMAIN_CONCEPTS.has(sel.standardConceptId)) {
      ctx.measurements.push({
        measurement_id:              nextId(),
        person_id:                   ctx.personId,
        measurement_concept_id:      sel.standardConceptId,
        measurement_date:            ctx.startDate,
        measurement_datetime:        ctx.startDate,
        measurement_type_concept_id: 32817,
        value_as_number:             null,
        value_as_concept_id:         0,
        unit_concept_id:             0,
        unit_source_value:           null,
        measurement_source_value:    sourceValue,
        value_source_value:          sel.value,
        range_low:                   null,
        range_high:                  null,
        visit_occurrence_id:         ctx.visitId,
      })
    } else {
      ctx.observations.push({
        observation_id: nextId(), person_id: ctx.personId,
        observation_concept_id: sel.standardConceptId ?? 0,
        observation_date: ctx.startDate,
        observation_type_concept_id: 32817,
        value_as_number: null,
        value_as_string: sel.value,
        value_as_concept_id: 0,
        observation_source_value: sourceValue,
        visit_occurrence_id: ctx.visitId,
      })
    }
  }
}
