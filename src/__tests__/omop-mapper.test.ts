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
      source_version: "3.6.0",
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
      observation: 23,
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
        drug_source_concept_id: "ATC:N05BA01",
        dose_value: 5,
      }),
      expect.objectContaining({
        drug_concept_id: 0,
        drug_source_value: "Fentanyl",
        drug_source_concept_id: "ATC:N01AH01",
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
    expect(bundle.observation).toEqual(expect.arrayContaining([
      expect.objectContaining({ observation_source_value: "LOSPOR:ASA_CLASS", value_as_string: "I" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:CARRIER_GAS", value_as_string: "AIR/O2" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:PREMEDICATION_PHASE", value_as_string: "evening" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:INTRAOP_MONITORING", value_as_string: "ecg" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:POSTOP_COMPLICATION", value_as_string: "PONV; treated" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:DISPOSITION", value_as_string: "WARD" }),
    ]))
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

    expect(bundle.metadata.source_version).toBe("3.6.0")
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
      expect.objectContaining({ observation_source_value: "LOSPOR:DRUG_CONCENTRATION", value_as_string: "0.5%" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:DRUG_FORMULATION", value_as_string: "HYPERBARIC" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:DOSE_CALCULATION_BASIS", value_as_string: "IBW" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:DOSE_CALCULATION_METHOD", value_as_string: "MCLAREN_CDC_2000" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:CLINICAL_RULE_KEY", value_as_string: "PEDIATRIC_DRUG_PROFILE:BUPIVACAINE:0-6575" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:CLINICAL_RULE_VERSION", value_as_string: "rules.v2.7" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:CLINICAL_PRESET_ID", value_as_string: "user-preset" }),
      expect.objectContaining({ observation_source_value: "LOSPOR:CLINICAL_PRESET_VERSION", value_as_string: "7" }),
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
