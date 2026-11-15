import { describe, expect, it } from "vitest"
import { mapCasesToOmop } from "@/lib/omop-mapper"
import { OMOP_COLUMNS } from "@/lib/omop-columns"
import { LOSPOR_CONCEPTS, losporConceptId, losporVocabularyConceptRows } from "@/lib/omop-mapper/lospor-vocabulary"
import { completeCaseFixture as completeCase } from "./fixtures/complete-case"

/**
 * Exchange contract 2.9.0: the times OMOP has columns for, one row per fact,
 * standard concepts where the vocabulary has them and LOSPOR's own where it does
 * not. Found by the 200-case end-to-end export of 2026-11-15.
 */

type Case = {
  events: Record<string, unknown>[]
  intraop: Record<string, unknown>
  preop: Record<string, unknown>
  selections: Record<string, unknown>[]
}

const at = (minutes: number) => new Date(Date.parse("2026-06-01T08:00:00Z") + minutes * 60_000)
const event = (type: string, minutes: number, extra: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) =>
  ({ type, timestamp: at(minutes), label: null, value: null, unit: null, metadataJson: { type, ...meta }, ...extra })

function bundleWith(change: (c: Case) => void = () => {}) {
  const c = completeCase() as unknown as Case
  change(c)
  return mapCasesToOmop([c as never])
}

describe("exchange contract 2.9.0 columns", () => {
  it("declares the observation, device and procedure-end times", () => {
    expect(OMOP_COLUMNS.observation).toContain("observation_datetime")
    expect(OMOP_COLUMNS.device_exposure).toEqual(expect.arrayContaining(["device_exposure_start_datetime", "device_exposure_end_datetime"]))
    expect(OMOP_COLUMNS.procedure_occurrence).toEqual(expect.arrayContaining(["procedure_end_date", "procedure_end_datetime"]))
  })
})

describe("times that used to collapse into the day", () => {
  it("keeps the moment of a gas setting", () => {
    const fgf = bundleWith().observation.find(row => row.observation_source_value === "LOSPOR:FGF_L_PER_MIN")
    expect(fgf).toMatchObject({ observation_date: "2026-06-01", observation_datetime: "2026-06-01T08:30:00.000Z", observation_concept_id: 4108006 })
  })

  it("keeps when an airway device went in and came out", () => {
    const b = bundleWith(c => {
      c.intraop.airwayDevices = ["LMA", "ORAL_ETT"]
      c.intraop.airwayDevice = null
      c.intraop.airwayDeviceEntries = [
        { id: "a", device: "LMA", details: {}, insertedAt: "2026-06-01T08:04:00.000Z", status: "failed", endedAt: "2026-06-01T08:12:00.000Z", replacedBy: "b", reason: "failed" },
        { id: "b", device: "ORAL_ETT", details: {}, insertedAt: "2026-06-01T08:12:00.000Z", status: "in_use", reason: "failed" },
      ]
    })
    const lma = b.device_exposure.find(row => row.device_source_value?.startsWith("AIRWAY_DEVICE:LMA"))
    expect(lma).toMatchObject({ device_exposure_start_datetime: "2026-06-01T08:04:00.000Z", device_exposure_end_datetime: "2026-06-01T08:12:00.000Z" })
    // A device still in place has no removal time to state; its day is the case end, as before.
    const tube = b.device_exposure.find(row => row.device_source_value === "AIRWAY_DEVICE:ORAL_ETT")
    expect(tube).toMatchObject({ device_exposure_start_datetime: "2026-06-01T08:12:00.000Z", device_exposure_end_datetime: null })
  })

  it("gives monitoring the whole anaesthesia, start to end", () => {
    const b = bundleWith(c => { c.intraop.startedAt = at(0); c.intraop.endedAt = at(60) })
    const ecg = b.procedure_occurrence.find(row => row.procedure_source_value === "LOSPOR:INTRAOP_MONITORING")
    expect(ecg).toMatchObject({
      procedure_concept_id: 4187078,
      procedure_datetime: "2026-06-01T08:00:00.000Z",
      procedure_end_date: "2026-06-01",
      procedure_end_datetime: "2026-06-01T09:00:00.000Z",
    })
  })

  it("times general anaesthesia at induction, else at the anaesthesia start", () => {
    const techniqueRow = (b: ReturnType<typeof mapCasesToOmop>) =>
      b.procedure_occurrence.find(row => row.procedure_source_value === "ANAESTHESIA_TECHNIQUE:GENERAL_BALANCED")
    const induced = bundleWith(c => {
      c.intraop.techniques = ["GENERAL_BALANCED"]
      c.intraop.startedAt = at(0)
      c.events.push(event("clinical_event", 6, { label: "Induction" }))
    })
    expect(techniqueRow(induced)?.procedure_datetime).toBe("2026-06-01T08:06:00.000Z")
    const unmarked = bundleWith(c => { c.intraop.techniques = ["GENERAL_BALANCED"]; c.intraop.startedAt = at(0) })
    expect(techniqueRow(unmarked)?.procedure_datetime).toBe("2026-06-01T08:00:00.000Z")
  })

  it("exports positions charted on the timeline at the moment each began, instead of the untimed list", () => {
    const b = bundleWith(c => {
      c.selections.push(
        { section: "intraop", category: "position", value: "SUPINE", ordinal: 0, sourceVocabulary: "LOSPOR_OPTION", sourceCode: "POSITION:SUPINE", standardConceptId: 4012334, mappingStatus: "MAPPED" },
        { section: "intraop", category: "position", value: "PRONE", ordinal: 1, sourceVocabulary: "LOSPOR_OPTION", sourceCode: "POSITION:PRONE", standardConceptId: 4011810, mappingStatus: "MAPPED" },
      )
      c.events.push(event("position_change", 0, { label: "SUPINE" }), event("position_change", 25, { label: "PRONE" }))
    })
    const positions = b.observation.filter(row => row.observation_source_value === "LOSPOR:INTRAOP_POSITION")
    expect(positions.map(row => [row.value_as_string, row.observation_concept_id, row.observation_datetime])).toEqual([
      ["SUPINE", 4012334, "2026-06-01T08:00:00.000Z"],
      ["PRONE", 4011810, "2026-06-01T08:25:00.000Z"],
    ])
  })

  it("keeps the untimed positions of a case charted without the timeline", () => {
    const b = bundleWith(c => {
      c.selections.push({ section: "intraop", category: "position", value: "SUPINE", ordinal: 0, sourceVocabulary: "LOSPOR_OPTION", sourceCode: "POSITION:SUPINE", standardConceptId: 4012334, mappingStatus: "MAPPED" })
    })
    const positions = b.observation.filter(row => row.observation_source_value === "LOSPOR:INTRAOP_POSITION")
    expect(positions).toHaveLength(1)
    expect(positions[0].observation_datetime ?? null).toBeNull()
  })
})

describe("one row per fact", () => {
  it("does not repeat the technique, airway device, airway tool or ventilation mode as concept-0 observations", () => {
    const b = bundleWith(c => {
      c.selections.push(
        { section: "intraop", category: "technique", value: "GENERAL_BALANCED", ordinal: 0, sourceVocabulary: "LOSPOR_OPTION", sourceCode: "TECHNIQUE:GENERAL_BALANCED", standardConceptId: null, mappingStatus: "SOURCE_ONLY" },
        { section: "intraop", category: "airwayDevice", value: "ORAL_ETT", ordinal: 0, sourceVocabulary: "LOSPOR_OPTION", sourceCode: "AIRWAY_MANAGEMENT:ORAL_ETT", standardConceptId: null, mappingStatus: "SOURCE_ONLY" },
        { section: "intraop", category: "airwayTool", value: "DIRECT_LARY", ordinal: 0, sourceVocabulary: "LOSPOR_OPTION", sourceCode: "AIRWAY_MANAGEMENT:DIRECT_LARY", standardConceptId: null, mappingStatus: "SOURCE_ONLY" },
        { section: "intraop", category: "ventilationMode", value: "VCV", ordinal: 0, sourceVocabulary: "LOSPOR_OPTION", sourceCode: "VENTILATION:VCV", standardConceptId: null, mappingStatus: "SOURCE_ONLY" },
      )
    })
    const repeated = b.observation.filter(row => /^LOSPOR:INTRAOP_(TECHNIQUE|AIRWAYDEVICE|AIRWAYTOOL|VENTILATIONMODE)$/.test(row.observation_source_value ?? ""))
    expect(repeated).toEqual([])
    // ...while each is still there, once, with its concept.
    expect(b.device_exposure.some(row => row.device_source_value === "AIRWAY_DEVICE:ORAL_ETT")).toBe(true)
    expect(b.measurement.some(row => row.measurement_source_value === "LOSPOR:VENTILATION_MODE")).toBe(true)
  })

  it("leaves software provenance out of the patient rows", () => {
    expect(bundleWith().observation.some(row => row.observation_source_value === "LOSPOR:CLINICAL_RULES_VERSION")).toBe(false)
  })
})

describe("standard concepts the export was not using", () => {
  it("codes blood loss as Estimated blood loss, in mL, at the end of the case", () => {
    const b = bundleWith(c => { c.intraop.bloodLossMl = 350; c.intraop.endedAt = at(60) })
    expect(b.observation.find(row => row.observation_source_value === "LOSPOR:BLOOD_LOSS_ML")).toMatchObject({
      observation_concept_id: 4254486, value_as_number: 350, unit_concept_id: 8587, unit_source_value: "mL",
      observation_datetime: "2026-06-01T09:00:00.000Z",
    })
  })

  it("codes a drug allergy as Allergy to drug, the drug as its value", () => {
    const b = bundleWith(c => {
      ;(c.preop.medications as Record<string, unknown>[]).push({ kind: "ALLERGY", nameRaw: "Amoxicillin", inn: "amoxicillin", atcCode: "J01CA04", dose: null, route: null, sourceVocabulary: "ATC", sourceCode: "J01CA04", standardConceptId: 1713332, mappingStatus: "MAPPED", ordinal: 1 })
    })
    expect(b.observation.find(row => row.observation_source_value === "LOSPOR:DRUG_ALLERGY"))
      .toMatchObject({ observation_concept_id: 439224, value_as_concept_id: 1713332 })
  })

  it("codes a child's charted age as Age, in its own unit and in days", () => {
    const b = bundleWith(c => { c.preop.ageValue = 7; c.preop.ageUnit = "MONTHS"; c.preop.ageApproxDays = 213 })
    const row = (source: string) => b.observation.find(r => r.observation_source_value === source)
    expect(row("LOSPOR:AGE_AT_PROCEDURE_EXACT")).toMatchObject({ observation_concept_id: 3022304, value_as_number: 7, unit_concept_id: 9580 })
    expect(row("LOSPOR:AGE_AT_PROCEDURE_APPROX_DAYS")).toMatchObject({ observation_concept_id: 3022304, value_as_number: 213, unit_concept_id: 8512 })
  })
})

describe("LOSPOR's own vocabulary", () => {
  it("keeps every concept id unique, in the site range, and once given never changed", () => {
    const ids = LOSPOR_CONCEPTS.map(row => row.conceptId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every(id => id >= 2_000_000_000)).toBe(true)
    expect(new Set(LOSPOR_CONCEPTS.map(row => row.code)).size).toBe(LOSPOR_CONCEPTS.length)
    // Pinned: research databases hold these ids. Add new rows at the end; retire, never renumber.
    expect(Object.fromEntries(LOSPOR_CONCEPTS.map(row => [row.code, row.conceptId]))).toMatchSnapshot()
  })

  it("is published as OMOP CONCEPT rows", () => {
    const rows = losporVocabularyConceptRows()
    expect(rows).toHaveLength(LOSPOR_CONCEPTS.length)
    expect(rows[0]).toMatchObject({ vocabulary_id: "LOSPOR", standard_concept: "S", valid_end_date: "2099-12-31", invalid_reason: null })
  })

  it("names the variable sources by their one idea", () => {
    expect(losporConceptId("LOSPOR:PEDIATRIC_NPO_CLEAR_FLUIDS_HOURS")).toBe(losporConceptId("LOSPOR:PEDIATRIC_NPO_HOURS"))
    expect(losporConceptId("VASCULAR_ACCESS:VEN_PERIPHERAL 18G:failed")).toBe(losporConceptId("LOSPOR:VASCULAR_ACCESS_FAILED"))
    expect(losporConceptId("LOSPOR:INTRAOP_MONITORING", "bis")).toBeGreaterThanOrEqual(2_000_000_000)
    expect(losporConceptId("LOSPOR:INTRAOP_MONITORING", "ecg")).toBe(0)
    expect(losporConceptId("LOSPOR:NOT_A_CODE")).toBe(0)
  })

  it("leaves no LOSPOR row of the reference case at concept 0", () => {
    const b = bundleWith()
    const uncoded = [
      ...b.observation.filter(row => !row.observation_concept_id && row.observation_source_value?.startsWith("LOSPOR:")).map(row => row.observation_source_value),
      ...b.measurement.filter(row => !row.measurement_concept_id && row.measurement_source_value?.startsWith("LOSPOR:")).map(row => row.measurement_source_value),
    ]
    expect(uncoded).toEqual([])
  })
})
