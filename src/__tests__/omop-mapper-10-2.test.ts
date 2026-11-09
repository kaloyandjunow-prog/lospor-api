import { describe, expect, it } from "vitest"
import { mapCasesToOmop } from "@/lib/omop-mapper"
import { OMOP_COLUMNS } from "@/lib/omop-columns"
import { completeCaseFixture as completeCase } from "./fixtures/complete-case"

type Case = { events: Record<string, unknown>[]; intraop: Record<string, unknown>; complications: Record<string, unknown>[] }

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

  it("flags a gas change made from a treatment card, and leaves one set by hand unflagged", () => {
    const b = bundleWith(c => {
      c.events.push(
        event("gas_change", 20, { fio2Percent: 100 }, { suggestion: "card:Hypoxia / desaturation:oxygen" }),
        event("gas_change", 40, { fio2Percent: 60 }),
      )
    })
    const fio2 = b.measurement.filter(row => row.measurement_source_value === "LOINC:3150-0" && [100, 60].includes(row.value_as_number as number))
    expect(fio2.map(row => [row.value_as_number, row.suggestion_source_value ?? null])).toEqual([[100, "card:Hypoxia / desaturation:oxygen"], [60, null]])
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

  it("exports a placement procedure for every airway entry, each at its own time, and not the reintubation twice", () => {
    const b = bundleWith(c => {
      c.intraop.airwayDevices = ["LMA", "ORAL_ETT"]
      c.intraop.airwayDeviceEntries = [
        { id: "a", device: "LMA", details: {}, insertedAt: "2026-06-01T08:10:00.000Z", status: "failed", endedAt: "2026-06-01T08:20:00.000Z", replacedBy: "b", reason: "failed" },
        { id: "b", device: "ORAL_ETT", details: {}, insertedAt: "2026-06-01T08:20:00.000Z", status: "failed", endedAt: "2026-06-01T09:00:00.000Z", replacedBy: "c", reason: "failed" },
        { id: "c", device: "ORAL_ETT", details: {}, insertedAt: "2026-06-01T09:00:00.000Z", status: "in_use", sourceEventId: "re1" },
      ]
      c.events.push(event("clinical_event", 60, { label: "Reintubation" }, { id: "re1" }))
    })
    const placements = b.procedure_occurrence.filter(row => row.procedure_source_value?.startsWith("AIRWAY_MANAGEMENT:"))
    expect(placements.map(row => [row.procedure_source_value, row.procedure_datetime?.slice(11, 16)])).toEqual([
      ["AIRWAY_MANAGEMENT:SUPRAGLOTTIC_AIRWAY_PLACEMENT:failed", "08:10"],
      ["AIRWAY_MANAGEMENT:TRACHEAL_INTUBATION_ORAL:failed", "08:20"],
      ["AIRWAY_MANAGEMENT:TRACHEAL_INTUBATION_ORAL", "09:00"],
    ])
    // The entry is the placement; its Reintubation event is not a second one.
    expect(b.procedure_occurrence.some(row => row.procedure_source_value === "INTRAOP_EVENT:Reintubation")).toBe(false)
  })

  it("keeps a Reintubation event that no airway entry accounts for", () => {
    const b = bundleWith(c => { c.events.push(event("clinical_event", 60, { label: "Reintubation" }, { id: "re9" })) })
    expect(b.procedure_occurrence.some(row => row.procedure_source_value === "INTRAOP_EVENT:Reintubation")).toBe(true)
  })

  it("dates a line at the time it went in", () => {
    const b = bundleWith(c => {
      const rows = c.intraop.vascularAccessRows as Record<string, unknown>[]
      rows[0] = { ...rows[0], preexisting: false, insertedAt: at(25) }
    })
    const line = b.procedure_occurrence.find(row => row.procedure_source_value?.startsWith("VASCULAR_ACCESS:"))
    expect(line?.procedure_datetime?.slice(11, 16)).toBe("08:25")
  })

  it("exports every tourniquet, each with its site and side", () => {
    const b = bundleWith(c => {
      c.events.push(
        event("clinical_event", 10, { label: "Tourniquet on" }, { site: "lThigh" }),
        event("clinical_event", 11, { label: "Tourniquet on" }, { site: "rForearm" }),
        event("clinical_event", 70, { label: "Tourniquet off" }, { site: "lThigh" }),
        event("clinical_event", 80, { label: "Tourniquet off" }, { site: "rForearm" }),
        event("clinical_event", 90, { label: "Tourniquet on" }),
      )
    })
    const rows = b.procedure_occurrence.filter(row => row.procedure_source_value?.startsWith("INTRAOP_EVENT:Tourniquet"))
    expect(rows.map(row => [row.procedure_source_value, row.procedure_concept_id, row.modifier_source_value, row.modifier_concept_id])).toEqual([
      ["INTRAOP_EVENT:Tourniquet on", 4049036, "SITE:lThigh", 4300877],
      ["INTRAOP_EVENT:Tourniquet on", 4049036, "SITE:rForearm", 4080761],
      ["INTRAOP_EVENT:Tourniquet off", 4084008, "SITE:lThigh", 4300877],
      ["INTRAOP_EVENT:Tourniquet off", 4084008, "SITE:rForearm", 4080761],
      ["INTRAOP_EVENT:Tourniquet on", 4049036, null, 0],
    ])
  })

  it("gives every drug the moment it was given, and an administration the moment it stopped", () => {
    const b = bundleWith(() => {})
    const drug = (needle: string) => b.drug_exposure.find(row => row.drug_source_value?.includes(needle))!
    expect(drug("Fentanyl").drug_exposure_start_datetime?.slice(0, 16)).toBe("2026-06-01T08:20")
    expect(drug("Fentanyl").drug_exposure_end_datetime).toBeNull()
    expect(drug("Propofol").drug_exposure_start_datetime?.slice(0, 16)).toBe("2026-06-01T08:25")
    expect(drug("Propofol").drug_exposure_end_datetime?.slice(0, 16)).toBe("2026-06-01T09:10")
    expect(drug("Sevoflurane").drug_exposure_end_datetime?.slice(0, 16)).toBe("2026-06-01T09:05")
    // The day columns are unchanged.
    expect(drug("Fentanyl").drug_exposure_start_date).toBe("2026-06-01")
  })

  it("exports only the day of an arrest dose whose time was reconstructed", () => {
    const b = bundleWith(c => {
      c.events.push(event("drug", 45, { label: "Epinephrine / Adrenaline", unit: "mcg", drugRoute: "IV", metadataJson: { name: "Epinephrine / Adrenaline", dose: "1000", timeApproximate: true } }))
    })
    const dose = b.drug_exposure.find(row => row.drug_source_value?.includes("Epinephrine"))!
    expect(dose.drug_exposure_start_date).toBe("2026-06-01")
    expect(dose.drug_exposure_start_datetime).toBeNull()
  })

  it("leaves the moment empty for a drug known by its day only", () => {
    const b = bundleWith(() => {})
    const premed = b.drug_exposure.find(row => row.drug_source_value?.startsWith("PREMED:"))!
    expect(premed.drug_exposure_start_datetime).toBeNull()
    expect(premed.drug_exposure_end_datetime).toBeNull()
  })

  it("codes the route: the standard concept beside the route as written", () => {
    const b = bundleWith(c => {
      c.events.push(
        event("drug", 30, { label: "Bupivacaine", unit: "mg", drugRoute: "INTRATHECAL", standardConceptId: 1, metadataJson: { name: "Bupivacaine", dose: "10" } }),
        event("drug", 31, { label: "Mystery", unit: "mg", drugRoute: "via the moon", metadataJson: { name: "Mystery", dose: "1" } }),
      )
    })
    const row = (needle: string) => b.drug_exposure.find(item => item.drug_source_value?.includes(needle))!
    expect([row("Fentanyl").route_concept_id, row("Fentanyl").route_source_value]).toEqual([4171047, "IV"])
    expect([row("Bupivacaine").route_concept_id, row("Bupivacaine").route_source_value]).toEqual([4217202, "INTRATHECAL"])
    expect([row("Sevoflurane").route_concept_id, row("Sevoflurane").route_source_value]).toEqual([40486069, "INHALATIONAL"])
    expect([row("PREMED:").route_concept_id, row("PREMED:").route_source_value]).toEqual([4132161, "PO"])
    // A route nobody knows is concept 0 and still readable.
    expect([row("Mystery").route_concept_id, row("Mystery").route_source_value]).toEqual([0, "via the moon"])
  })

  it("has a standard concept for every route LOSPOR offers", async () => {
    const { ADMINISTRATION_ROUTE_CODES } = await import("@lospor/core/clinical-rule-vocabulary")
    const { ROUTE_CONCEPTS, routeConceptFor } = await import("@/lib/omop-mapper/concepts")
    for (const code of ADMINISTRATION_ROUTE_CODES) expect(ROUTE_CONCEPTS[code], code).toBeGreaterThan(0)
    expect(new Set(Object.values(ROUTE_CONCEPTS)).size).toBe(Object.keys(ROUTE_CONCEPTS).length)
    expect([routeConceptFor("Oral"), routeConceptFor(" iv "), routeConceptFor(null), routeConceptFor("")]).toEqual([4132161, 4171047, 0, 0])
  })
})
