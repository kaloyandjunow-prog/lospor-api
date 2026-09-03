import { describe, expect, it } from "vitest"
import { AIRWAY_ACTS, mapCasesToOmop } from "@/lib/omop-mapper"

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
      source_version: "3.8.0",
      included_case_count: 1,
      excluded_case_count: 2,
      app_git_commit: "abc123",
      data_quality_status: "WARNING",
      // Five mapped rows, not four: the second planned procedure the export
      // used to discard is now counted like the rest.
      mapping_summary: { mapped_rows: 5, manually_curated_rows: 0, rejected_rows: 0, source_only_rows: 3, unmapped_rows: 1 },
    }))
    expect(bundle.metadata.table_counts).toEqual({
      // PERSON and OBSERVATION_PERIOD are the OMOP root tables — without them
      // the bundle cannot be loaded by OHDSI tooling.
      person: 1,
      observation_period: 1,
      visit_occurrence: 1,
      condition_occurrence: 2,
      // Six: two preop (diazepam, premedication) + fentanyl + the propofol
      // infusion + the sevoflurane agent + the fluid administration. The last
      // three used to be one, two, or none of these.
      drug_exposure: 6,
      // Four more than before, and four fewer observations: Mallampati, mouth
      // opening, thyromental distance and the Cormack-Lehane grade moved from
      // unmapped LOSPOR observations to measurements carrying their SNOMED
      // concepts. The same facts, in the table that makes them poolable.
      // Two more, three fewer observations: BMI moved to measurement, and the
      // blood group is one row instead of a type row and a rhesus row.
      measurement: 38,
      // Two planned procedures + anaesthesia technique + vascular access.
      procedure_occurrence: 5,
      observation: 52,
    })
    expect(bundle.metadata.deidentification.direct_patient_identifiers_stored).toBe(false)

    expect(bundle.visit_occurrence[0]).toEqual(expect.objectContaining({
      visit_source_value: "RC-10000000-0000-4000-8000-000000000001",
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
        // Resolved when the event was written, like preop medications always
        // were. This was 0 while the ATC sat unused in the same row.
        drug_concept_id: 1154029,
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
    //
    // ASA itself is no longer here: it is a graded scale and now carries the
    // scale concept with the class as a coded answer, asserted above.
    expect(bundle.observation).toEqual(expect.arrayContaining([
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
      expect.objectContaining({ observation_source_value: "LOSPOR:APFEL", value_as_number: 1 }),
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
      expect.objectContaining({ observation_source_value: "LOSPOR:DIFFICULT_AIRWAY_HISTORY", value_as_string: "true", value_as_number: null }),
    ]))
    // The NRS pain score used to be emitted under concept 3020891 — body
    // temperature, copied from the vital map — which would have put a pain
    // score of 2 into any OHDSI temperature query.
    expect(bundle.observation.find(row => row.observation_source_value === "LOINC:72514-3")?.observation_concept_id).toBe(0)
    expect(bundle.metadata.quality_warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "UNMAPPED_CONCEPT_ROWS", severity: "warning", count: 1 }),
      expect.objectContaining({ code: "SOURCE_ONLY_CONCEPT_ROWS", severity: "info", count: 3 }),
      expect.objectContaining({ code: "EXACT_EVENT_TIMESTAMPS", severity: "info", count: 8 }),
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

    expect(bundle.metadata.source_version).toBe("3.8.0")
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
      // Finalised, but holding no finalization record: an interrupted or
      // corrupted finalization, which the export must refuse to treat as sound.
      finalizations: [],
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

/**
 * Three relations carry curated mappings that the export threw away.
 *
 * CaseSelection, CaseComplication and VascularAccess each hold
 * sourceVocabulary, sourceCode, standardConceptId and mappingStatus in the
 * database — someone reviewed and recorded them. CASE_SELECT fetched those
 * columns for six other relations and not for these three, so the mapper's row
 * types never had them and every concept_id was hardcoded 0.
 *
 * The effect was not a missing row. It was a row that said "this maps to
 * nothing", while the database held the mapping.
 */
describe("curated mappings reach the export", () => {
  const options = {
    userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
    excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
  }

  it("uses the reviewed concept for a vascular access procedure", () => {
    const bundle = mapCasesToOmop([completeCase() as never], options as never)
    const line = bundle.procedure_occurrence.find(row => /VASCULAR_ACCESS/.test(String(row.procedure_source_value)))
    expect(line, "fixture must contain a vascular access row").toBeDefined()
    expect(line!.procedure_concept_id).toBe(4052341)
  })

  it("uses the reviewed concept for a complication", () => {
    const bundle = mapCasesToOmop([completeCase() as never], options as never)
    const comp = bundle.observation.find(row => /COMPLICATION/.test(String(row.observation_source_value)))
    expect(comp, "fixture must contain a complication row").toBeDefined()
    expect(comp!.observation_concept_id).toBe(4166237)
  })

  it("uses the reviewed concept for a case selection", () => {
    const bundle = mapCasesToOmop([completeCase() as never], options as never)
    const sel = bundle.observation.find(row => row.observation_source_value === "LOSPOR:INTRAOP_MONITORING")
    expect(sel, "fixture must contain a monitoring selection").toBeDefined()
    expect(sel!.observation_concept_id).toBe(4145586)
  })

  it("still emits 0 when nothing was reviewed, rather than inventing one", () => {
    // The rule this file already follows: an unmapped row keeps its source
    // value and claims no concept. Fixing the three above must not turn into
    // guessing for the rest.
    const c = completeCase() as never as { selections: { standardConceptId: number | null }[] }
    c.selections[0].standardConceptId = null
    const bundle = mapCasesToOmop([c as never], options as never)
    const sel = bundle.observation.find(row => row.observation_source_value === "LOSPOR:INTRAOP_MONITORING")
    expect(sel!.observation_concept_id).toBe(0)
    expect(sel!.value_as_string).toBe("ecg")
  })
})

describe("every planned procedure is exported", () => {
  it("does not stop at the first one", () => {
    // Only procedureRows[0] was read. A case with two planned procedures
    // exported one, and nothing recorded that the rest had been discarded —
    // the count simply looked plausible.
    const bundle = mapCasesToOmop([completeCase() as never], {
      userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
      excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
    } as never)
    const planned = bundle.procedure_occurrence.filter(row => /LOSPOR_PROCEDURE:/.test(String(row.procedure_source_value)))
    expect(planned).toHaveLength(2)
    expect(planned.map(row => row.procedure_concept_id).sort()).toEqual([23456, 34567])
  })
})

describe("intraoperative drugs use the concept resolved when they were given", () => {
  it("maps a drug event whose ATC was resolved at write time", () => {
    // Preop medications have always exported a real drug_concept_id because
    // relational-sync resolved and stored one. Intraoperative drugs carried the
    // same ATC and exported 0, so the drugs actually administered — the ones a
    // pharmacovigilance or dosing study needs — were the unmapped half.
    const bundle = mapCasesToOmop([completeCase() as never], {
      userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
      excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
    } as never)
    const fentanyl = bundle.drug_exposure.find(row => /Fentanyl/.test(String(row.drug_source_value)))
    expect(fentanyl, "fixture must contain the intraoperative fentanyl event").toBeDefined()
    expect(fentanyl!.drug_concept_id).toBe(1154029)
    // The source code stays alongside it: a resolved concept never replaces the
    // evidence it was resolved from.
    expect(String(fentanyl!.drug_source_value)).toContain("N01AH01")
  })

  it("still exports 0 for an event nothing resolved", () => {
    const c = completeCase() as never as { events: { type: string; standardConceptId?: number | null }[] }
    for (const ev of c.events) if (ev.type === "drug") ev.standardConceptId = null
    const bundle = mapCasesToOmop([c as never], {
      userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
      excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
    } as never)
    const fentanyl = bundle.drug_exposure.find(row => /Fentanyl/.test(String(row.drug_source_value)))
    expect(fentanyl!.drug_concept_id).toBe(0)
  })
})

/**
 * A DRUG_EXPOSURE with a start and no end says the drug is still running.
 *
 * infusion_stop and agent_stop were skipped outright, so every infusion and
 * every volatile exported as open-ended. Duration — the thing most anaesthetic
 * research is actually about — could not be computed at all, and a forty-minute
 * infusion was indistinguishable from one that ran all day.
 */
describe("infusions and volatiles carry the interval they actually ran", () => {
  const options = {
    userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
    excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
  }

  it("closes an infusion at its stop event", () => {
    const bundle = mapCasesToOmop([completeCase() as never], options as never)
    const inf = bundle.drug_exposure.find(row => /Propofol/.test(String(row.drug_source_value)))
    expect(inf, "fixture must contain the propofol infusion").toBeDefined()
    expect(inf!.drug_exposure_start_date).toBe("2026-06-01")
    expect(inf!.drug_exposure_end_date).toBe("2026-06-01")
  })

  it("closes a volatile agent at its stop event", () => {
    const bundle = mapCasesToOmop([completeCase() as never], options as never)
    const agent = bundle.drug_exposure.find(row => /Sevoflurane/.test(String(row.drug_source_value)))
    expect(agent, "fixture must contain the sevoflurane agent").toBeDefined()
    expect(agent!.drug_exposure_end_date).toBe("2026-06-01")
  })

  it("leaves an unstopped infusion open rather than inventing an end", () => {
    // Still running when the case ended is a real state. Filling it in with the
    // case end time would manufacture a duration nobody recorded.
    const c = completeCase() as never as { events: { type: string }[] }
    c.events = c.events.filter(ev => ev.type !== "infusion_stop")
    const bundle = mapCasesToOmop([c as never], options as never)
    const inf = bundle.drug_exposure.find(row => /Propofol/.test(String(row.drug_source_value)))
    expect(inf!.drug_exposure_end_date).toBeNull()
  })
})

describe("fluids are exported as the events they were, not only as totals", () => {
  it("keeps the individual administration with its volume and time", () => {
    // CaseEvent.volume and fluidCategory were read from the database and
    // discarded, leaving only case totals — so when a litre went in was
    // unanswerable, which is the question in any resuscitation study.
    const bundle = mapCasesToOmop([completeCase() as never], {
      userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
      excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
    } as never)
    const fluid = bundle.drug_exposure.find(row => /Ringer/.test(String(row.drug_source_value)))
    expect(fluid, "fixture must contain the fluid event").toBeDefined()
    expect(fluid!.dose_value).toBe(500)
    expect(fluid!.drug_exposure_start_date).toBe("2026-06-01")
  })

  it("still reports the case totals alongside", () => {
    const bundle = mapCasesToOmop([completeCase() as never], {
      userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
      excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
    } as never)
    expect(bundle.observation).toEqual(expect.arrayContaining([
      expect.objectContaining({ observation_source_value: "LOSPOR:CRYSTALLOIDS_ML", value_as_number: 500 }),
    ]))
  })
})

/**
 * The institution used to be written onto every visit as care_site_source_value
 * — free text in a column no OHDSI tool reads, so "break these results down by
 * hospital" could not be answered by standard tooling. CARE_SITE is the CDM's
 * answer: one row per place, referenced by id.
 */
describe("care site is a dimension, not text repeated on every visit", () => {
  const options = {
    userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
    excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
  }

  it("emits one care site and links the visit to it by id", () => {
    const bundle = mapCasesToOmop([completeCase() as never], options as never)
    expect(bundle.care_site).toHaveLength(1)
    expect(bundle.care_site[0].care_site_source_value).toBe("inst-1")
    expect(bundle.visit_occurrence[0].care_site_id).toBe(bundle.care_site[0].care_site_id)
    // The source value stays: an unmatched care site must still be identifiable.
    expect(bundle.visit_occurrence[0].care_site_source_value).toBe("inst-1")
  })

  it("emits one row per place, not one per case", () => {
    // A hundred cases at one hospital is one care site. Emitting a row per case
    // would make the dimension useless for exactly the grouping it exists for.
    const a = completeCase() as never as { id: string; caseCode: string }
    const b = completeCase() as never as { id: string; caseCode: string }
    b.id = "case-2"; b.caseCode = "2026-0002"
    const bundle = mapCasesToOmop([a as never, b as never], options as never)
    expect(bundle.visit_occurrence).toHaveLength(2)
    expect(bundle.care_site).toHaveLength(1)
  })

  it("emits no care site when the case records no institution", () => {
    const c = completeCase() as never as { institutionId: string | null }
    c.institutionId = null
    const bundle = mapCasesToOmop([c as never], options as never)
    expect(bundle.care_site).toHaveLength(0)
    expect(bundle.visit_occurrence[0].care_site_id).toBeNull()
  })
})

/**
 * Yes, no, and never asked have to survive to the export as three things.
 *
 * These fields were Boolean @default(false), so a row was born asserting "no"
 * to every question. ClinicalFieldPresence derives ABSENT from false, so the
 * ambiguity propagated: a researcher counting patients without a difficult
 * airway history was counting everyone nobody had asked.
 */
describe("a clinical question distinguishes no from never asked", () => {
  const options = {
    userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
    excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
  }
  function withAirwayHistory(value: boolean | null) {
    const c = completeCase() as never as { preop: { difficultAirwayHistory: boolean | null } }
    c.preop.difficultAirwayHistory = value
    return mapCasesToOmop([c as never], options as never)
  }
  const airwayRow = (bundle: ReturnType<typeof mapCasesToOmop>) =>
    bundle.observation.find(row => row.observation_source_value === "LOSPOR:DIFFICULT_AIRWAY_HISTORY")

  it("exports a yes", () => {
    expect(airwayRow(withAirwayHistory(true))?.value_as_string).toBe("true")
  })

  it("exports a no, rather than staying silent about it", () => {
    // An answered "no" is a clinical finding. Emitting nothing would make it
    // indistinguishable from a question nobody asked.
    expect(airwayRow(withAirwayHistory(false))?.value_as_string).toBe("false")
  })

  it("exports nothing at all when the question was never asked", () => {
    expect(airwayRow(withAirwayHistory(null))).toBeUndefined()
  })
})

describe("airway management", () => {
  const omop = (intraop: Record<string, unknown>) => {
    const base = completeCase() as unknown as { intraop: Record<string, unknown> }
    return mapCasesToOmop([{ ...base, intraop: { ...base.intraop, ...intraop } } as never], {
      userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
      excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
    })
  }
  const obs = (bundle: ReturnType<typeof omop>, code: string) =>
    bundle.observation.filter(o => o.observation_source_value === code)
  const airwayProcs = (bundle: ReturnType<typeof omop>) =>
    bundle.procedure_occurrence
      .filter(p => p.procedure_source_value?.startsWith("AIRWAY_MANAGEMENT:"))
      .map(p => p.procedure_source_value)

  it("exports the detail that used to never leave", () => {
    // None of this reached an export before. A case could say a tube was
    // placed but not which, what size, whether it was cuffed, or how difficult
    // the view was -- the substance of any difficult-airway study.
    const bundle = omop({})
    // The laryngoscopy grade is a measurement carrying its SNOMED scale
    // concept, not an unmapped observation. SNOMED collapses the Cook
    // subdivision to grade 2, so IIa maps to the grade-2 concept while the
    // exact subgrade survives in value_source_value.
    const cormack = bundle.measurement.filter(m => m.measurement_source_value === "LOSPOR:CORMACK_LEHANE")
    expect(cormack).toHaveLength(1)
    expect(cormack[0].measurement_concept_id).toBe(37398987)
    expect(cormack[0].value_as_concept_id).toBe(4221760)
    expect(cormack[0].value_source_value).toBe("IIa")
    expect(obs(bundle, "LOSPOR:ORAL_TUBE_SIZE")[0]?.value_as_number).toBe(7.5)
    expect(obs(bundle, "LOSPOR:ORAL_TUBE_CUFFED")[0]?.value_as_string).toBe("true")
    expect(obs(bundle, "LOSPOR:PEEP_CMH2O")[0]?.value_as_number).toBe(5)
    expect(obs(bundle, "LOSPOR:AIRWAY_TOOL").map(o => o.value_as_string).sort())
      .toEqual(["BOUGIE", "VIDEO_LARY"])
    expect(obs(bundle, "LOSPOR:VENTILATION_MODE")[0]?.value_as_string).toBe("VCV")
  })

  it("puts a size in value_as_number, not only in text", () => {
    // A size written only as a string cannot be averaged or thresholded
    // without casting it back, which is the mistake 3.7.0 fixed elsewhere.
    const bundle = omop({ dltSize: 39, lmaSize: 4 })
    expect(obs(bundle, "LOSPOR:DLT_SIZE")[0]?.value_as_number).toBe(39)
    expect(obs(bundle, "LOSPOR:LMA_SIZE")[0]?.value_as_number).toBe(4)
  })

  it("records a boolean airway finding as text, not as a number", () => {
    // "true" in value_as_number would be indistinguishable from a score of 1.
    const bundle = omop({})
    expect(obs(bundle, "LOSPOR:JET_VENTILATION")[0]).toMatchObject({
      value_as_string: "false", value_as_number: null,
    })
  })

  it("merges the legacy device column with the current list without duplicating", () => {
    // Rows written across the single-column-to-list change carry both. Taking
    // one and ignoring the other would drop a device; taking both naively
    // would export the same device twice.
    const both = omop({ airwayDevice: "ORAL_ETT", airwayDevices: ["ORAL_ETT", "LMA"] })
    expect(obs(both, "LOSPOR:AIRWAY_DEVICE").map(o => o.value_as_string).sort())
      .toEqual(["LMA", "ORAL_ETT"])

    // A legacy row has only the single column, and it must still be exported.
    const legacyOnly = omop({ airwayDevice: "NASAL_ETT", airwayDevices: [] })
    expect(obs(legacyOnly, "LOSPOR:AIRWAY_DEVICE").map(o => o.value_as_string))
      .toEqual(["NASAL_ETT"])
  })

  it("separates being intubated from having a tube", () => {
    // A device is a state of the patient; placing it is an act performed on
    // them. Exporting only the observation means no procedure count can ever
    // find the intubation.
    const bundle = omop({ airwayDevice: null, airwayDevices: ["ORAL_ETT"] })
    expect(obs(bundle, "LOSPOR:AIRWAY_DEVICE")).toHaveLength(1)
    expect(airwayProcs(bundle)).toEqual(["AIRWAY_MANAGEMENT:TRACHEAL_INTUBATION_ORAL"])
  })

  it("does not invent a procedure for an airway that was applied, not placed", () => {
    // Counting a face mask as an airway procedure would inflate every such
    // count, and the inflation would look like a real clinical signal.
    const bundle = omop({ airwayDevice: null, airwayDevices: ["FACE_MASK", "OPA", "NPA"] })
    expect(obs(bundle, "LOSPOR:AIRWAY_DEVICE")).toHaveLength(3)
    expect(airwayProcs(bundle)).toEqual([])
  })

  it("emits one act per instrumented device", () => {
    const bundle = omop({
      airwayDevice: null,
      airwayDevices: ["FACE_MASK", "LMA", "DOUBLE_LUMEN_TUBE"],
    })
    expect(airwayProcs(bundle).sort()).toEqual([
      "AIRWAY_MANAGEMENT:DOUBLE_LUMEN_TUBE_PLACEMENT",
      "AIRWAY_MANAGEMENT:SUPRAGLOTTIC_AIRWAY_PLACEMENT",
    ])
  })

  it("stays silent about an airway nobody recorded", () => {
    const bundle = omop({
      airwayDevice: null, airwayDevices: [], cormackLehane: null,
      airwayTools: [], ventilationModes: [], oralTubeSize: null, oralCuffed: null,
      peepCmH2O: null, fob: null, ippv: null, jetVentilation: null,
    })
    expect(obs(bundle, "LOSPOR:AIRWAY_DEVICE")).toEqual([])
    expect(obs(bundle, "LOSPOR:CORMACK_LEHANE")).toEqual([])
    expect(airwayProcs(bundle)).toEqual([])
  })
})

describe("AIRWAY_ACTS", () => {
  it("classifies every device the catalogue offers", async () => {
    // The device list is seeded from @lospor/core and can grow. A device
    // missing from the map exports no procedure at all, and the failure would
    // be an absence -- no error, no warning, a case that was intubated simply
    // not counted as one. Adding a device must break this test, not the data.
    const { AIRWAY_DEVICES } = await import("@lospor/core/catalog")
    const catalogued = AIRWAY_DEVICES.map(([value]) => value).sort()
    expect(Object.keys(AIRWAY_ACTS).sort()).toEqual(catalogued)
  })

  it("names an act for every device that is instrumented", () => {
    // The null entries are a deliberate classification, not an oversight, so
    // this pins which devices are held to have no procedure.
    const noAct = Object.entries(AIRWAY_ACTS).filter(([, act]) => act == null).map(([d]) => d)
    expect(noAct.sort()).toEqual(["FACE_MASK", "NPA", "OPA"])
  })
})

describe("clinical data that used to never leave", () => {
  const bundle = () => mapCasesToOmop([completeCase() as never], {
    userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
    excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
  })
  const obs = (code: string) =>
    bundle().observation.filter(o => o.observation_source_value === code)

  it("exports smoking and substance use", () => {
    // A register exists partly to study these, and they left the appliance
    // nowhere at all: read out of the database, carried through the mapper's
    // row types, written to no table.
    expect(obs("LOSPOR:SMOKING")[0]?.value_as_string).toBe("false")
    expect(obs("LOSPOR:SUBSTANCE_ABUSE")[0]?.value_as_string).toBe("false")
  })

  it("exports the rest of the preop history", () => {
    expect(obs("LOSPOR:LATEX_ALLERGY")[0]?.value_as_string).toBe("false")
    expect(obs("LOSPOR:FAMILY_ANAESTHESIA_PROBLEMS")[0]?.value_as_string).toBe("true")
    expect(obs("LOSPOR:DENTAL_PROSTHETICS")[0]?.value_as_string).toBe("false")
    expect(obs("LOSPOR:HEART_ARRHYTHMIA")[0]?.value_as_string).toBe("false")
    expect(obs("LOSPOR:GUTA_SCORE")[0]?.value_as_number).toBe(2)
  })

  it("measures body mass index rather than observing it", () => {
    // A quantity with a standard concept and a unit belongs in measurement.
    const bmi = bundle().measurement.filter(row => row.measurement_source_value === "LOSPOR:BMI")

    expect(bmi).toHaveLength(1)
    expect(bmi[0]).toMatchObject({ measurement_concept_id: 4245997, value_as_number: 24.2 })
  })

  it("writes a blood group as one fact rather than two", () => {
    // "A positive" is what a crossmatch label says and what a transfusion query
    // asks for. As separate group and rhesus rows it is findable only by
    // joining them back together.
    const group = bundle().measurement.filter(row => row.measurement_source_value === "LOSPOR:BLOOD_GROUP")

    expect(group).toHaveLength(1)
    expect(group[0]).toMatchObject({
      measurement_concept_id: 3003694,
      value_as_concept_id: 4082948,
      value_source_value: "A+",
    })
  })

  it("exports the airway examination separately from the airway history", () => {
    // A predictive study needs what was found on examining this patient, not
    // only whether a previous anaesthetist had trouble.
    // The two distances are quantities with standard concepts, so they are
    // measurements now rather than LOSPOR-only observations: an airway study
    // elsewhere can pool them without being told what our codes mean.
    const airway = (source: string) =>
      bundle().measurement.filter(m => m.measurement_source_value === source)
    expect(airway("LOSPOR:MOUTH_OPENING_CM")[0]?.value_as_number).toBe(4.5)
    expect(airway("LOSPOR:MOUTH_OPENING_CM")[0]?.measurement_concept_id).toBe(4303387)
    expect(airway("LOSPOR:THYROMENTAL_DISTANCE_CM")[0]?.value_as_number).toBe(6.5)
    expect(airway("LOSPOR:THYROMENTAL_DISTANCE_CM")[0]?.measurement_concept_id).toBe(4142891)
    // Neck mobility is a graded scale now, so it is a measurement carrying the
    // range as a coded answer rather than an observation carrying the word.
    const neck = bundle().measurement.filter(r => r.measurement_source_value === "LOSPOR:NECK_MOBILITY")
    expect(neck).toHaveLength(1)
    expect(neck[0]).toMatchObject({ measurement_concept_id: 4039256, value_as_concept_id: 4124732, value_source_value: "FULL" })
    expect(obs("LOSPOR:UPPER_LIP_BITE_TEST")[0]?.value_as_string).toBe("CLASS_I")
    expect(obs("LOSPOR:RETROGNATHIA")[0]?.value_as_string).toBe("false")
    expect(obs("LOSPOR:PROMINENT_INCISORS")[0]?.value_as_string).toBe("true")
  })

  it("still says nothing about a question nobody asked", () => {
    // looseTeeth and facialHair are null in the fixture. The point of the
    // nullable columns is that this stays distinguishable from a "no", and a
    // stage that exports everything must not quietly undo it.
    expect(obs("LOSPOR:LOOSE_TEETH")).toEqual([])
    expect(obs("LOSPOR:FACIAL_HAIR")).toEqual([])
  })

  it("carries free-text detail, redacted upstream", () => {
    expect(obs("LOSPOR:ALLERGY_DETAILS")[0]?.value_as_string).toBe("Penicillin, shellfish")
    expect(obs("LOSPOR:DIFFICULT_AIRWAY_NOTES")[0]?.value_as_string)
      .toBe("Grade III view at previous laparotomy")
  })
})

describe("laboratory results", () => {
  const bundle = () => mapCasesToOmop([completeCase() as never], {
    userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
    excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
  })
  const lab = (source: string) =>
    bundle().measurement.find(m => m.measurement_source_value === source)

  it("keeps a result the lab reported as text", () => {
    // This used to be skipped for having no parsed number, so a culture, a
    // dipstick or a blood group left no trace of having been recorded at all.
    const culture = lab("LAB:Urine culture")
    expect(culture).toBeDefined()
    expect(culture?.value_as_number).toBeNull()
    expect(culture?.value_source_value).toBe("No growth")
  })

  it("carries the reference range a result was judged against", () => {
    // Reference ranges differ by laboratory, assay and patient age. Without
    // the range, "high" is an assertion the export cannot support.
    const hb = lab("LOINC:718-7")
    expect(hb?.value_as_number).toBe(180)
    expect(hb?.range_low).toBe(130)
    expect(hb?.range_high).toBe(175)
  })

  it("carries the abnormal flag, keyed to the measurement it describes", () => {
    // CDM 5.4 has no abnormal-flag column, so the flag rides as its own
    // observation using the same source value the measurement row carries.
    const flags = bundle().observation
      .filter(o => o.observation_source_value === "LOSPOR:LAB_ABNORMAL_FLAG")
      .map(o => o.value_as_string)
    expect(flags).toContain("LOINC:718-7=high")
  })

  it("drops a row that is neither a number nor text", () => {
    // A result with no value is not a result, and exporting an empty
    // measurement would inflate every count of tests performed.
    const base = completeCase() as unknown as { preop: { labRows: unknown[] } }
    const withEmpty = mapCasesToOmop([{
      ...base,
      preop: { ...base.preop, labRows: [{ test: "Nothing", valueNum: null, value: null, unitCanon: null, loincCode: null, abnormalFlag: null, referenceLow: null, referenceHigh: null, standardConceptId: null, mappingStatus: "UNMAPPED" }] },
    } as never], {
      userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
      excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
    })
    expect(withEmpty.measurement.find(m => m.measurement_source_value === "LAB:Nothing")).toBeUndefined()
  })
})

describe("vascular access", () => {
  const bundle = mapCasesToOmop([completeCase() as never], {
    userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
    excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
  })
  const obs = (code: string) =>
    bundle.observation.filter(o => o.observation_source_value === code)

  it("exports depth, lumens and whether the line was already there", () => {
    // The last one matters most: a pre-existing line was not placed during
    // this case, so counting its procedure row as work done here overstates
    // what the anaesthetist did.
    expect(obs("LOSPOR:VASCULAR_ACCESS_DEPTH_CM")[0]?.value_as_number).toBe(8)
    expect(obs("LOSPOR:VASCULAR_ACCESS_LUMENS")[0]?.value_as_number).toBe(2)
    expect(obs("LOSPOR:VASCULAR_ACCESS_PREEXISTING")[0]?.value_as_string)
      .toBe("Internal jugular=true")
  })
})

describe("mapping summary provenance", () => {
  const summaryFor = (mappingStatus: string) => {
    const base = completeCase() as unknown as { preop: { diagnoses: Record<string, unknown>[] } }
    const bundle = mapCasesToOmop([{
      ...base,
      preop: {
        ...base.preop,
        diagnoses: [{ ...base.preop.diagnoses[0], mappingStatus }],
      },
    } as never], {
      userId: "admin-1", userRole: "ADMIN", statusFilter: ["COMPLETE"],
      excludedCaseCount: 0, gitCommit: "abc123", forcedOverride: false,
    })
    return bundle.metadata.mapping_summary
  }

  it("counts a curated mapping as mapped, and also on its own", () => {
    // The concept applies, so it belongs in mapped_rows. It is also counted
    // separately, because a summary that reports only "mapped" invites a
    // reader to trust a string-similarity score as if a clinician had signed
    // it off.
    const curated = summaryFor("MANUALLY_CURATED")
    const automatic = summaryFor("MAPPED")
    expect(curated.mapped_rows).toBe(automatic.mapped_rows)
    expect(curated.manually_curated_rows).toBe(1)
    expect(automatic.manually_curated_rows).toBe(0)
  })

  it("does not count a rejected mapping as part of the unmapped backlog", () => {
    // Unmapped means nobody has looked. Rejected means someone looked and said
    // no. Folding them together makes finished review work look like an
    // outstanding task forever.
    const rejected = summaryFor("REJECTED")
    const unmapped = summaryFor("UNMAPPED")
    expect(rejected.rejected_rows).toBe(1)
    expect(unmapped.rejected_rows).toBe(0)
    // The one row that differs moved out of the backlog, and nowhere else.
    expect(rejected.unmapped_rows).toBe(unmapped.unmapped_rows - 1)
    expect(rejected.mapped_rows).toBe(unmapped.mapped_rows)
    expect(rejected.source_only_rows).toBe(unmapped.source_only_rows)
  })
})

describe("one source answer is one row", () => {
  // A source concept with both a Maps to and a Maps to value describes one
  // fact, and the OHDSI convention puts both halves in a single row. Emitting
  // them as two made one latex-allergic patient count twice under
  // observation_concept_id 43530807 — the same double-count that keeps urgency
  // off procedure_occurrence, reproduced one field later.
  const latexRows = (latexAllergy: boolean | null) => {
    const base = completeCase() as Record<string, unknown>
    const preop = { ...(base.preop as Record<string, unknown>), latexAllergy }
    return mapCasesToOmop([{ ...base, preop } as never]).observation
      .filter(row => row.observation_concept_id === 43530807)
  }

  it("counts a latex-allergic patient once, not twice", () => {
    expect(latexRows(true)).toHaveLength(1)
    expect(latexRows(true)[0].value_as_concept_id).toBe(4188539)
  })

  it("keeps the denial, which is a safety check rather than an absence", () => {
    expect(latexRows(false)).toHaveLength(1)
    expect(latexRows(false)[0].value_as_concept_id).toBe(4188540)
  })

  it("says nothing at all when the question was never asked", () => {
    expect(latexRows(null)).toHaveLength(0)
  })
})

describe("the risk scores that have a concept", () => {
  // SNOMED models each score as a single scale with no decomposition — there
  // is no concept for "RCRI criterion 2" — so the criteria are exported as the
  // ordinary conditions they are, and reconstructing a score means looking for
  // those rather than for score components.
  const scored = (source: string) => mapCasesToOmop([completeCase() as never])
    .measurement.filter(row => row.measurement_source_value === source)

  it("writes RCRI and STOP-BANG as measurements a tool can find", () => {
    expect(scored("LOSPOR:RCRI")[0]).toMatchObject({ measurement_concept_id: 40488922, value_as_number: 0 })
    expect(scored("LOSPOR:STOP_BANG")[0]).toMatchObject({ measurement_concept_id: 46286812, value_as_number: 1 })
  })

  it("leaves Apfel where no concept exists, rather than borrowing a wrong one", () => {
    // Every near match is postoperative vomiting itself, which is the outcome
    // these scores predict and not the prediction.
    const apfel = mapCasesToOmop([completeCase() as never])
      .observation.filter(row => row.observation_source_value === "LOSPOR:APFEL")

    expect(apfel).toHaveLength(1)
    expect(apfel[0].observation_concept_id).toBe(0)
  })
})

describe("the anaesthesia history that is about the patient, not their family", () => {
  const withPreop = (patch: Record<string, unknown>) => {
    const c = completeCase() as unknown as { preop: Record<string, unknown> }
    Object.assign(c.preop, patch)
    return c as never
  }
  const obs = (source: string, value: boolean | null) => {
    const key = source === "LOSPOR:MALIGNANT_HYPERTHERMIA_HISTORY"
      ? "malignantHyperthermiaHistory"
      : "unexplainedAnaesthesiaComplications"
    return mapCasesToOmop([withPreop({ [key]: value })]).observation
      .filter(row => row.observation_source_value === source)
  }

  it("codes a personal malignant hyperthermia history separately from the family question", () => {
    // These were the same question until now: a patient who had had MH himself
    // could only be recorded through familyAnesthesiaProblems, which is about
    // relatives, or in free text. They are different concepts and now different
    // rows.
    const mine = obs("LOSPOR:MALIGNANT_HYPERTHERMIA_HISTORY", true)
    const family = mapCasesToOmop([completeCase() as never]).observation
      .filter(row => row.observation_source_value === "LOSPOR:FAMILY_ANAESTHESIA_PROBLEMS")

    expect(mine[0]).toMatchObject({ observation_concept_id: 440285, value_as_concept_id: 4188539 })
    expect(family[0].observation_concept_id).not.toBe(440285)
  })

  it("records a denied malignant hyperthermia history as a denial", () => {
    // The whole reason the field is tri-state. "Asked, and the patient said no"
    // is a safety check another anaesthetist relies on; it must not read as
    // "nobody asked".
    expect(obs("LOSPOR:MALIGNANT_HYPERTHERMIA_HISTORY", false)[0])
      .toMatchObject({ observation_concept_id: 440285, value_as_concept_id: 4188540 })
    expect(obs("LOSPOR:MALIGNANT_HYPERTHERMIA_HISTORY", null)).toHaveLength(0)
  })

  it("codes an unexplained event to the operative complication, not to a drug reaction", () => {
    // 4171869 (Anesthetics adverse reaction) is the tempting match and names a
    // cause. This field exists for the events where nobody could.
    const row = obs("LOSPOR:UNEXPLAINED_ANAESTHESIA_COMPLICATIONS", true)[0]

    expect(row.observation_concept_id).toBe(37017043)
    expect(row.value_as_concept_id).toBe(4188539)
  })

  it("keeps all three states of the unexplained-event question apart", () => {
    expect(obs("LOSPOR:UNEXPLAINED_ANAESTHESIA_COMPLICATIONS", false)[0].value_as_concept_id).toBe(4188540)
    expect(obs("LOSPOR:UNEXPLAINED_ANAESTHESIA_COMPLICATIONS", null)).toHaveLength(0)
  })
})

describe("the airway examination findings that gained a concept", () => {
  const airway = (source: string) => mapCasesToOmop([completeCase() as never]).observation
    .filter(row => row.observation_source_value === source)

  it("codes an anticipated difficult airway as a risk rather than an expectation", () => {
    // 37397720 (Expected difficult tracheal intubation) is the closer wording
    // and the stronger claim. Bedside tests predict poorly, so most patients
    // flagged here are intubated uneventfully, and an expectation the case then
    // contradicts reads like an error rather than a precaution that paid off.
    const row = airway("LOSPOR:ANTICIPATED_DIFFICULT_AIRWAY")[0]

    expect(row.observation_concept_id).toBe(37159176)
    expect(row.value_as_concept_id).toBe(4188539)
  })

  it("codes prominent incisors, which an earlier search wrongly gave up on", () => {
    // That search only tried dysmorphology phrasings and came back with HPO
    // entries this product does not ship. The plain SNOMED term was always
    // there.
    expect(airway("LOSPOR:PROMINENT_INCISORS")[0])
      .toMatchObject({ observation_concept_id: 4033016, value_as_concept_id: 4188539 })
  })

  it("leaves facial hair uncoded, because every candidate means hirsutism", () => {
    // An ordinary beard is not a pathological finding, and coding it as one
    // would put every bearded patient into a hirsutism cohort. The conclusion a
    // beard feeds — whether difficulty is anticipated — is what carries a
    // concept instead.
    const c = completeCase() as unknown as { preop: Record<string, unknown> }
    c.preop.facialHair = true

    expect(mapCasesToOmop([c as never]).observation
      .filter(row => row.observation_source_value === "LOSPOR:FACIAL_HAIR")[0].observation_concept_id).toBe(0)
  })
})

describe("the rows that were saying the same thing twice", () => {
  const bundle = () => mapCasesToOmop([completeCase() as never])
  const obs = (source: string) => bundle().observation
    .filter(row => row.observation_source_value === source)

  it("carries age as a measurement with a concept and a unit", () => {
    // OMOP tooling normally derives age from person.year_of_birth and a visit
    // date. This register coarsens the birth year deliberately, so the recorded
    // age is the more precise of the two and is worth its own row.
    const age = bundle().measurement
      .filter(row => row.measurement_source_value === "LOSPOR:AGE_YEARS")

    expect(age).toHaveLength(1)
    expect(age[0]).toMatchObject({
      measurement_concept_id: 4314456,
      value_as_number: 14,
      unit_concept_id: 9448,
      unit_source_value: "a",
    })
    expect(obs("LOSPOR:AGE_YEARS")).toHaveLength(0)
  })

  it("states surgical urgency once, on the procedure", () => {
    // It used to be here as well, at concept 0, so a query that counted both
    // counted every emergency case twice.
    expect(obs("LOSPOR:EMERGENCY_SURGERY")).toHaveLength(0)
    expect(bundle().procedure_occurrence.some(row => row.modifier_concept_id !== 0)).toBe(true)
  })

  it("does not export clinical mode", () => {
    // Provenance about how this product computed a case, not a fact about the
    // patient — and the fact a researcher would reach for it for is age, which
    // answers the same question exactly rather than approximately.
    expect(obs("LOSPOR:CLINICAL_MODE")).toHaveLength(0)
  })
})

describe("what anaesthetic was given", () => {
  const proc = (c: unknown) => mapCasesToOmop([c as never]).procedure_occurrence
  const withTechniques = (techniques: string[], devices: string[] = []) => {
    const c = completeCase() as unknown as {
      intraop: Record<string, unknown>
    }
    c.intraop.techniques = techniques
    if (devices.length) c.intraop.airwayDevices = devices
    return c
  }
  const techRow = (code: string) => proc(withTechniques([code]))
    .find(row => row.procedure_source_value === `ANAESTHESIA_TECHNIQUE:${code}`)

  it("codes the four techniques that have a concept", () => {
    // Until now every anaesthetic in the register exported at concept 0, so the
    // register could not say, in any coded form, what anaesthetic was given.
    expect(techRow("GENERAL")?.procedure_concept_id).toBe(4174669)
    expect(techRow("SPINAL")?.procedure_concept_id).toBe(4332593)
    expect(techRow("EPIDURAL")?.procedure_concept_id).toBe(4078199)
    expect(techRow("SEDATION")?.procedure_concept_id).toBe(4219502)
  })

  it("gives a node below a coded one its nearest coded ancestor", () => {
    // The tree is deeper than the vocabulary. A lumbar single-shot spinal is a
    // spinal anaesthetic, and coding it as one is true; inventing a concept for
    // the exact node would not be.
    expect(techRow("SPINAL_SINGLE_LUMBAR")?.procedure_concept_id).toBe(4332593)
    expect(techRow("SPINAL_CONT_MID_THORACIC")?.procedure_concept_id).toBe(4332593)
    expect(techRow("EPIDURAL_CAUDAL")?.procedure_concept_id).toBe(4078199)
  })

  it("keeps the exact node the anaesthetist chose", () => {
    // The whole point of coding at the ancestor: nothing is flattened away.
    // "Single shot, lumbar" is still readable off the row.
    expect(techRow("SPINAL_SINGLE_LUMBAR")?.procedure_source_value)
      .toBe("ANAESTHESIA_TECHNIQUE:SPINAL_SINGLE_LUMBAR")
  })

  it("codes the block regions, so most of the peripheral tree inherits something true", () => {
    // SNOMED has a "Local anesthetic nerve block in <region>" family that
    // mirrors this part of the tree almost exactly, so four nodes cover roughly
    // forty leaves and each leaf can be refined later without touching a stored
    // value.
    expect(techRow("BLOCK_TAP")?.procedure_concept_id).toBe(4125199)
    expect(techRow("BLOCK_INTERSCALENE")?.procedure_concept_id).toBe(4332443)
    expect(techRow("BLOCK_FEMORAL")?.procedure_concept_id).toBe(4333960)
  })

  it("leaves a technique with no coded ancestor at 0 rather than guessing", () => {
    // REGIONAL is mappable — 4100052 is correct and verified — and is held back
    // deliberately. Mapping the root would make every undecided node beneath it
    // inherit "Regional anesthesia" and read as finished, and concept 0 is what
    // currently says nobody has decided this one yet.
    expect(techRow("REGIONAL")?.procedure_concept_id).toBe(0)
    // OTHER is the free-text escape at the top of the tree and will never carry
    // a concept: whatever it means is in the source value.
    expect(techRow("OTHER")?.procedure_concept_id).toBe(0)
    // Nor does an unrecognised code reach for something plausible.
    expect(techRow("NOT_A_REAL_NODE")?.procedure_concept_id).toBe(0)
  })

  it("codes an oral intubation, and only that airway act so far", () => {
    const rows = proc(withTechniques(["GENERAL"], ["ORAL_ETT", "LMA"]))
    const oral = rows.find(r => r.procedure_source_value === "AIRWAY_MANAGEMENT:TRACHEAL_INTUBATION_ORAL")
    const lma = rows.find(r => r.procedure_source_value === "AIRWAY_MANAGEMENT:SUPRAGLOTTIC_AIRWAY_PLACEMENT")

    expect(oral?.procedure_concept_id).toBe(4335481)
    // Undecided rather than unmapped-by-oversight: a supraglottic airway is a
    // different procedure with a different concept, and guessing it would look
    // exactly like having chosen it.
    expect(lma?.procedure_concept_id).toBe(0)
  })
})

describe("the rest of the technique tree", () => {
  const techRow = (code: string) => {
    const c = completeCase() as unknown as { intraop: Record<string, unknown> }
    c.intraop.techniques = [code]
    return mapCasesToOmop([c as never]).procedure_occurrence
      .find(row => row.procedure_source_value === `ANAESTHESIA_TECHNIQUE:${code}`)
  }

  it("codes the neuraxial family, each as itself", () => {
    // A combined spinal-epidural is not a spinal with an epidural noted beside
    // it, and a dural puncture epidural is not an ordinary one. Both have their
    // own concept, which is why neither was folded into a neighbour earlier.
    expect(techRow("NEURAXIAL")?.procedure_concept_id).toBe(4228322)
    expect(techRow("CSE")?.procedure_concept_id).toBe(4335024)
    expect(techRow("DPE")?.procedure_concept_id).toBe(37159083)
    expect(techRow("CSE_LUMBAR")?.procedure_concept_id).toBe(4335024)
  })

  it("codes head and neck blocks at their own region", () => {
    // They inherited the peripheral umbrella until now, which was true but
    // coarser than the vocabulary allows.
    expect(techRow("BLOCK_HEAD_NECK")?.procedure_concept_id).toBe(4125198)
    expect(techRow("BLOCK_SCALP")?.procedure_concept_id).toBe(4125198)
  })

  it("codes the eye blocks one by one rather than under a false umbrella", () => {
    // 4123783 (Ocular infiltration of local anesthetic) is the tempting parent
    // and is flatly false for the topical case, where nothing is infiltrated.
    expect(techRow("BLOCK_PERIBULBAR")?.procedure_concept_id).toBe(4123785)
    expect(techRow("BLOCK_RETROBULBAR")?.procedure_concept_id).toBe(4123784)
    expect(techRow("BLOCK_TOPICAL_EYE")?.procedure_concept_id).toBe(4335044)
  })

  it("leaves sub-Tenon's on the peripheral umbrella, because nothing better exists", () => {
    // A real vocabulary gap, not a search that gave up: the only matches for
    // "tenon" anywhere in CONCEPT.csv are drug names and orbital inflammation.
    // A widely used technique with no concept.
    expect(techRow("BLOCK_SUB_TENONS")?.procedure_concept_id).toBe(4140397)
  })
})

describe("how a general anaesthetic was maintained", () => {
  const techRow = (code: string) => {
    const c = completeCase() as unknown as { intraop: Record<string, unknown> }
    c.intraop.techniques = [code]
    return mapCasesToOmop([c as never]).procedure_occurrence
      .find(row => row.procedure_source_value === `ANAESTHESIA_TECHNIQUE:${code}`)
  }

  it("tells inhalational and TIVA apart", () => {
    // Both used to inherit the general-anaesthesia parent, so the register
    // could not answer the question the specialty most often asks of it —
    // volatile against total intravenous, for PONV, emergence and oncological
    // outcome.
    expect(techRow("GENERAL_INHALATION")?.procedure_concept_id).toBe(4118897)
    expect(techRow("GENERAL_TIVA")?.procedure_concept_id).toBe(4086418)
  })

  it("keeps a balanced anaesthetic at the parent, deliberately", () => {
    // Neither sibling is true of it. TIVA means *total* intravenous, so a case
    // running a volatile is not TIVA, and it is not inhalation-only either.
    // The parent is the right answer rather than a fallback, and this test is
    // here so nobody later "corrects" it to one of the other two.
    expect(techRow("GENERAL_BALANCED")?.procedure_concept_id).toBe(4171773)
  })
})

describe("a general-anaesthetic cohort catches every maintenance route", () => {
  const techRow = (code: string) => {
    const c = completeCase() as unknown as { intraop: Record<string, unknown> }
    c.intraop.techniques = [code]
    return mapCasesToOmop([c as never]).procedure_occurrence
      .find(row => row.procedure_source_value === `ANAESTHESIA_TECHNIQUE:${code}`)
  }

  it("codes GENERAL as the true parent of all three maintenance routes", () => {
    // 4171773 (Operative general anesthesia) looked like the right node and is
    // not: it is a sibling of GENERAL_INHALATION and GENERAL_TIVA under this
    // concept, not their ancestor. An ATLAS cohort built on 4171773 +
    // descendants would have missed every inhalational and every TIVA case --
    // the opposite of what a "general anaesthetic" filter should return.
    // 4174669 is verified, against CONCEPT_ANCESTOR, as the true parent of all
    // three, and its descendant set stops at general anaesthesia: sedation
    // sits elsewhere, under 4249997, so this does not also sweep in sedation
    // cases.
    expect(techRow("GENERAL")?.procedure_concept_id).toBe(4174669)
    expect(techRow("GENERAL_INHALATION")?.procedure_concept_id).toBe(4118897)
    expect(techRow("GENERAL_TIVA")?.procedure_concept_id).toBe(4086418)
    expect(techRow("GENERAL_BALANCED")?.procedure_concept_id).toBe(4171773)
  })
})
