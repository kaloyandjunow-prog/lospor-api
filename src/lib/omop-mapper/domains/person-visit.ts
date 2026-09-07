import type { CaseMapperCtx } from "../case-context"
import type { CaseRow } from "../types"
import { pseudonymId } from "../ids"

/** PERSON, OBSERVATION_PERIOD and VISIT_OCCURRENCE for one case. */
export function mapPersonAndVisitToOmop(ctx: CaseMapperCtx, c: CaseRow): void {
  // ── PERSON ───────────────────────────────────────────────────────────────
  // One person per case: LOSPOR deliberately stores no patient identifier, so
  // the same patient returning for a second operation cannot be recognised.
  // Documented as a research limitation, not an accident.
  // 8507/8532 are the OMOP standard gender concepts. OTHER and UNKNOWN both
  // fall through to 0 ("no matching concept"), but they mean different things
  // in the source data and are preserved verbatim in gender_source_value.
  const GENDER_CONCEPT: Record<string, number> = { MALE: 8507, FEMALE: 8532 }
  const ageAtOp = c.preop?.ageYears
    ?? (c.preop?.ageApproxDays != null ? Math.floor(c.preop.ageApproxDays / 365.2425) : null)
  const opYear = ctx.startDate ? Number(ctx.startDate.substring(0, 4)) : null
  ctx.persons.push({
    person_id:            ctx.personId,
    // 0 = "no matching concept", the OMOP convention for unknown/other.
    gender_concept_id:    (c.preop?.sex && GENDER_CONCEPT[c.preop.sex]) || 0,
    // Only age-in-years is collected, so the birth year is approximate (±1)
    // and month/day are genuinely unknown rather than defaulted.
    year_of_birth:        (ageAtOp != null && opYear != null) ? opYear - ageAtOp : null,
    month_of_birth:       null,
    day_of_birth:         null,
    birth_datetime:       null,
    race_concept_id:      0,   // not collected
    ethnicity_concept_id: 0,   // not collected
    person_source_value:  `RC-${c.researchId}`,
    gender_source_value:  c.preop?.sex ?? null,
  })

  // ── OBSERVATION_PERIOD ───────────────────────────────────────────────────
  // Spans the operation itself: the only window in which this pseudonymous
  // person is observed. OHDSI cohort tooling requires this to exist.
  ctx.observationPeriods.push({
    observation_period_id:         pseudonymId("obsperiod", c.id),
    person_id:                     ctx.personId,
    observation_period_start_date: ctx.startDate,
    observation_period_end_date:   ctx.endDate ?? ctx.startDate,
    period_type_concept_id:        32817, // EHR
  })

  // ── VISIT_OCCURRENCE ─────────────────────────────────────────────────────
  ctx.visits.push({
    visit_occurrence_id:   ctx.visitId,
    person_id:             ctx.personId,
    // 9201 Inpatient Visit, and it is a description rather than a guess:
    // LOSPOR documents admitted surgical care only. The Disposition enum
    // carries the evidence — WARD, PACU, ICU, with no home-discharge value —
    // so a patient who went home the same day cannot be recorded here at all.
    //
    // This is therefore an assumption about the register's scope, not a fact
    // read off the case. If day surgery is ever recorded, this must stop being
    // a constant and derive from the setting: 9201 inpatient, 9202
    // outpatient, 581379 day surgery. Until then, exporting 0 would be worse
    // than exporting 9201 — it would hide every visit from the OHDSI tools
    // that filter on visit type, to avoid stating something that is true.
    visit_concept_id:      9201,
    visit_start_date:      ctx.startDate,
    visit_start_datetime:  ctx.startDateTime,
    visit_end_date:        ctx.endDate,
    visit_end_datetime:    ctx.endDateTime,
    visit_type_concept_id: 32817, // EHR
    visit_source_value:    `RC-${c.researchId}`,
    care_site_source_value: ctx.careSite,
    // The reference a CDM consumer reads. Null when the case records no
    // institution, which is a real state; the source value stays alongside.
    care_site_id: ctx.careSiteId,
  })
}
