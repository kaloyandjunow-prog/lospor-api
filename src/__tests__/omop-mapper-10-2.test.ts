import { describe, expect, it } from "vitest"
import { mapCasesToOmop } from "@/lib/omop-mapper"
import { OMOP_COLUMNS } from "@/lib/omop-columns"
import { completeCaseFixture as completeCase } from "./fixtures/complete-case"

type Case = ReturnType<typeof completeCase> & { events: Record<string, unknown>[]; intraop: Record<string, unknown>; complications: Record<string, unknown>[] }

const at = (minutes: number) => new Date(Date.parse("2026-06-01T08:00:00Z") + minutes * 60_000)
const event = (type: string, minutes: number, extra: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) =>
  ({ type, timestamp: at(minutes), label: null, value: null, unit: null, metadataJson: { type, ...meta }, ...extra })

function bundleWith(change: (c: Case) => void) {
  const c = completeCase() as unknown as Case
  change(c)
  return mapCasesToOmop([c as never])
}

describe("the 10.2.0 export", () => {
  it("adds DEATH and the suggestion column to the declared CSV columns", () => {
    expect(OMOP_COLUMNS.death).toEqual(["person_id", "death_date", "death_datetime", "death_type_concept_id", "cause_concept_id", "cause_source_value", "cause_source_concept_id"])
    for (const table of ["condition_occurrence", "drug_exposure", "measurement", "procedure_occurrence", "device_exposure", "observation"] as const) {
      expect(OMOP_COLUMNS[table], table).toContain("suggestion_source_value")
    }
  })

  it("exports each airway device as its own row, a failed tube and its replacement both", () => {
    const b = bundleWith(c => {
      c.intraop.airwayDevices = ["ORAL_ETT"]
      c.intraop.airwayDeviceEntries = [
        { id: "a", device: "ORAL_ETT", details: { oralTubeSize: 7.5, oralCuffed: true }, insertedAt: "2026-06-01T08:10:00.000Z", status: "failed", endedAt: "2026-06-01T09:00:00.000Z", replacedBy: "b", reason: "reintubation" },
        { id: "b", device: "ORAL_ETT", details: { oralTubeSize: 7.5, oralCuffed: true }, insertedAt: "2026-06-01T09:00:00.000Z", status: "in_use", reason: "reintubation" },
      ]
    })
    const tubes = b.device_exposure.filter(row => row.device_source_value?.startsWith("AIRWAY_DEVICE:ORAL_ETT"))
    expect(tubes.map(row => row.device_source_value)).toEqual(["AIRWAY_DEVICE:ORAL_ETT:failed", "AIRWAY_DEVICE:ORAL_ETT"])
    expect(tubes.every(row => row.device_concept_id === 4097216)).toBe(true)
  })

  it("keeps an older case's one row per kind", () => {
    const b = bundleWith(c => { c.intraop.airwayDevice = null; c.intraop.airwayDevices = ["LMA", "OPA"] })
    expect(b.device_exposure.filter(row => row.device_source_value?.startsWith("AIRWAY_DEVICE:")).map(row => row.device_source_value))
      .toEqual(["AIRWAY_DEVICE:LMA", "AIRWAY_DEVICE:OPA"])
  })

  it("records a failed line as its own observation beside the line", () => {
    const b = bundleWith(c => {
      const rows = c.intraop.vascularAccessRows as Record<string, unknown>[]
      rows[0] = { ...rows[0], failed: true, failedAt: at(50) }
    })
    expect(b.observation.some(row => row.observation_source_value?.endsWith(":failed"))).toBe(true)
  })

  it("exports CPR, front-of-neck access, ROSC, ROSB and a death in theatre with the DEATH record", () => {
    const b = bundleWith(c => {
      c.events.push(
        event("clinical_event", 30, { label: "CPR started" }, { suggestion: "card:Cardiac arrest:cpr" }),
        event("clinical_event", 31, { label: "Cricothyrotomy" }),
        event("clinical_event", 40, { label: "ROSC" }),
        event("clinical_event", 41, { label: "ROSB" }),
        event("clinical_event", 60, { label: "Death (exitus letalis)" }),
      )
    })
    const cpr = b.procedure_occurrence.find(row => row.procedure_source_value === "INTRAOP_EVENT:CPR started")
    expect(cpr).toMatchObject({ procedure_concept_id: 4232320, suggestion_source_value: "card:Cardiac arrest:cpr" })
    expect(b.procedure_occurrence.find(row => row.procedure_source_value === "INTRAOP_EVENT:Cricothyrotomy")?.procedure_concept_id).toBe(37206251)
    expect(b.condition_occurrence.find(row => row.condition_source_value === "INTRAOP_EVENT:ROSC")?.condition_concept_id).toBe(44791216)
    expect(b.observation.find(row => row.observation_source_value === "INTRAOP_EVENT:ROSB")?.observation_concept_id).toBe(0)
    expect(b.observation.find(row => row.observation_source_value === "INTRAOP_EVENT:Death (exitus letalis)")?.observation_concept_id).toBe(4306655)
    expect(b.death).toEqual([expect.objectContaining({ death_date: "2026-06-01", death_type_concept_id: 32817, cause_concept_id: 0 })])
    expect(b.metadata.table_counts.death).toBe(1)
  })

  it("exports jet ventilation as a procedure with its pressure in bar and rate per minute", () => {
    const b = bundleWith(c => {
      c.events.push(
        event("jet_start", 20, {}, { jetPressureBar: 2, jetRate: 150, fio2: 100 }),
        event("jet_change", 30, {}, { jetRate: 300 }),
        event("jet_stop", 40),
      )
    })
    expect(b.procedure_occurrence.filter(row => row.procedure_source_value === "INTRAOP_JET").map(row => row.procedure_concept_id)).toEqual([4168475])
    const pressure = b.measurement.filter(row => row.measurement_source_value === "INTRAOP_JET:driving_pressure")
    expect(pressure).toEqual([expect.objectContaining({ value_as_number: 2, unit_concept_id: 9464, unit_source_value: "bar" })])
    const rates = b.measurement.filter(row => row.measurement_source_value === "INTRAOP_JET:rate").map(row => row.value_as_number)
    expect(rates).toEqual([150, 300])
  })

  it("flags a drug given from a suggestion, and leaves the column empty for one charted by hand", () => {
    const b = bundleWith(c => {
      c.events.push(event("drug", 25, { label: "Ephedrine", atcCode: "C01CA26", drugId: null }, { name: "Ephedrine", dose: "10", unit: "mg", suggestion: "card:Hypotension:ephedrine" }))
    })
    const ephedrine = b.drug_exposure.find(row => row.drug_source_value?.includes("Ephedrine"))
    expect(ephedrine?.suggestion_source_value).toBe("card:Hypotension:ephedrine")
    expect(b.drug_exposure.filter(row => !row.drug_source_value?.includes("Ephedrine")).every(row => row.suggestion_source_value === null)).toBe(true)
  })

  it("flags a complication logged from a suggestion", () => {
    const b = bundleWith(c => {
      c.complications.push({ section: "intraop", label: "Hyperkalaemia", note: null, timestamp: at(15), endTimestamp: at(15), source: "relational-sync", suggestion: "lab:hyperkalaemia", ordinal: 1, standardConceptId: 434610, mappingStatus: "MAPPED" })
    })
    const all = [...b.condition_occurrence, ...b.observation] as { suggestion_source_value?: string | null }[]
    expect(all.some(row => row.suggestion_source_value === "lab:hyperkalaemia")).toBe(true)
  })
})
