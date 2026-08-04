import { describe, expect, it, vi } from "vitest"
import {
  CASE_EVENT_SCHEMA_VERSION,
  caseEventDrugAuditColumns,
  projectTimetable,
  reserveIntraopRevision,
  sortLogDeterministic,
} from "./case-events"
import type { LogEvent } from "@/types/timetable"

const START = new Date("2026-01-01T08:00:00.000Z")
const at = (min: number) => new Date(START.getTime() + min * 60_000).toISOString()

describe("projectTimetable", () => {
  it("places a drug at its 5-minute column", () => {
    const t = projectTimetable([{ type: "drug", name: "Propofol", dose: "150", unit: "mg", ts: at(10) }], START)
    expect(t.drugs).toEqual([{ colIdx: 2, name: "Propofol", dose: "150", unit: "mg" }])
  })

  it("records a vital at its column", () => {
    const t = projectTimetable([{ type: "vital", systolic: 120, diastolic: 80, heartRate: 60, ts: at(0) }], START)
    expect(t.vitals[0]).toMatchObject({ systolic: 120, diastolic: 80, heartRate: 60 })
  })

  it("builds an infusion segment with rate changes between start and stop", () => {
    const log: LogEvent[] = [
      { type: "infusion_start", infId: "i1", name: "Noradrenaline", rate: "5", unit: "mcg/min", color: "#f00", ts: at(0) },
      { type: "infusion_rate", infId: "i1", rate: "8", unit: "mcg/min", ts: at(15) },
      { type: "infusion_stop", infId: "i1", ts: at(30) },
    ]
    const t = projectTimetable(log, START)
    expect(t.infusions).toHaveLength(1)
    expect(t.infusions[0]).toMatchObject({ id: "i1", name: "Noradrenaline", rate: 5, unit: "mcg/min", startCol: 0, endCol: 6 })
    expect(t.infusions[0].rateChanges).toEqual([{ col: 3, rate: 8, unit: "mcg/min" }])
  })

  it("leaves an unstopped infusion open-ended (endCol = maxCol + 1)", () => {
    const log: LogEvent[] = [
      { type: "infusion_start", infId: "i1", name: "Propofol", rate: "6", unit: "mg/kg/hr", ts: at(0) },
      { type: "drug", name: "Fentanyl", dose: "100", unit: "mcg", ts: at(20) }, // maxCol = 4
    ]
    const t = projectTimetable(log, START)
    expect(t.infusions[0]).toMatchObject({ startCol: 0, endCol: 5 })
  })

  it("projects fluids, agents and clinical events", () => {
    const log: LogEvent[] = [
      { type: "fluid_start", fluidId: "f1", name: "Ringer", category: "Crystalloids", volume: "1000", ts: at(0) },
      { type: "fluid_end", fluidId: "f1", ts: at(25) },
      { type: "agent_start", name: "Sevoflurane", value: "2", ts: at(0) },
      { type: "agent_stop", ts: at(20) },
      { type: "clinical_event", label: "Incision", ts: at(5) },
    ]
    const t = projectTimetable(log, START)
    expect(t.fluids[0]).toMatchObject({ id: "f1", name: "Ringer", startCol: 0, endCol: 5 })
    expect(t.agents[0]).toMatchObject({ name: "Sevoflurane", startCol: 0, endCol: 4, percent: 2 })
    expect(t.clinicalEvents).toEqual([{ colIdx: 1, label: "Incision", color: "#64748b" }])
  })

  it("sorts events chronologically regardless of input order", () => {
    const log: LogEvent[] = [
      { type: "drug", name: "B", dose: "2", unit: "mg", ts: at(20) },
      { type: "drug", name: "A", dose: "1", unit: "mg", ts: at(5) },
    ]
    const t = projectTimetable(log, START)
    expect(t.drugs.map(d => d.name)).toEqual(["A", "B"])
  })
})

describe("sortLogDeterministic", () => {
  const entry = (logicalId: string, version: number, ts: string, hr: number) =>
    ({ logicalId, version, ev: { type: "vital", heartRate: hr, ts } as LogEvent })

  it("orders equal-ts events by version then logicalId, identically across shuffles", () => {
    const a = entry("web-vital-2", 1, at(10), 70)
    const b = entry("web-vital-2", 3, at(10), 75)
    const c = entry("aaa-random", 1, at(10), 80)

    const orders = [
      [a, b, c], [c, b, a], [b, a, c], [c, a, b],
    ].map(input => sortLogDeterministic(input).map(x => `${x.logicalId}:v${x.version}`))

    for (const order of orders) {
      expect(order).toEqual(orders[0])
    }
    // Higher version sorts LAST so the projection's later-wins rule applies.
    const sorted = sortLogDeterministic([b, c, a])
    expect(sorted.indexOf(a)).toBeLessThan(sorted.indexOf(b))
  })

  it("keeps timestamp as the primary key", () => {
    const early = entry("z", 9, at(0), 60)
    const late = entry("a", 1, at(5), 65)
    expect(sortLogDeterministic([late, early])[0]).toBe(early)
  })
})

describe("reserveIntraopRevision", () => {
  it("claims the expected revision with one atomic conditional update", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const tx = { intraoperativeRecord: { updateMany } }

    await expect(reserveIntraopRevision(tx as never, "case-1", 7)).resolves.toBe(true)
    expect(updateMany).toHaveBeenCalledWith({
      where: { caseId: "case-1", syncRevision: 7 },
      data: { syncRevision: { increment: 1 } },
    })
  })

  it("integrates rate fluids by exact timestamps without counting the bag", () => {
    const exact = (seconds: number) => new Date(START.getTime() + seconds * 1_000).toISOString()
    const t = projectTimetable([
      {
        type: "fluid_start",
        fluidId: "rate-fluid",
        name: "Plasma-Lyte",
        category: "Crystalloids",
        fluidEntryMode: "RATE",
        bagVolumeMl: 1_000,
        rate: "60",
        unit: "mL/h",
        ts: exact(0),
      },
      {
        type: "fluid_rate",
        fluidId: "rate-fluid",
        rate: "120",
        unit: "mL/h",
        ts: exact(450),
      },
      {
        type: "fluid_end",
        fluidId: "rate-fluid",
        ts: exact(1_350),
      },
    ], START)
    expect(t.fluids[0]).toMatchObject({
      fluidEntryMode: "RATE",
      bagVolumeMl: 1_000,
      volume: "38",
      startTs: exact(0),
      endTs: exact(1_350),
      rateChanges: [{ col: 1, ts: exact(450), rate: 120, unit: "mL/h" }],
    })
  })

  it("uses the end event volume for a legacy partial bag", () => {
    const t = projectTimetable([
      {
        type: "fluid_start",
        fluidId: "partial-fluid",
        name: "Ringer",
        category: "Crystalloids",
        volume: "500",
        ts: at(0),
      },
      {
        type: "fluid_end",
        fluidId: "partial-fluid",
        volume: "125",
        ts: at(10),
      },
    ], START)
    expect(t.fluids[0]).toMatchObject({
      bagVolumeMl: 500,
      administeredVolumeMl: 125,
      volume: "125",
    })
  })

  it("reports a lost claim when another writer advanced first", async () => {
    const tx = { intraoperativeRecord: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) } }
    await expect(reserveIntraopRevision(tx as never, "case-1", 7)).resolves.toBe(false)
  })
})

describe("drug route-profile event audit", () => {
  it("copies the selected formulation, calculation and rule provenance into typed columns", () => {
    expect(CASE_EVENT_SCHEMA_VERSION).toBe("3.2.0")
    expect(caseEventDrugAuditColumns({
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
    })).toEqual({
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
    })
  })

  it("leaves legacy events queryable with null audit columns", () => {
    expect(caseEventDrugAuditColumns({})).toEqual({
      concentrationValue: null,
      concentrationUnit: null,
      formulation: null,
      calculationBasis: null,
      calculationWeightKg: null,
      calculationMethod: null,
      clinicalRuleKey: null,
      clinicalRuleVersion: null,
      clinicalRuleSourceIds: undefined,
      clinicalPresetId: null,
      clinicalPresetVersion: null,
      clinicalPresetScope: null,
    })
  })

  it("canonicalizes safe legacy aliases and drops malformed typed audit values", () => {
    expect(caseEventDrugAuditColumns({
      concentrationValue: -1,
      concentrationUnit: "%" as never,
      formulation: "hyperbaric" as never,
      calculationBasis: "TBW_KG" as never,
      calculationWeightKg: -5,
      clinicalPresetVersion: -1,
      clinicalPresetScope: "institution" as never,
    })).toMatchObject({
      concentrationValue: null,
      concentrationUnit: "PERCENT",
      formulation: "HYPERBARIC",
      calculationBasis: "TBW",
      calculationWeightKg: null,
      clinicalPresetVersion: null,
      clinicalPresetScope: "INSTITUTION",
    })
  })
})
