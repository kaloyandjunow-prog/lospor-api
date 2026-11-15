import type { CaseMapperCtx } from "../case-context"
import type { CaseRow } from "../types"
import { SELECTION_PROCEDURE_DOMAIN_CONCEPTS, SELECTION_MEASUREMENT_DOMAIN_CONCEPTS } from "../concepts"
import { isoDate, isoInstant } from "../date-helpers"
import { nextId } from "../ids"

/**
 * Intraoperative selections the intraop domain already exports with their own
 * concepts: the technique as a procedure, the airway device and tool as devices,
 * the ventilation mode as a measurement. Exported here as well, each left a
 * second, concept-0 observation saying the same thing (2.9.0 stops that).
 */
const EXPORTED_BY_INTRAOP = new Set(["technique", "airwaydevice", "airwaytool", "ventilationmode"])

const sameCode = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase()

/** Selected option-library entries (position, monitoring, ...) -> the OMOP table its own concept's domain routes it to. */
export function mapSelectionsToOmop(ctx: CaseMapperCtx, c: CaseRow): void {
  // Positions charted on the timeline carry the moment each began (2.9.0).
  // When a case has them, they replace the untimed list of positions below.
  const positionEvents = (c.events ?? []).filter(e => e.type === "position_change" && e.label)
  const positionSelections = (c.selections ?? []).filter(sel => sel.section.toLowerCase() === "intraop" && sel.category.toLowerCase() === "position")
  for (const ev of positionEvents) {
    const sel = positionSelections.find(item => sameCode(item.value, ev.label)
      || sameCode(item.sourceCode?.split(":").pop(), ev.label))
    ctx.observations.push({
      observation_id: nextId(), person_id: ctx.personId,
      observation_concept_id: sel?.standardConceptId ?? 0,
      observation_date: isoDate(ev.timestamp),
      observation_datetime: isoInstant(ev.timestamp),
      observation_type_concept_id: 32817,
      value_as_number: null,
      value_as_string: sel?.value ?? ev.label,
      value_as_concept_id: 0,
      qualifier_concept_id: 0,
      qualifier_source_value: null,
      unit_concept_id: 0,
      unit_source_value: null,
      observation_source_value: "LOSPOR:INTRAOP_POSITION",
      visit_occurrence_id: ctx.visitId,
    })
  }

  for (const sel of c.selections ?? []) {
    const section = sel.section.toLowerCase()
    const category = sel.category.toLowerCase()
    if (section === "intraop" && EXPORTED_BY_INTRAOP.has(category)) continue
    if (section === "intraop" && category === "position" && positionEvents.length > 0) continue
    // Monitoring has no moment of its own: it runs from the start of the
    // anaesthesia to its end (2.9.0), so it carries that whole span.
    const monitoring = section === "intraop" && category === "monitoring"
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
        ...(monitoring ? {
          procedure_datetime:     ctx.startDateTime,
          procedure_end_date:     ctx.endDate,
          procedure_end_datetime: ctx.endDateTime,
        } : {}),
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
        measurement_datetime:        monitoring ? ctx.startDateTime : ctx.startDate,
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
        observation_datetime: monitoring ? ctx.startDateTime : null,
        observation_type_concept_id: 32817,
        value_as_number: null,
        value_as_string: sel.value,
        value_as_concept_id: 0,
        qualifier_concept_id: 0,
        qualifier_source_value: null,
        unit_concept_id: 0,
        unit_source_value: null,
        observation_source_value: sourceValue,
        visit_occurrence_id: ctx.visitId,
      })
    }
  }
}
