import type { CaseMapperCtx } from "../case-context"
import type { CaseRow } from "../types"
import { isoDate } from "../date-helpers"
import { nextId } from "../ids"
import { wardOrderText, type PreopOrderKind } from "@lospor/core/preop-orders"
import { premedicationDate, premedicationPhaseOf } from "@lospor/core/premedication"

/** SNOMED Planned procedure (405613005): what the ward is asked to do, as for the planned operation. */
const PLANNED_PROCEDURE = 4226140
/** UCUM hour. */
const HOUR = 8505
/** EHR order: the anaesthetist placed these in this record. */
const EHR_ORDER = 32833

/**
 * Preoperative ward orders and medication instructions -> OBSERVATION (9.16.0).
 *
 * An order is a plan, not an action, so nothing here becomes a procedure,
 * measurement or drug row: the ward's own record of doing it would be that.
 * Each order is one observation typed EHR order, dated the day it was placed.
 *
 * - A correction (electrolytes, water balance, acid-base, a hospital's own
 *   row): Planned procedure, with what is to be done as the value concept
 *   (0 where none says it) and its name as the value string.
 * - A consultation: Patient referral to specialist, the specialty's English
 *   name as the value string and its NHIS CL006 code in the source value.
 * - A laboratory test: Laboratory test requested, the test's own concept as
 *   the value and its LOINC code in the source value.
 * - "No additional orders": concept 0, which says the ward was told nothing
 *   more -- not the same as a case with no orders recorded.
 * - A medication instruction: Planned procedure with Recommendation to
 *   discontinue medication as the value, or concept 0 for "don't stop" (no
 *   concept says it); the drug as the value string, written as the drug's own
 *   row writes it so the two can be joined, and the hours before surgery as
 *   value_as_number in hours.
 */
/*
 * Premedication ordered at the preop visit is the one order that is a drug:
 * DRUG_EXPOSURE typed EHR order (32833), the OMOP place for a drug ordered and
 * not yet given. What was given is the intraoperative record's own row, typed
 * EHR administration (32818); the two together say ordered and given, or
 * ordered and changed. Dated the day it is to be taken -- the day before
 * surgery or its morning -- or the day it was ordered when the case has no date.
 */
export function mapPreopOrdersToOmop(ctx: CaseMapperCtx, preop: NonNullable<CaseRow["preop"]>): void {
  for (const order of preop.wardOrders ?? []) {
    const kind = order.kind as PreopOrderKind
    const text = wardOrderText({ ...order, kind }, "en")
    const source = kind === "CONSULT" && order.specialtyKey
      ? `PREOP_WARD_ORDER:${order.optionKey}:NHIS_CL006:${order.specialtyKey}`
      : kind === "LAB" && order.labLoinc
        ? `PREOP_WARD_ORDER:${order.optionKey}:LOINC:${order.labLoinc}`
        : `PREOP_WARD_ORDER:${order.optionKey}`
    const [conceptId, valueConcept] =
      kind === "NONE" ? [0, 0]
      : kind === "CONSULT" ? [order.conceptId, 0]
      : kind === "LAB" ? [order.conceptId, order.labConceptId ?? 0]
      : [PLANNED_PROCEDURE, order.conceptId]
    ctx.observations.push({
      observation_id: nextId(),
      person_id: ctx.personId,
      observation_concept_id: conceptId,
      observation_date: isoDate(order.createdAt),
      observation_type_concept_id: EHR_ORDER,
      value_as_number: null,
      value_as_string: kind === "CONSULT" ? order.specialtyLabelEn ?? text : text,
      value_as_concept_id: valueConcept,
      qualifier_concept_id: 0,
      qualifier_source_value: null,
      unit_concept_id: 0,
      unit_source_value: null,
      observation_source_value: source,
      visit_occurrence_id: ctx.visitId,
    })
  }

  for (const instruction of preop.medicationInstructions ?? []) {
    const hours = instruction.hoursBefore
    const [vocabulary, code] = instruction.medicationAtc
      ? ["ATC", instruction.medicationAtc]
      : instruction.medicationInn ? ["INN", instruction.medicationInn] : [null, null]
    ctx.observations.push({
      observation_id: nextId(),
      person_id: ctx.personId,
      observation_concept_id: instruction.conceptId === 0 ? 0 : PLANNED_PROCEDURE,
      observation_date: isoDate(instruction.createdAt),
      observation_type_concept_id: EHR_ORDER,
      value_as_number: hours ?? null,
      value_as_string: ctx.sourceValue("MEDICATION", vocabulary, code, instruction.medicationLabel),
      value_as_concept_id: instruction.conceptId,
      qualifier_concept_id: 0,
      qualifier_source_value: null,
      unit_concept_id: hours == null ? 0 : HOUR,
      unit_source_value: hours == null ? null : "h",
      observation_source_value: `PREOP_MEDICATION_INSTRUCTION:${instruction.optionKey}`,
      visit_occurrence_id: ctx.visitId,
    })
  }
  for (const order of preop.premedicationOrders ?? []) {
    const phase = premedicationPhaseOf(order.phase)
    const ordered = isoDate(order.createdAt)
    const takenOn = phase ? premedicationDate(ctx.startDate, phase) ?? ordered : ordered
    ctx.drugs.push({
      drug_exposure_id: nextId(), person_id: ctx.personId,
      drug_concept_id: order.conceptId ?? 0,
      drug_exposure_start_date: takenOn,
      drug_exposure_end_date: null,
      drug_type_concept_id: EHR_ORDER,
      // PREMED_ORDER: tells the order from the premedication given (PREMED:).
      drug_source_value: order.atcCode ? `PREMED_ORDER:ATC:${order.atcCode} - ${order.entry}` : `PREMED_ORDER:${order.entry}`,
      drug_source_concept_id: null,
      dose_value: order.dose,
      dose_unit_source_value: order.unit,
      route_source_value: order.route,
      visit_occurrence_id: ctx.visitId,
    })
    ctx.sourceObservation("LOSPOR:PREMEDICATION_ORDER_PHASE", phase ?? order.phase, takenOn)
  }
}
