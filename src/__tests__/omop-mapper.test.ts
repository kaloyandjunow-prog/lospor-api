import { describe, expect, it } from "vitest"
import { mapCasesToOmop } from "@/lib/omop-mapper"

import { completeCaseFixture as completeCase } from "./fixtures/complete-case"

describe("mapCasesToOmop", () => {
  it("exports finalized relational rows into OMOP CDM tables", () => {
    const bundle = mapCasesToOmop([completeCase() as never], {
      userId: "admin-1",
      userRole: "ADMIN",
      statusFilter: ["COMPLETE"],
      excludedCaseCount: 2,
      gitCommit: "abc123",
      forcedOverride: false,
    })

    expect(bundle.metadata).toEqual(expect.objectContaining({
      omop_cdm_version: "5.4",
      generated_by_user_id: "admin-1",
      generated_by_role: "ADMIN",
      source: "LOSPOR",
      source_version: "3.7.0",
      included_case_count: 1,
      excluded_case_count: 2,
      app_git_commit: "abc123",
      data_quality_status: "WARNING",
      mapping_summary: { mapped_rows: 4, source_only_rows: 2, unmapped_rows: 1 },
    }))
    expect(bundle.metadata.table_counts).toEqual({
      // PERSON and OBSERVATION_PERIOD are the OMOP root tables — without them
      // the bundle cannot be loaded by OHDSI tooling.
      person: 1,
      observation_period: 1,
      visit_occurrence: 1,
      condition_occurrence: 2,
      drug_exposure: 3,
      measurement: 26,
      procedure_occurrence: 3,
      observation: 28,
    })
    expect(bundle.metadata.deidentification.direct_patient_identifiers_stored).toBe(false)

    expect(bundle.visit_occurrence[0]).toEqual(expect.objectContaining({
      visit_source_value: "2026-0001",
      care_site_source_value: "inst-1",
    }))
    expect(bundle.condition_occurrence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        condition_concept_id: 12345,
        condition_source_value: "ICD10:K35 - Acute appendicitis",
      }),
      expect.objectContaining({
        condition_concept_id: 0,
        condition_source_value: "ICD10:Z99 - Source-only condition",
      }),
    ]))
    expect(bundle.procedure_occurrence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        procedure_concept_id: 23456,
        procedure_source_value: "LOSPOR_PROCEDURE:APPY - Appendectomy",
      }),
      expect.objectContaining({ procedure_source_value: "ANAESTHESIA_TECHNIQUE:general" }),
      expect.objectContaining({ procedure_source_value: "VASCULAR_ACCESS:Internal jugular 18G" }),
    ]))
    expect(bundle.drug_exposure).toEqual(expect.arrayContaining([
      expect.objectContaining({
        drug_concept_id: 19019905,
        drug_source_value: "ATC:N05BA01 - Diazepam",
        // The ATC lives in the source value; the concept id column is numeric
        // and stays null until a real OMOP source concept is resolved.
        drug_source_concept_id: null,
        dose_value: 5,
      }),
      expect.objectContaining({
        drug_concept_id: 0,
        drug_source_value: "ATC:N01AH01 - Fentanyl",
        drug_source_concept_id: null,
        dose_value: 50,
        route_source_value: "IV",
      }),
      expect.objectContaining({
        drug_source_value: "Midazolam 2 mg PO",
        dose_value: 2,
        route_source_value: "PO",
      }),
    ]))
    expect(bundle.measurement).toEqual(expect.arrayContaining([
      expect.objectContaining({
        measurement_concept_id: 3000963,
        value_as_number: 180,
        unit_source_value: "g/L",
        measurement_source_value: "LOINC:718-7",
      }),
      expect.objectContaining({
        measurement_concept_id: 0,
        value_as_number: 7,
        measurement_source_value: "LAB:Unknown lab",
      }),
      expect.objectContaining({
        measurement_concept_id: 3004249,
        value_as_number: 118,
        measurement_datetime: "2026-06-01T08:15:00.000Z",
      }),
      expect.objectContaining({
        measurement_source_value: "LOINC:3150-0",
        value_as_number: 50,
      }),
      expect.objectContaining({
        measurement_source_value: "POSTOP_LOINC:8480-6",
        value_as_number: 120,
      }),
    ]))
    // A textual observation carries no number: an ASA class is "I", not 1, and
    // writing it as 1 would make it addable to something.
    expect(bundle.observation).toEqual(expect.arrayContaining([
      expect.objectContaining({ observation_source_value: "LOSPOR:ASA_CLASS", value_as_string: "I", value_as_number: null }),
      expect.objectContaining({ observation_source_value: "LOSPOR:CARRIER_GAS", value_as_string: "AIR/O2", value_as_number: null }),
      expect.objectContaining({ observation_source_value: "LOSPOR:PREMEDICATION_PHASE", value_as_string: "evening", value_as_number: null }),
      expect.objectContaining({ observation_source_value: "LOSPOR:INTRAOP_MONITORING", value_as_string: "ecg", value_as_number: null }),
      expect.objectContaining({ observation_source_value: "LOSPOR:POSTOP_COMPLICATION", value_as_string: "PONV; treated", value_as_number: null }),
      expect.objectContaining({ observation_source_value: "LOSPOR:DISPOSITION", value_as_string: "WARD", value_as_number: null }),
    ]))
    // Every score, on the other hand, has to arrive as a number. Until 3.7.0
    // these were strings in a column the OBSERVATION row did not have, so a
    // researcher could not average an Aldrete total or threshold an RCRI
    // without casting the whole column back from text.
    expect(bundle.observation).toEqual(expect.arrayContaining([
      expect.objectContaining({ observation_source_value: "LOSPOR:RCRI", value_as_number: 0, value_as_string: "0" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:APFEL", value_as_number: 1 }),
      expect.objectContaining({ observation_source_value: "LOSPOR:STOP_BANG", value_as_number: 1 }),
      expect.objectContaining({ observation_source_value: "LOSPOR:AGE_YEARS", value_as_number: 14 }),
      expect.objectContaining({ observation_source_value: "LOSPOR:ALDRETE_TOTAL", value_as_number: 10 }),
      expect.objectContaining({ observation_source_value: "LOSPOR:ALDRETE_ACTIVITY", value_as_number: 2 }),
      expect.objectContaining({ observation_source_value: "LOSPOR:CRYSTALLOIDS_ML", value_as_number: 500 }),
      // A zero total is a recorded zero, not a missing value: it has to survive
      // as 0 rather than being dropped as falsy.
      expect.objectContaining({ observation_source_value: "LOSPOR:COLLOIDS_ML", value_as_number: 0, value_as_string: "0" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:ANAESTHESIA_DURATION_MIN", value_as_number: 60 }),
      expect.objectContaining({ observation_source_value: "LOINC:72514-3", value_as_number: 2 }),
    ]))
    // A boolean is a fact, not a quantity: "true" in value_as_number would be
    // indistinguishable from a score of 1.
    expect(bundle.observation).toEqual(expect.arrayContaining([
      expect.objectContaining({ observation_source_value: "LOSPOR:EMERGENCY_SURGERY", value_as_string: "false", value_as_number: null }),
      expect.objectContaining({ observation_source_value: "LOSPOR:DIFFICULT_AIRWAY_HISTORY", value_as_string: "true", value_as_number: null }),
    ]))
    // The NRS pain score used to be emitted under concept 3020891 — body
    // temperature, copied from the vital map — which would have put a pain
    // score of 2 into any OHDSI temperature query.
    expect(bundle.observation.find(row => row.observation_source_value === "LOINC:72514-3")?.observation_concept_id).toBe(0)
    expect(bundle.metadata.quality_warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNMAPPED_CONCEPT_ROWS", severity: "warning", count: 1 }),
      expect.objectContaining({ code: "SOURCE_ONLY_CONCEPT_ROWS", severity: "info", count: 2 }),
      expect.objectContaining({ code: "EXACT_EVENT_TIMESTAMPS", severity: "info", count: 3 }),
      expect.objectContaining({ code: "INSTITUTION_LINKAGE", severity: "info", count: 1 }),
      expect.objectContaining({ code: "REDACTED_FREE_TEXT_PRESENT", severity: "warning", count: 1 }),
    ]))
  })

  it("uses real intraoperative instants before legacy wall-clock fields", () => {
    const base = completeCase()
    const realInstantCase = completeCase({
      createdAt: new Date("2026-07-19T12:00:00Z"),
      preop: {
        ...(base.preop as Record<string, unknown>),
        ageYears: 40,
      },
      intraop: {
        ...(base.intraop as Record<string, unknown>),
        startTime: new Date("2000-01-01T08:00:00Z"),
        endTime: new Date("2000-01-01T09:00:00Z"),
        startedAt: new Date("2026-07-21T05:00:00Z"),
        endedAt: new Date("2026-07-21T06:30:00Z"),
        timezone: "Europe/Sofia",
      },
    })

    const bundle = mapCasesToOmop([realInstantCase as never], {
      userId: "admin-1",
      userRole: "ADMIN",
      statusFilter: ["COMPLETE"],
      excludedCaseCount: 0,
      gitCommit: "abc123",
      forcedOverride: false,
    })

    expect(bundle.metadata.source_version).toBe("3.7.0")
    expect(bundle.visit_occurrence[0]).toEqual(expect.objectContaining({
      visit_start_date: "2026-07-21",
      visit_end_date: "2026-07-21",
    }))
    expect(bundle.observation_period[0]).toEqual(expect.objectContaining({
      observation_period_start_date: "2026-07-21",
      observation_period_end_date: "2026-07-21",
    }))
    expect(bundle.person[0].year_of_birth).toBe(1986)
  })

  it("exports frozen drug route-profile inputs and rule provenance", () => {
    const base = completeCase()
    const events = (base.events as Array<Record<string, unknown>>).map(event =>
      event.type === "drug"
        ? {
            ...event,
            concentration: "0.5%",
            concentrationValue: 0.5,
            concentrationUnit: "PERCENT",
            formulation: "HYPERBARIC",
            calculationBasis: "IBW",
            calculationWeightKg: 18.25,
            calculationMethod: "MCLAREN_CDC_2000",
            clinicalRuleKey: "PEDIATRIC_DRUG_PROFILE:BUPIVACAINE:0-6575",
            clinicalRuleVersion: "rules.v2.7",
            clinicalRuleSourceIds: ["user-preset", "institution-preset", "platform-preset"],
            clinicalPresetId: "user-preset",
            clinicalPresetVersion: 7,
            clinicalPresetScope: "USER",
          }
        : event,
    )
    const bundle = mapCasesToOmop([completeCase({ events }) as never])

    expect(bundle.observation).toEqual(expect.arrayContaining([
      expect.objectContaining({ observation_source_value: "LOSPOR:DRUG_CONCENTRATION", value_as_string: "0.5%", value_as_number: 0.5 }),
      expect.objectContaining({ observation_source_value: "LOSPOR:DRUG_FORMULATION", value_as_string: "HYPERBARIC" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:DOSE_CALCULATION_BASIS", value_as_string: "IBW" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:DOSE_CALCULATION_METHOD", value_as_string: "MCLAREN_CDC_2000" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:CLINICAL_RULE_KEY", value_as_string: "PEDIATRIC_DRUG_PROFILE:BUPIVACAINE:0-6575" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:CLINICAL_RULE_VERSION", value_as_string: "rules.v2.7" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:CLINICAL_PRESET_ID", value_as_string: "user-preset" }),
      // Both columns: the text is the canonical rendering a clinician would
      // recognise, the number is the one a query can use.
      expect.objectContaining({ observation_source_value: "LOSPOR:CLINICAL_PRESET_VERSION", value_as_string: "7", value_as_number: 7 }),
      expect.objectContaining({ observation_source_value: "LOSPOR:CLINICAL_PRESET_SCOPE", value_as_string: "USER" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:CLINICAL_RULE_SOURCE_IDS", value_as_string: "user-preset|institution-preset|platform-preset" }),
    ]))
    expect(bundle.measurement).toContainEqual(expect.objectContaining({
      measurement_source_value: "LOSPOR:DOSE_CALCULATION_WEIGHT_KG",
      value_as_number: 18.25,
      unit_source_value: "kg",
    }))
  })

  it("fails the quality gate for unsafe export inputs", () => {
    const drifted = completeCase({
      fieldStatuses: [],
      snapshot: null,
      updatedAt: new Date("2026-06-01T10:00:00Z"),
      finalizedAt: new Date("2026-06-01T09:00:00Z"),
      intraop: {
        ...(completeCase().intraop as Record<string, unknown>),
        startTime: new Date("2026-06-01T09:00:00Z"),
        endTime: new Date("2026-06-01T08:00:00Z"),
      },
    })
    const bundle = mapCasesToOmop([drifted as never], {
      userId: "admin-1",
      userRole: "ADMIN",
      statusFilter: ["COMPLETE"],
      excludedCaseCount: 0,
      gitCommit: "abc123",
      forcedOverride: true,
    })

    expect(bundle.metadata.data_quality_status).toBe("FAIL")
    expect(bundle.metadata.quality_warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "MISSING_FINALIZATION_SNAPSHOT", severity: "error" }),
      expect.objectContaining({ code: "RELATIONAL_DRIFT", severity: "error" }),
      expect.objectContaining({ code: "IMPOSSIBLE_TIMESTAMPS", severity: "error" }),
      expect.objectContaining({ code: "NO_FIELD_STATUS_ROWS", severity: "error" }),
    ]))
    expect(bundle.metadata.forced_override).toBe(true)
  })
})

/**
 * A recorded allergy is a statement that a drug must NOT be given. Exporting it
 * as a DRUG_EXPOSURE says the opposite: that the patient received it. A
 * researcher reading the dataset cannot tell the two apart, and the mistake
 * runs in the dangerous direction.
 */
describe("allergies are not drug administrations", () => {
  function caseWithAllergy() {
    const c = completeCase() as never as { preop: { medications: unknown[] } }
    c.preop.medications = [
      { kind: "CURRENT", nameRaw: "Diazepam", inn: "diazepam", atcCode: "N05BA01", dose: "5 mg", route: "PO", sourceVocabulary: "ATC", sourceCode: "N05BA01", standardConceptId: 19019905, mappingStatus: "MAPPED", ordinal: 0 },
      { kind: "ALLERGY", nameRaw: "Penicillin", inn: "benzylpenicillin", atcCode: "J01CE01", dose: null, route: null, sourceVocabulary: "ATC", sourceCode: "J01CE01", standardConceptId: 1728416, mappingStatus: "MAPPED", ordinal: 1 },
    ]
    return c
  }

  const options = {
    userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
    excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
  }

  it("keeps current medication in DRUG_EXPOSURE", () => {
    // The positive half. Asserting only the absence of the allergy would also
    // pass on a mapper that exported no medications at all.
    const bundle = mapCasesToOmop([caseWithAllergy() as never], options as never)
    expect(bundle.drug_exposure.some(row => /Diazepam/.test(String(row.drug_source_value)))).toBe(true)
  })

  it("never exports an allergy as a drug administration", () => {
    const bundle = mapCasesToOmop([caseWithAllergy() as never], options as never)
    expect(bundle.drug_exposure.some(row => /Penicillin/.test(String(row.drug_source_value)))).toBe(false)
  })

  it("still records the allergy somewhere, rather than dropping it", () => {
    // Silence would be its own defect: "no allergy recorded" and "allergy lost
    // in export" must not look the same to a researcher.
    const bundle = mapCasesToOmop([caseWithAllergy() as never], options as never)
    const recorded = [...bundle.observation, ...bundle.condition_occurrence]
      .some(row => /Penicillin/i.test(JSON.stringify(row)))
    expect(recorded).toBe(true)
  })
})

/**
 * drug_source_concept_id is defined by the CDM as a concept id: an integer.
 * Writing "ATC:N01AH01" there puts a vocabulary string in a numeric column, so
 * a loader either rejects the row or coerces it to nothing. The ATC belongs in
 * drug_source_value, which is the column for source text.
 */
describe("drug source columns hold the right kinds of value", () => {
  const options = {
    userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
    excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
  }

  it("never puts a vocabulary string in the concept id column", () => {
    const bundle = mapCasesToOmop([completeCase() as never], options as never)
    for (const row of bundle.drug_exposure) {
      expect(
        typeof row.drug_source_concept_id === "string",
        `drug_source_concept_id held the string ${JSON.stringify(row.drug_source_concept_id)}`,
      ).toBe(false)
    }
  })

  it("keeps the ATC code visible in the source value instead", () => {
    // Losing the code entirely would trade one defect for another: an
    // unmapped drug is still identifiable by its source code.
    const bundle = mapCasesToOmop([completeCase() as never], options as never)
    const fentanyl = bundle.drug_exposure.find(row => /Fentanyl/.test(String(row.drug_source_value)))
    expect(fentanyl, "fixture must contain the intraoperative fentanyl event").toBeDefined()
    expect(String(fentanyl!.drug_source_value)).toContain("N01AH01")
  })
})

describe("visit type states the register's scope", () => {
  it("marks every case an inpatient visit, because LOSPOR records only admitted care", () => {
    // Not an unexamined constant. LOSPOR documents admitted surgical care, and
    // the Disposition enum shows it: WARD, PACU, ICU, with no home-discharge
    // value, so a same-day discharge cannot be recorded at all.
    //
    // This test exists to fail the day that changes. If a day-case or
    // home-discharge disposition is ever added, this constant is no longer
    // true and must derive from the setting instead.
    const bundle = mapCasesToOmop([completeCase() as never], {
      userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
      excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
    } as never)
    expect(bundle.visit_occurrence.length).toBeGreaterThan(0)
    for (const visit of bundle.visit_occurrence) {
      expect(visit.visit_concept_id).toBe(9201)
      expect(visit.visit_source_value).toBeTruthy()
    }
  })
})

/**
 * A case belongs to the institution it was performed at — access-control.ts
 * says so, and Case.institutionId is stamped once at creation and never
 * updated, so the relational model honours it.
 *
 * The exporter used to undo that: when institutionId was null it fell back to
 * the author's institution, joined live at export time. So a case could change
 * hospital between two exports because its author changed jobs, and an
 * unaffiliated author's case was attributed to whichever hospital they later
 * joined. On the appliance this cannot arise — accounts are site-local — but
 * the serverless register is exactly where authors move between institutions.
 */
describe("care site comes from the case, not from where its author works now", () => {
  const options = {
    userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
    excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
  }

  it("uses the institution recorded on the case", () => {
    const bundle = mapCasesToOmop([completeCase() as never], options as never)
    expect(bundle.visit_occurrence[0].care_site_source_value).toBe("inst-1")
  })

  it("does not borrow the author's current institution when the case has none", () => {
    const c = completeCase() as never as { institutionId: string | null }
    c.institutionId = null
    const bundle = mapCasesToOmop([c as never], options as never)
    // The fixture's author sits at "Fallback Hospital". An unknown care site
    // must stay unknown rather than quietly becoming theirs.
    expect(bundle.visit_occurrence[0].care_site_source_value).not.toBe("Fallback Hospital")
    expect(bundle.visit_occurrence[0].care_site_source_value).toBeNull()
  })
})
