/**
 * OMOP CDM v5.4 mapper — export contract `source_version` 3.8.0.
 *
 * `source_version` tracks the shape of the export, not the app version: bump it
 * whenever a table or column is added, removed or reinterpreted.
 *
 * 3.8.0 — the shape changes since 3.7.0, none of which had been released.
 *
 *         CARE_SITE is emitted as its own table and referenced by
 *         care_site_id, instead of the site being written onto
 *         VISIT_OCCURRENCE as a bare string.
 *
 *         Allergies stop being exported as DRUG_EXPOSURE. Medication.kind is
 *         CURRENT | ALLERGY, and the export iterated both, so a substance the
 *         patient reacts to was recorded as one they were given. Allergies now
 *         become observations, which is a different claim in the right place.
 *
 *         Continuous administrations gain drug_exposure_end_date, paired from
 *         their stop events. Every planned procedure is exported, not the
 *         first. Intraoperative drugs resolve their ATC through the same
 *         concept pipeline as relational medications.
 *
 *         Clinical yes/no questions emit for a recorded "no" as well as a
 *         "yes". They were nullable-free booleans, so silence was the only
 *         honest option; the columns are now nullable and silence means the
 *         question was never asked.
 *
 *         Airway management is exported: device list, Cormack-Lehane grade,
 *         tools, per-device sizes and cuff status, DLT type/side/size,
 *         endobronchial size, ventilation modes, IPPV, jet ventilation and
 *         PEEP. Placing an instrumented airway is also emitted as a
 *         PROCEDURE_OCCURRENCE, separating what was done to the patient from
 *         what was true of them.
 *
 *         Preop findings that were read out of the database and written to no
 *         table now leave: smoking, substance use, latex allergy, family
 *         anaesthesia history, dental state, cardiac arrhythmia, BMI, blood
 *         group and Rh, GUTA, the airway examination (mouth opening,
 *         thyromental distance, neck mobility, upper lip bite test,
 *         retrognathia, prominent incisors, facial hair), and the free-text
 *         allergy, family-history and difficult-airway notes, redacted.
 *
 *         MEASUREMENT gains value_source_value, range_low and range_high.
 *         A lab result with no parsed number used to be skipped entirely, so a
 *         culture, a dipstick or a blood group left no trace of having been
 *         recorded; it is now exported with the value the lab reported. The
 *         reference range travels with the result, because ranges differ by
 *         laboratory, assay and patient age, and "high" is not a claim the
 *         export can support without the range that produced it. The abnormal
 *         flag rides as its own observation, keyed to the measurement's source
 *         value, since CDM 5.4 has no column for it.
 *
 *         Vascular lines carry their depth, lumen count and whether they were
 *         already in place. A pre-existing line was not placed during this
 *         case, so its procedure row overstates the work without that flag.
 *
 *         mapping_summary gains manually_curated_rows and rejected_rows.
 *         MAPPED covered both an automatic resolution and one a human signed
 *         off, and UNMAPPED covered both "nobody has looked" and "a candidate
 *         was rejected" -- so the summary could not distinguish evidence from
 *         guesswork, or finished review work from a backlog.
 * 3.7.0 — OBSERVATION gains value_as_number, the CDM column a numeric
 *         observation belongs in. Every score the export carries (RCRI, Apfel,
 *         STOP-BANG, the Aldrete subscores and total, POVOC, COLDS, PAED, the
 *         paediatric pain scales, fluid totals, durations) was written only as
 *         text, so a researcher could not sum, average or threshold one without
 *         casting it back. The string form is kept alongside for values that
 *         are genuinely textual and for consumers already reading it.
 * 3.6.0 — preserves pediatric mode, precise age, rule provenance, pediatric
 *         risk scores, and pediatric recovery scores as source observations.
 *         No unreviewed standard concept IDs are assigned.
 * 3.5.1 — production export includes real intraoperative start/end instants in
 *         the selected row shape, so visit dates use startedAt/endedAt when
 *         present instead of falling back to legacy wall-clock columns.
 * 3.5.0 — emits PERSON and OBSERVATION_PERIOD, the root tables the CDM and the
 *         OHDSI tools (ATLAS, ACHILLES) require; without them earlier bundles
 *         were OMOP-shaped but could not be loaded. person_id is now derived
 *         from SHA-256 (52 bits) instead of a 32-bit string hash that would
 *         have collided two unrelated cases onto one person around ~70k cases.
 * 3.4.x — drug exposure from CaseEvent rows; LOINC-coded lab measurements from
 *         LabResult; care_site_source_value from Case.institutionId.
 *
 * Concept IDs stay 0 where LOSPOR has no confident standard-vocabulary mapping
 * (vitals, which carry real LOINC-backed concept_ids, are the exception). No
 * identifier is ever invented — source vocabulary and code are carried instead.
 */

import { DICTIONARY_VERSION } from "@/lib/data-dictionary"
import { formatCanonicalConcentration } from "@/lib/case-event-schema"
import { deriveQualityStatus } from "@lospor/core/omop"
import { nextId, resetIds, pseudonymId } from "./omop-mapper/ids"
import { isoDate, isoInstant, numOrNull } from "./omop-mapper/date-helpers"
import {
  AIRWAY_ACTS,
  AIRWAY_DEVICE_CONCEPTS,
  AIRWAY_TOOL_CONCEPTS,
  TECHNIQUE_CONCEPTS,
  TECHNIQUE_PARENT,
  techniqueConceptFor,
  VASCULAR_ACCESS_CONCEPTS,
  VENTILATION_MODE_CONCEPTS,
  vascularAccessConceptFor,
  AIRWAY_ACT_CONCEPTS,
  doseUnitOf,
  UNOBTAINABLE_CONCEPT_ID,
  COMPLICATION_OBSERVATION_DOMAIN_CONCEPTS,
  COMPLICATION_PROCEDURE_DOMAIN_CONCEPTS,
  SELECTION_PROCEDURE_DOMAIN_CONCEPTS,
  SELECTION_MEASUREMENT_DOMAIN_CONCEPTS,
  MALLAMPATI_NOT_ASSESSABLE_CONCEPT_ID,
  VITAL_CONCEPTS,
  LAB_UNIT_CONCEPTS,
  AIRWAY_MEASUREMENTS,
  NECK_MOBILITY_CONCEPTS,
  BLOOD_GROUP_CONCEPTS,
  bloodGroupConceptFor,
  YES_CONCEPT_ID,
  NO_CONCEPT_ID,
  ASA_CLASS_CONCEPTS,
  AIRWAY_GRADES,
} from "./omop-mapper/concepts"
import type {
  OmopBundle,
  OmopDevice,
  OmopCareSite,
  OmopPerson,
  OmopObservationPeriod,
  OmopVisit,
  OmopCondition,
  OmopDrug,
  OmopMeasurement,
  OmopProcedure,
  OmopLabRow,
  OmopObservation,
  CaseRow,
  ExportContext,
} from "./omop-mapper/types"
import { buildQualityWarnings } from "./omop-mapper/quality-warnings"

export { AIRWAY_ACTS }
export type { OmopBundle, ExportContext }
export type { ExportQualityWarning } from "./omop-mapper/types"
import type { CaseMapperCtx } from "./omop-mapper/case-context"
import { mapPersonAndVisitToOmop } from "./omop-mapper/domains/person-visit"
import { mapPreopClinicalToOmop } from "./omop-mapper/domains/preop-clinical"
import { mapPlannedProcedureAndMedicationsToOmop } from "./omop-mapper/domains/planned-procedure"
import { mapIntraopToOmop } from "./omop-mapper/domains/intraop"
import { mapSelectionsToOmop } from "./omop-mapper/domains/selections"
import { mapComplicationsToOmop } from "./omop-mapper/domains/complications"
import { mapPostopToOmop } from "./omop-mapper/domains/postop"

export function mapCasesToOmop(cases: CaseRow[], ctx?: ExportContext): OmopBundle {
  resetIds(ctx?.rowIdStart ?? 1)

  // One row per distinct institution seen, keyed by the same pseudonym the
  // visits reference. Built as a map so a hundred cases at one hospital emit
  // one care site rather than a hundred.
  const careSites = new Map<number, OmopCareSite>()
  const persons: OmopPerson[] = []
  const observationPeriods: OmopObservationPeriod[] = []
  const visits: OmopVisit[] = []
  const conditions: OmopCondition[] = []
  const drugs: OmopDrug[] = []
  const measurements: OmopMeasurement[] = []
  const procedures: OmopProcedure[] = []
  // Trailing underscore because "devices" is already the local name for the
  // airway device codes read off a case further down.
  const devices_: OmopDevice[] = []
  const observations: OmopObservation[] = []
  const mappingSummary = { mapped_rows: 0, manually_curated_rows: 0, rejected_rows: 0, source_only_rows: 0, unmapped_rows: 0 }

  const trackMapping = (status: string | null | undefined) => {
    if (status === "MAPPED") mappingSummary.mapped_rows++
    // A mapping a human reviewed and signed off counts as mapped, because the
    // concept is applied either way, and is also counted on its own: an
    // automatic string match and a curated mapping are different levels of
    // evidence, and a summary that reports only "mapped" invites a reader to
    // trust a similarity score as if a clinician had checked it.
    else if (status === "MANUALLY_CURATED") { mappingSummary.mapped_rows++; mappingSummary.manually_curated_rows++ }
    // Rejected is not unmapped. Unmapped means nobody has looked; rejected
    // means someone looked and said no, and the export must not present the
    // two as the same backlog.
    else if (status === "REJECTED") mappingSummary.rejected_rows++
    else if (status === "UNMAPPED") mappingSummary.unmapped_rows++
    else if (status === "SOURCE_ONLY") mappingSummary.source_only_rows++
  }

  const sourceValue = (prefix: string, sourceVocabulary?: string | null, sourceCode?: string | null, label?: string | null) =>
    sourceVocabulary && sourceCode ? `${sourceVocabulary}:${sourceCode}${label ? ` - ${label}` : ""}` : `${prefix}:${label ?? "unknown"}`

  for (const c of cases) {
    const personId = pseudonymId("person", c.id)
    const visitId  = pseudonymId("visit", c.id)
    // Prefer the real instants. The legacy startTime/endTime columns hold a bare
    // wall clock on a dummy date (2000-01-01) with no zone, so using them as a
    // date would export the year 2000 for every legacy case; fall back to
    // createdAt instead, which is at least a genuine moment. Never emit the
    // dummy date as if it were the day of surgery.
    const legacyDay = (d: Date | null | undefined) =>
      d && d.getUTCFullYear() > 2000 ? d : null
    const startInstant = c.intraop?.startedAt ?? legacyDay(c.intraop?.startTime) ?? c.createdAt
    const endInstant   = c.intraop?.endedAt ?? legacyDay(c.intraop?.endTime) ?? c.intraop?.startedAt ?? c.createdAt
    const startDate = isoDate(startInstant)
    const endDate   = isoDate(endInstant)
    // The same instants, kept at full precision. Anaesthesia start/end is a
    // clock time, not just a day -- case duration, turnover and first-case
    // metrics all need it -- but visit_occurrence only ever carried the
    // truncated date.
    const startDateTime = startInstant ? startInstant.toISOString() : null
    const endDateTime   = endInstant ? endInstant.toISOString() : null

    // The case's own institution, stamped at creation and never updated,
    // because a case belongs to the institution it was performed at — see
    // access-control.ts, which scopes reads the same way.
    //
    // There is deliberately no fallback to the author's institution. That was
    // joined live at export time, so a case with no institution of its own was
    // attributed to wherever its author happened to work on the day of the
    // export, and could move hospital between two exports because a colleague
    // changed jobs. It also mixed two kinds of value in one column: an id from
    // the case, a name from the user. Unknown now stays unknown.
    const careSite = c.institutionId ?? null
    const careSiteId = careSite ? pseudonymId("caresite", careSite) : null
    if (careSite && careSiteId && !careSites.has(careSiteId)) {
      careSites.set(careSiteId, {
        care_site_id: careSiteId,
        // LOSPOR records the institution, not the department or theatre, so
        // there is no name beyond the source identifier and no reviewed
        // place-of-service concept to claim.
        care_site_name: null,
        place_of_service_concept_id: 0,
        care_site_source_value: careSite,
      })
    }
    const sourceObservation = (
      source: string,
      value: string | number | boolean | null | undefined,
      date = startDate,
      // Where the exported text is a formatted rendering of a number — a
      // concentration written "0.5%" — the number is passed in rather than
      // parsed back out of the string.
      numericValue?: number | null,
      // A standard concept where the vocabulary has one for this finding.
      //
      // Defaulting to 0 keeps every existing caller unchanged: concept_id 0
      // means "we had nowhere standard to put this", which is honest for a
      // LOSPOR-specific observation and dishonest for one OMOP already knows.
      // The source value is kept either way — it is what the data dictionary
      // documents and what already-exported datasets are keyed by.
      conceptId = 0,
      // The answer as a concept, for a question whose answer the vocabulary
      // can state. Left 0 unless a caller passes one: a wrong coded answer is
      // worse than an uncoded one, which is the lesson of every other concept
      // on this page.
      valueConceptId = 0,
    ) => {
      if (value == null || value === "") return
      observations.push({
        observation_id: nextId(),
        person_id: personId,
        observation_concept_id: conceptId,
        value_as_concept_id: valueConceptId,
        observation_date: date,
        observation_type_concept_id: 32817,
        // A boolean is not a measurement, so it stays text only: "true" in
        // value_as_number would be indistinguishable from a score of 1.
        value_as_number: numericValue
          ?? (typeof value === "number" && Number.isFinite(value) ? value : null),
        value_as_string: String(value),
        observation_source_value: source,
        visit_occurrence_id: visitId,
      })
    }

    /**
     * A plain numeric measurement with a concept and a unit.
     *
     * For the quantities whose concept turns out to live in the Measurement
     * domain rather than Observation. Which table a value belongs in is the
     * vocabulary's decision, not a stylistic one -- a Measurement-domain
     * concept sitting in OBSERVATION is a CDM violation the OHDSI
     * data-quality checks flag, even when the value reads as an ordinary
     * number on the anaesthetic chart either way.
     */
    const sourceMeasurement = (
      source: string,
      value: number | null | undefined,
      conceptId: number,
      unitConceptId: number,
      unitSourceValue: string | null,
      date = startDate,
    ) => {
      if (value == null) return
      measurements.push({
        measurement_id:              nextId(),
        person_id:                   personId,
        measurement_concept_id:      conceptId,
        measurement_date:            date,
        measurement_datetime:        date,
        measurement_type_concept_id: 32817,
        value_as_number:             value,
        value_as_concept_id:         null,
        unit_concept_id:             unitConceptId,
        unit_source_value:           unitSourceValue,
        measurement_source_value:    source,
        value_source_value:          null,
        range_low:                   null,
        range_high:                  null,
        visit_occurrence_id:         visitId,
      })
    }

    /**
     * Laboratory results -> MEASUREMENT, with the abnormal flag alongside.
     *
     * Shared by the preoperative snapshot and the intraoperative draws. The two
     * differ only in which record they hang off and what date a result falls
     * back to; everything else -- LOINC coding, units, reference ranges, the
     * qualitative-result rule -- is identical, so they emit through one path.
     *
     * `fallbackDate` is used only when a row has no `takenAt` of its own.
     */
    const emitLabRows = (rows: OmopLabRow[], fallbackDate: string | null) => {
      for (const lab of rows) {
        // A result with neither a number nor text is not a result. Anything
        // else is exported: this used to skip every row without a parsed
        // number, so a qualitative result -- a blood group, a culture, a
        // dipstick -- was dropped with no trace that it had been recorded.
        if (lab.valueNum == null && !lab.value) continue
        trackMapping(lab.mappingStatus)
        const labSource = lab.loincCode ? `LOINC:${lab.loincCode}` : `LAB:${lab.test}`
        // The draw time when there is one. Falling back to the record's date
        // for every row was the old behaviour, and it made a result drawn days
        // before surgery indistinguishable from one drawn during it -- fatal
        // for intraoperative labs, whose whole point is the separate timestamp.
        //
        // The datetime column keeps the full instant so two draws within a day
        // stay distinguishable; the date column is the calendar day, as CDM
        // defines it.
        const labDate = isoDate(lab.takenAt) ?? fallbackDate
        const labInstant = isoInstant(lab.takenAt) ?? fallbackDate
        measurements.push({
          measurement_id:              nextId(),
          person_id:                   personId,
          measurement_concept_id:      lab.standardConceptId ?? 0,
          measurement_date:            labDate,
          measurement_datetime:        labInstant,
          measurement_type_concept_id: 32817,
          value_as_number:             lab.valueNum,
          value_as_concept_id: null,
          unit_concept_id:             lab.unitCanon ? LAB_UNIT_CONCEPTS[lab.unitCanon] ?? 0 : 0,
          unit_source_value:           lab.unitCanon ?? null,
          measurement_source_value:    labSource,
          // The value as the lab reported it. For a numeric result this is the
          // unparsed original; for a qualitative one it is the only value there
          // is.
          value_source_value:          lab.value ?? null,
          // The range this result was judged against. Reference ranges differ
          // by laboratory, assay and patient age, so "high" is not a claim the
          // export can support without carrying the range that produced it.
          range_low:                   lab.referenceLow ?? null,
          range_high:                  lab.referenceHigh ?? null,
          visit_occurrence_id:         visitId,
        })
        // CDM 5.4 has no abnormal-flag column, and value_as_concept_id would
        // need a standard concept this export does not assign. The flag is
        // LOSPOR's own judgement, so it is carried as its own observation,
        // keyed by the same source value the measurement row uses.
        if (lab.abnormalFlag) {
          sourceObservation("LOSPOR:LAB_ABNORMAL_FLAG", `${labSource}=${lab.abnormalFlag}`, labDate)
        }
      }
    }

    /**
     * Whether a tracheal tube was cuffed, as the coded answer it has.
     *
     * LOINC registers "Cuffed endotracheal tube" (36311248) and "Uncuffed"
     * (36311029) as the answers to question 40771868, Artificial airway, so
     * both halves of the pair are codeable rather than the usual Yes/No
     * qualifiers -- the vocabulary names the actual clinical states here.
     *
     * The field is always one or the other when a tube was placed, so unlike
     * the tri-state history questions there is no "not asked" to preserve: a
     * null means no tube of that kind, and emits nothing.
     */
    const cuffedObservation = (source: string, cuffed: boolean | null | undefined) => {
      if (cuffed == null) return
      sourceObservation(source, cuffed, startDate, null, 40771868,
        cuffed ? 36311248 : 36311029)
    }

    /**
     * A graded airway scale as a measurement: the concept is the scale, the
     * grade is the coded answer, and the original grade text stays in
     * value_source_value so the Cook subdivision of Cormack-Lehane II is not
     * lost when SNOMED collapses IIa and IIb to grade 2.
     */
    const emitAirwayGrade = (
      key: keyof typeof AIRWAY_GRADES,
      grade: string | null | undefined,
      date: string | null,
      notAssessable: boolean,
    ) => {
      if (grade == null && !notAssessable) return
      const cfg = AIRWAY_GRADES[key]
      const graded = grade == null ? null : cfg.grades[grade] ?? null
      measurements.push({
        measurement_id:              nextId(),
        person_id:                   personId,
        measurement_concept_id:      cfg.concept_id,
        measurement_date:            date,
        measurement_datetime:        date,
        measurement_type_concept_id: 32817,
        value_as_number:             null,
        value_as_concept_id: grade == null
          ? (key === "mallampati" ? MALLAMPATI_NOT_ASSESSABLE_CONCEPT_ID : UNOBTAINABLE_CONCEPT_ID)
          : graded,
        unit_concept_id:             0,
        unit_source_value:           null,
        measurement_source_value:    cfg.source,
        value_source_value:          grade ?? null,
        range_low:                   null,
        range_high:                  null,
        visit_occurrence_id:         visitId,
      })
    }

    const ctx: CaseMapperCtx = {
      personId, visitId, startDate, endDate, startDateTime, endDateTime,
      careSite, careSiteId,
      persons, observationPeriods, visits,
      conditions, drugs, measurements, procedures, devices: devices_, observations,
      trackMapping, sourceValue,
      sourceObservation, sourceMeasurement, emitLabRows, cuffedObservation, emitAirwayGrade,
    }

    mapPersonAndVisitToOmop(ctx, c)

    // Clinical mode is not exported -- see the module doc comment in
    // preop-clinical.ts's neighbouring history for why; kept here rather than
    // inside a domain module because it belongs to no one domain.
    ctx.sourceObservation("LOSPOR:CLINICAL_RULES_VERSION", c.clinicalRulesVersion)

    if (c.preop) mapPreopClinicalToOmop(ctx, c, c.preop)
    mapPlannedProcedureAndMedicationsToOmop(ctx, c, c.preop)
    if (c.intraop) mapIntraopToOmop(ctx, c, c.intraop)
    mapSelectionsToOmop(ctx, c)
    mapComplicationsToOmop(ctx, c)
    if (c.postop) mapPostopToOmop(ctx, c, c.postop)
  }

  const tableCounts = {
    person: persons.length,
    observation_period: observationPeriods.length,
    visit_occurrence: visits.length,
    condition_occurrence: conditions.length,
    drug_exposure: drugs.length,
    measurement: measurements.length,
    procedure_occurrence: procedures.length,
    device_exposure: devices_.length,
    observation: observations.length,
  }
  const qualityWarnings = buildQualityWarnings(cases, mappingSummary)

  const caseDates = cases.map(row => row.createdAt.getTime())
  const dateRange = cases.length
    ? { from: new Date(Math.min(...caseDates)).toISOString(), to: new Date(Math.max(...caseDates)).toISOString() }
    : null

  return {
    metadata: {
      export_id:               ctx?.exportId ?? crypto.randomUUID(),
      omop_cdm_version:        "5.4",
      generated_at:            ctx?.generatedAt ?? new Date().toISOString(),
      generated_by_user_id:    ctx?.userId ?? "unknown",
      generated_by_role:       ctx?.userRole ?? "unknown",
      source:                  "LOSPOR",
      source_version:          "3.8.0",
      schema_version:          "3.6.0",
      concept_map_version:     "local-bilingual-map-v2",
      data_dictionary_version: DICTIONARY_VERSION,
      case_status_filter:      ctx?.statusFilter ?? [],
      date_range:              dateRange,
      matching_case_count:     ctx?.matchingCaseCount ?? cases.length,
      exported_case_count:     cases.length,
      complete:                ctx?.complete ?? true,
      included_case_count:     cases.length,
      excluded_case_count:     ctx?.excludedCaseCount ?? 0,
      app_git_commit:          ctx?.gitCommit ?? "untracked",
      forced_override:         ctx?.forcedOverride ?? false,
      case_count:              cases.length,
      mapping_summary:         mappingSummary,
      table_counts:            tableCounts,
      quality_warnings:        qualityWarnings,
      data_quality_status:     deriveQualityStatus(qualityWarnings),
      deidentification: {
        mode:                              "pseudonymised",
        person_id_strategy:               "deterministic 52-bit identifier derived from SHA-256 of the internal case ID (optionally salted) — not reversible without the source database. One person per case: no patient identifier is stored, so the same patient across two operations appears as two persons.",
        direct_patient_identifiers_stored: false,
        event_timestamp_precision:        "exact_datetime",
        residual_linkage_risks: [
          "exact intraoperative event timestamps (not rounded or shifted)",
          "case-level institution/care-site linkage",
          "rare procedure, complication, and timeline combinations",
        ],
      },
      note: "Numeric observations carry their value in observation.value_as_number and, unchanged, as text in observation.value_as_string; genuinely textual observations populate value_as_string only. OMOP concept IDs are emitted only where LOSPOR has a confident local mapping. Source vocabulary, source code, English/Bulgarian labels, and source-only rows are preserved for research traceability. Pediatric mode, precise age at procedure, rule provenance, pediatric risk scores, and recovery scores are preserved as source observations with concept_id 0 until reviewed mappings exist. person_id is a deterministic pseudonym derived from SHA-256 of the internal case ID — no patient names, national IDs, or direct identifiers are stored. PERSON carries an approximate year_of_birth derived from age at operation (month and day are unknown, not defaulted); race and ethnicity are not collected and are emitted as concept 0. OBSERVATION_PERIOD spans the operation only. Intraoperative event timestamps are preserved at exact DateTime precision for clinical sequence analysis — see residual_linkage_risks.",
    },
    care_site:             [...careSites.values()],
    person:                persons,
    observation_period:    observationPeriods,
    visit_occurrence:      visits,
    condition_occurrence:  conditions,
    drug_exposure:         drugs,
    measurement:           measurements,
    procedure_occurrence:  procedures,
    device_exposure:       devices_,
    observation:           observations,
  }
}
