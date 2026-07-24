import { describe, expect, it } from "vitest"
import { mapCasesToOmop } from "@/lib/omop-mapper"

function completeCase(overrides: Record<string, unknown> = {}) {
  const createdAt = new Date("2026-06-01T07:30:00Z")
  const startTime = new Date("2026-06-01T08:00:00Z")
  const endTime = new Date("2026-06-01T09:00:00Z")
  return {
    id: "case-omop-1",
    caseCode: "2026-0001",
    createdAt,
    status: "COMPLETE",
    institutionId: "inst-1",
    user: { institution: { name: "Fallback Hospital" } },
    fieldStatuses: [{ section: "preop", fieldKey: "ageYears", presence: "PRESENT" }],
    snapshot: { id: "snapshot-1" },
    updatedAt: new Date("2026-06-01T09:01:00Z"),
    finalizedAt: new Date("2026-06-01T09:01:00Z"),
    selections: [{ section: "intraop", category: "monitoring", value: "ecg", ordinal: 0 }],
    complications: [{ section: "postop", label: "PONV", note: "treated", timestamp: endTime, source: "relational-sync", ordinal: 0 }],
    events: [
      {
        type: "vital",
        timestamp: new Date("2026-06-01T08:15:00Z"),
        label: null,
        value: null,
        unit: null,
        systolic: 118,
        diastolic: 70,
        heartRate: 76,
        spO2: 99,
        etco2: 36,
        temp: 36.5,
        bgl: 5.6,
        bglLoincCode: "2345-7",
        bglUnitCanon: "mmol/L",
        atcCode: null,
        drugId: null,
        drugRoute: null,
        metadataJson: {},
      },
      {
        type: "drug",
        timestamp: new Date("2026-06-01T08:20:00Z"),
        label: "Fentanyl",
        value: null,
        unit: "mcg",
        bgl: null,
        bglLoincCode: null,
        bglUnitCanon: null,
        atcCode: "N01AH01",
        drugId: "drug-1",
        drugRoute: "IV",
        metadataJson: { dose: "50", name: "Fentanyl" },
      },
      {
        type: "gas_change",
        timestamp: new Date("2026-06-01T08:30:00Z"),
        label: null,
        value: null,
        unit: null,
        fgfLitersPerMin: 2,
        carrierGas: "AIR/O2",
        fio2Percent: 50,
        fiAirPercent: 50,
        fiN2OPercent: 0,
        bgl: null,
        bglLoincCode: null,
        bglUnitCanon: null,
        atcCode: null,
        drugId: null,
        drugRoute: null,
        metadataJson: {},
      },
    ],
    preop: {
      ageYears: 14,
      sex: "MALE",
      heightCm: 165,
      weightKg: 60,
      bpSystolic: 126,
      bpDiastolic: 74,
      heartRate: 82,
      spO2: 99,
      temperature: 36.7,
      respiratoryRate: 14,
      diagnosis: "fallback diagnosis",
      diagnosesJson: [],
      plannedProcedure: "fallback procedure",
      proceduresJson: [],
      comorbidities: [],
      asaScore: "I",
      emergencySurgery: false,
      highRiskSurgery: false,
      allergies: true,
      allergyDetails: null,
      smoking: false,
      substanceAbuse: false,
      currentMedications: null,
      rcriScore: 0,
      apfelScore: 1,
      stopBangScore: 1,
      difficultAirwayHistory: true,
      mallampati: "I",
      labResults: [],
      labRows: [
        { test: "Hemoglobin", valueNum: 180, value: "180", unitCanon: "g/L", loincCode: "718-7", abnormalFlag: "high", standardConceptId: 3000963, mappingStatus: "MAPPED" },
        { test: "Unknown lab", valueNum: 7, value: "7", unitCanon: null, loincCode: null, abnormalFlag: null, standardConceptId: null, mappingStatus: "UNMAPPED" },
      ],
      diagnoses: [
        { code: "K35", label: "Acute appendicitis", labelEn: "Acute appendicitis", labelBg: null, sourceVocabulary: "ICD10", sourceCode: "K35", standardConceptId: 12345, mappingStatus: "MAPPED", ordinal: 0 },
      ],
      procedureRows: [
        { code: "APPY", group: "Appendectomy", domain: "LOSPOR_PROCEDURE", description: "Laparoscopic appendectomy", sourceVocabulary: "LOSPOR_PROCEDURE", sourceCode: "APPY", standardConceptId: 23456, mappingStatus: "MAPPED", ordinal: 0 },
      ],
      comorbidityRows: [
        { label: "Source-only condition", labelEn: "Source-only condition", labelBg: null, code: "Z99", icd10Code: "Z99", sourceVocabulary: "ICD10", sourceCode: "Z99", standardConceptId: null, mappingStatus: "SOURCE_ONLY", ordinal: 0 },
      ],
      medications: [
        { kind: "CURRENT", nameRaw: "Diazepam", inn: "diazepam", atcCode: "N05BA01", dose: "5 mg", route: "PO", sourceVocabulary: "ATC", sourceCode: "N05BA01", standardConceptId: 19019905, mappingStatus: "MAPPED", ordinal: 0 },
      ],
    },
    intraop: {
      startTime,
      endTime,
      durationMinutes: 60,
      monthYear: "2026-06",
      techniques: ["general"],
      keyEvents: {},
      crystalloidsMl: 500,
      colloidsMl: 0,
      bloodMl: 0,
      urineMl: 100,
      complications: null,
      premedicationEvening: null,
      premedicationMorning: null,
      airwayDevice: "ett",
      vascularAccessRows: [{ site: "IJ", siteLabel: "Internal jugular", size: "18", sizeUnit: "G", depthCm: "8", lumens: "2", preexisting: true, ordinal: 0 }],
      premedicationRows: [{ phase: "evening", nameRaw: "Midazolam 2 mg PO", inn: null, atcCode: null, standardConceptId: null, mappingStatus: "SOURCE_ONLY", dose: "2 mg", route: "PO", ordinal: 0 }],
    },
    postop: {
      aldreteActivity: 2,
      aldreteRespiration: 2,
      aldreteCirculation: 2,
      aldreteConsciousness: 2,
      aldreteSpO2: 2,
      aldreteTotal: 10,
      recoveryBpSystolic: 120,
      recoveryBpDiastolic: 70,
      recoveryHeartRate: 80,
      recoverySpO2: 98,
      temperatureCelsius: 36.8,
      painScoreNRS: 2,
      ponv: false,
      disposition: "WARD",
      complications: null,
    },
    ...overrides,
  }
}

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
      source_version: "3.5.1",
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
      measurement: 24,
      procedure_occurrence: 3,
      observation: 22,
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
        measurement_source_value: "INTRAOP_FIO2_PERCENT",
        value_as_number: 50,
      }),
      expect.objectContaining({
        measurement_source_value: "POSTOP_LOINC:8480-6",
        value_as_number: 120,
      }),
    ]))
    expect(bundle.observation).toEqual(expect.arrayContaining([
      expect.objectContaining({ observation_source_value: "ASA_PHYSICAL_STATUS", value_as_string: "I" }),
      expect.objectContaining({ observation_source_value: "INTRAOP_CARRIER_GAS", value_as_string: "AIR/O2" }),
      expect.objectContaining({ observation_source_value: "PREMEDICATION_PHASE", value_as_string: "evening" }),
      expect.objectContaining({ observation_source_value: "INTRAOP_MONITORING", value_as_string: "ecg" }),
      expect.objectContaining({ observation_source_value: "POSTOP_COMPLICATION", value_as_string: "PONV; treated" }),
      expect.objectContaining({ observation_source_value: "POSTOP_DISPOSITION", value_as_string: "WARD" }),
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

    expect(bundle.metadata.source_version).toBe("3.5.1")
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
