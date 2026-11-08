import { describe, expect, it } from "vitest"
import { CLINICAL_EVENT_CATS, DRUG_CATALOG, FLUID_CATALOG } from "@lospor/core/catalog"
import { OMOP_COLUMNS } from "@/lib/omop-columns"
import { mapCasesToOmop } from "@/lib/omop-mapper"
import { omopCsvValueLine } from "@/lib/research/omop-csv"
import { completeCaseFixture } from "./fixtures/complete-case"

/**
 * The OMOP export under random intraoperative cases. Whatever was charted, however oddly, the export must still be a
 * valid set of tables: no row without its person or visit, no two rows with one id, no date that is not a date, no
 * number that is not a number, and no field the CSV writer would silently leave out.
 */

function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DRUGS = DRUG_CATALOG.map(entry => entry.name)
const FLUIDS = FLUID_CATALOG.map(entry => entry.name)
const EVENTS = CLINICAL_EVENT_CATS.flatMap(category => category.events.map(event => event.label))
const ROUTES = ["IV", "IM", "PO", "INTRATHECAL", "EPIDURAL", "PERINEURAL", "INHALATION", "via the moon", "", null]
const DOSES = ["10", "0.5", "", "abc", "5 mg", "1e3", "-4", "0", "1,5", null]

type Row = Record<string, unknown>

function randomCase(seed: number): Row {
  const random = rng(seed)
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
  const base = completeCaseFixture() as unknown as Row & { events: Row[] }
  const start = Date.parse("2026-06-01T08:00:00Z")
  const events: Row[] = [...base.events]
  const count = Math.floor(random() * 40)
  let n = 0
  for (let index = 0; index < count; index++) {
    const timestamp = new Date(start + Math.floor(random() * 150) * 60_000)
    const common = { timestamp, label: null, value: null, unit: null, metadataJson: {} as Row }
    const kind = Math.floor(random() * 12)
    const id = `x${++n}`
    if (kind <= 2) {
      const vital: Row = { ...common, type: "vital" }
      for (const key of ["systolic", "diastolic", "heartRate", "spO2", "etco2", "temp", "bis", "tofRatio", "cvp", "ibpSystolic", "ibpDiastolic", "ibpMap", "nibpMap"]) {
        if (random() < 0.4) vital[key] = random() < 0.05 ? null : Math.round(random() * 250 * 10) / 10
      }
      events.push(vital)
    } else if (kind <= 4) {
      const name = pick(DRUGS)
      events.push({ ...common, type: "drug", label: name, unit: pick(["mg", "mcg", "mL", null]), drugRoute: pick(ROUTES), standardConceptId: random() < 0.5 ? 1000 + index : null, atcCode: random() < 0.5 ? "N01AH01" : null, metadataJson: { name, dose: pick(DOSES), ...(random() < 0.3 ? { suggestion: "card:Hypotension:ephedrine" } : {}), ...(random() < 0.2 ? { timeApproximate: true } : {}) } })
    } else if (kind === 5) {
      const infId = id
      events.push({ ...common, type: "infusion_start", label: pick(DRUGS), infId, rate: pick(DOSES), unit: "mg/h", metadataJson: { name: pick(DRUGS) } })
      if (random() < 0.6) events.push({ ...common, timestamp: new Date(start + Math.floor(random() * 170) * 60_000), type: "infusion_stop", infId })
    } else if (kind === 6) {
      const fluidId = id
      events.push({ ...common, type: "fluid_start", label: pick(FLUIDS), fluidId, volume: pick(DOSES), fluidCategory: pick(["CRYSTALLOID", "BLOOD", null]), metadataJson: { name: pick(FLUIDS) } })
      if (random() < 0.5) events.push({ ...common, timestamp: new Date(start + Math.floor(random() * 170) * 60_000), type: "fluid_end", fluidId })
    } else if (kind === 7) {
      events.push({ ...common, type: random() < 0.5 ? "gas_start" : "gas_change", fio2Percent: Math.round(random() * 100), fgfLitersPerMin: Math.round(random() * 10), carrierGas: pick(["air", "o2", "n2o", null]) })
    } else if (kind === 8) {
      events.push({ ...common, type: "clinical_event", label: pick(EVENTS), metadataJson: random() < 0.3 ? { site: pick(["lThigh", "rForearm", "xx"]) } : {} })
    } else if (kind === 9) {
      events.push({ ...common, type: "defibrillation", label: random() < 0.5 ? "Cardioversion" : "Defibrillation", value: pick(["200", "0", "abc", null]) })
    } else if (kind === 10) {
      events.push({ ...common, type: pick(["jet_start", "jet_change"]), metadataJson: { jetPressureBar: pick([2, 0, "x", null]), jetRate: pick([150, null]) } })
    } else {
      events.push({ ...common, type: "agent_start", label: pick(["Sevoflurane", "Desflurane"]), agentPercent: random() * 8, metadataJson: { name: "Sevoflurane" } })
    }
  }
  return { ...base, events }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const ID_KEYS: Record<string, string> = {
  person: "person_id", visit_occurrence: "visit_occurrence_id", condition_occurrence: "condition_occurrence_id",
  drug_exposure: "drug_exposure_id", measurement: "measurement_id", procedure_occurrence: "procedure_occurrence_id",
  device_exposure: "device_exposure_id", observation: "observation_id", observation_period: "observation_period_id", care_site: "care_site_id",
}

describe("the OMOP export of random cases", () => {
  it("is a valid set of tables whatever was charted", () => {
    const problems: string[] = []
    const rowsSeen = { drug: 0, measurement: 0, procedure: 0, condition: 0 }
    const flag = (seed: number, text: string) => { if (problems.length < 30) problems.push(`seed ${seed}: ${text}`) }
    for (let seed = 1; seed <= 150; seed++) {
      let bundle: ReturnType<typeof mapCasesToOmop>
      try { bundle = mapCasesToOmop([randomCase(seed) as never]) } catch (error) { flag(seed, `throws ${String(error)}`); continue }
      rowsSeen.drug += bundle.drug_exposure.length
      rowsSeen.measurement += bundle.measurement.length
      rowsSeen.procedure += bundle.procedure_occurrence.length
      rowsSeen.condition += bundle.condition_occurrence.length
      const persons = new Set(bundle.person.map(row => row.person_id))
      const visits = new Set(bundle.visit_occurrence.map(row => row.visit_occurrence_id))
      for (const table of Object.keys(OMOP_COLUMNS) as (keyof typeof OMOP_COLUMNS)[]) {
        const rows = bundle[table] as unknown as Row[]
        const columns = new Set(OMOP_COLUMNS[table])
        const idKey = ID_KEYS[table]
        const seen = new Set<unknown>()
        for (const row of rows) {
          for (const [key, value] of Object.entries(row)) {
            if (!columns.has(key)) flag(seed, `${table}.${key} is emitted but not a declared column`)
            if (value === null || value === undefined) continue
            if (key.endsWith("_date") && !(typeof value === "string" && DATE.test(value) && Number.isFinite(Date.parse(value)))) flag(seed, `${table}.${key} = ${String(value)}`)
            if (key.endsWith("_datetime") && !(typeof value === "string" && Number.isFinite(Date.parse(value)))) flag(seed, `${table}.${key} = ${String(value)}`)
            if (["value_as_number", "dose_value", "range_low", "range_high", "quantity"].includes(key) && !(typeof value === "number" && Number.isFinite(value))) flag(seed, `${table}.${key} = ${String(value)}`)
            if (key.endsWith("_concept_id") && !(typeof value === "number" && Number.isInteger(value) && value >= 0)) flag(seed, `${table}.${key} = ${String(value)}`)
          }
          if (idKey) {
            const id = row[idKey]
            if (seen.has(id)) flag(seed, `${table} repeats ${idKey} ${String(id)}`)
            seen.add(id)
          }
          if ("person_id" in row && table !== "person" && !persons.has(row.person_id as number)) flag(seed, `${table} row has an unknown person ${String(row.person_id)}`)
          if ("visit_occurrence_id" in row && row.visit_occurrence_id != null && table !== "visit_occurrence" && !visits.has(row.visit_occurrence_id as number)) flag(seed, `${table} row has an unknown visit`)
          const start = (row.drug_exposure_start_date ?? row.device_exposure_start_date ?? row.condition_start_date) as string | null | undefined
          const end = (row.drug_exposure_end_date ?? row.device_exposure_end_date ?? row.condition_end_date) as string | null | undefined
          if (start && end && end < start) flag(seed, `${table} ends (${end}) before it starts (${start})`)
          try { omopCsvValueLine(table as never, row) } catch (error) { flag(seed, `${table} row cannot be written as CSV: ${String(error)}`) }
        }
      }
    }
    expect(problems).toEqual([])
    // The cases must be big enough to prove something: many drug, measurement, procedure and condition rows.
    expect(rowsSeen.drug).toBeGreaterThan(1000)
    expect(rowsSeen.measurement).toBeGreaterThan(2000)
    expect(rowsSeen.procedure).toBeGreaterThan(1000)
    expect(rowsSeen.condition).toBeGreaterThan(200)
  })
})
