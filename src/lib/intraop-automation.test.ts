import { describe, expect, it, vi } from "vitest"

import { buildRow } from "@/lib/case-events"
import { closeOpenVitalEpisodes, intraopAutomationForClient, readIntraopAutomation, saveIntraopAutomation, vitalStats } from "@/lib/intraop-automation"
import { mapIntraopToOmop } from "@/lib/omop-mapper/domains/intraop"
import { mapComplicationsToOmop } from "@/lib/omop-mapper/domains/complications"
import { OMOP_COLUMNS } from "@/lib/omop-columns"

const ON = { enabled: true, vitalQuestions: { enabled: true } }

function db(config: unknown, rows: { bp?: unknown[]; hr?: unknown[] } = {}, cases: unknown[] = []) {
  const queryRaw = vi.fn()
    .mockResolvedValueOnce(rows.bp ?? [])
    .mockResolvedValueOnce(rows.hr ?? [])
  return {
    intraopAutomationPolicy: {
      findUnique: vi.fn().mockResolvedValue(config === undefined ? null : { config }),
      upsert: vi.fn().mockResolvedValue({}),
    },
    case: { findMany: vi.fn().mockResolvedValue(cases) },
    $queryRaw: queryRaw,
  }
}

describe("settings", () => {
  it("read as off when nothing was ever saved, as on the public demo", async () => {
    const settings = await readIntraopAutomation(db(undefined) as never)
    expect(settings.enabled).toBe(false)
    expect(settings.vitalQuestions.enabled).toBe(false)
  })

  it("save what parses and nothing else", async () => {
    const store = db(undefined)
    const saved = await saveIntraopAutomation(store as never, {
      ...ON,
      vitalQuestions: { enabled: true, minCases: 5, tails: { ADULT: { hr: { low: 7, high: 1 } } } },
      extra: "dropped",
    })
    expect(saved.vitalQuestions.minCases).toBe(100)
    expect(saved.vitalQuestions.tails.ADULT.hr).toEqual({ low: 0.5, high: 1 })
    expect(store.intraopAutomationPolicy.upsert.mock.calls[0][0].create.config).not.toHaveProperty("extra")
  })

  it("send no reading counts while the questions are off", async () => {
    const store = db({ enabled: true, vitalQuestions: { enabled: false } })
    expect(await intraopAutomationForClient(store as never, {})).toMatchObject({ stats: null })
    expect(store.$queryRaw).not.toHaveBeenCalled()
  })
})

describe("reading counts", () => {
  it("count per band and sign, with MAP calculated and each case counted once", async () => {
    const store = db(ON, {
      bp: [
        { caseId: "a", systolic: 120, diastolic: 60, month: null, n: 3 },
        { caseId: "b", systolic: 120, diastolic: null, month: null, n: 1 },
      ],
      hr: [{ caseId: "a", heartRate: 70, month: null, n: 2 }, { caseId: "k", heartRate: 130, month: null, n: 1 }],
    }, [
      { id: "a", preop: { ageYears: 40 } },
      { id: "b", preop: { ageYears: 50 } },
      { id: "k", preop: { ageYears: 4 } },
      { id: "no-age", preop: null },
    ])
    const stats = await vitalStats(store as never, { institutionId: "count-test" }, 1)
    expect(stats.ADULT?.sbp).toEqual({ min: 120, counts: [4], cases: 2 })
    expect(stats.ADULT?.map).toEqual({ min: 80, counts: [3], cases: 1 })
    expect(stats.ADULT?.hr).toEqual({ min: 70, counts: [2], cases: 1 })
    expect(stats.PRESCHOOL?.hr).toEqual({ min: 130, counts: [1], cases: 1 })
    // Only cases with an age reach the readings query.
    expect(store.$queryRaw.mock.calls[0].slice(1)).toContainEqual(["a", "b", "k"])
  })
})

describe("closing episodes at the case end", () => {
  it("closes only open episodes from the vitals questions, at the end", async () => {
    const created: Record<string, unknown>[] = []
    const rows = [
      { logicalId: "open", version: 1, metadataJson: { id: "open", type: "complication", ts: "2026-11-01T09:00:00.000Z", label: "Hypotension", complicationSource: "vitals" } },
      { logicalId: "closed", version: 1, metadataJson: { id: "closed", type: "complication", ts: "2026-11-01T09:00:00.000Z", endTs: "2026-11-01T09:10:00.000Z", label: "Tachycardia", complicationSource: "vitals" } },
      { logicalId: "manual", version: 1, metadataJson: { id: "manual", type: "complication", ts: "2026-11-01T09:00:00.000Z", label: "Laryngospasm", complicationSource: "timeline" } },
      // 10.2.0: an open episode from the SpO2 question closes the same way.
      { logicalId: "spo2", version: 1, metadataJson: { id: "spo2", type: "complication", ts: "2026-11-01T09:20:00.000Z", label: "Hypoxia / desaturation", complicationSource: "readings" } },
    ]
    const tx = {
      caseEvent: {
        count: vi.fn().mockResolvedValue(rows.length),
        findMany: vi.fn().mockResolvedValue(rows.map(row => ({ ...row, id: row.logicalId, status: "active" }))),
        update: vi.fn().mockResolvedValue({}),
        create: vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => {
          created.push(data)
          return Promise.resolve({})
        }),
      },
      intraoperativeRecord: { findUnique: vi.fn().mockResolvedValue({ keyEvents: {} }) },
    }
    const closed = await closeOpenVitalEpisodes(tx as never, "case-1", new Date("2026-11-01T10:00:00.000Z"), "user-1", "system")
    expect(closed).toBe(2)
    expect(created).toHaveLength(2)
    expect(created[0]).toMatchObject({ logicalId: "open", version: 2, metadataJson: expect.objectContaining({ endTs: "2026-11-01T10:00:00.000Z" }) })
    expect(created[1]).toMatchObject({ logicalId: "spo2", version: 2, metadataJson: expect.objectContaining({ endTs: "2026-11-01T10:00:00.000Z" }) })
  })
})

describe("a shock", () => {
  it("keeps its energy and synchronisation in the row the export reads", () => {
    const row = buildRow("case-1", "user-1", { id: "s", type: "defibrillation", ts: "2026-11-01T09:00:00.000Z", energyJ: 150, synchronized: true } as never, 1, "active", "k", "test")
    expect(row).toMatchObject({ label: "Cardioversion", value: "150", unit: "J" })
  })

  it("exports as a procedure with its energy beside it", () => {
    const base: Record<string | symbol, unknown> = {
      personId: 1, visitId: 2, startDate: "2026-11-01", endDate: "2026-11-01",
      procedures: [] as Record<string, unknown>[], measurements: [] as Record<string, unknown>[], observations: [],
      conditions: [], drugs: [], devices: [],
    }
    // Every other helper of the mapper context is a no-op here.
    const ctx = new Proxy(base, { get: (target, key) => (key in target ? target[key] : (target[key] = vi.fn())) }) as {
      procedures: Record<string, unknown>[]
      measurements: Record<string, unknown>[]
    }
    const timestamp = new Date("2026-11-01T09:05:00.000Z")
    mapIntraopToOmop(ctx as never, { events: [
      { type: "defibrillation", timestamp, label: "Defibrillation", value: "200", unit: "J" },
      { type: "defibrillation", timestamp, label: "Cardioversion", value: "100", unit: "J" },
    ] } as never, {} as never)
    const shocks = ctx.procedures.filter(row => String(row.procedure_source_value).startsWith("INTRAOP_EVENT:"))
    expect(shocks.map(row => [row.procedure_concept_id, row.procedure_source_value])).toEqual([
      [4204802, "INTRAOP_EVENT:Defibrillation"],
      [4078793, "INTRAOP_EVENT:Cardioversion"],
    ])
    const energy = ctx.measurements.filter(row => String(row.measurement_source_value).endsWith(":energy"))
    expect(energy.map(row => [row.measurement_concept_id, row.value_as_number, row.unit_concept_id])).toEqual([[0, 200, 9522], [0, 100, 9522]])
  })

  it("exports the procedure alone when no energy can be read, never a zero", () => {
    const ctx = new Proxy({
      personId: 1, visitId: 2, startDate: "2026-11-01", endDate: "2026-11-01",
      procedures: [] as Record<string, unknown>[], measurements: [] as Record<string, unknown>[], observations: [],
      conditions: [], drugs: [], devices: [],
    } as Record<string | symbol, unknown>, { get: (target, key) => (key in target ? target[key] : (target[key] = vi.fn())) }) as {
      procedures: Record<string, unknown>[]
      measurements: Record<string, unknown>[]
    }
    const timestamp = new Date("2026-11-01T09:05:00.000Z")
    mapIntraopToOmop(ctx as never, { events: [
      { type: "defibrillation", timestamp, label: "Defibrillation", value: null, unit: "J" },
      { type: "defibrillation", timestamp, label: "Defibrillation", value: "0", unit: "J" },
    ] } as never, {} as never)
    expect(ctx.procedures.filter(row => row.procedure_source_value === "INTRAOP_EVENT:Defibrillation")).toHaveLength(2)
    expect(ctx.measurements.filter(row => String(row.measurement_source_value).endsWith(":energy"))).toEqual([])
  })

  it("exports an episode's start and end beside its date, and a moment or an old item with no end", () => {
    const conditions: Record<string, unknown>[] = []
    const ctx = new Proxy({
      personId: 1, visitId: 2, startDate: "2026-11-01", endDate: "2026-11-01", conditions,
    } as Record<string | symbol, unknown>, { get: (target, key) => (key in target ? target[key] : (target[key] = vi.fn())) })
    const coded = { section: "intraop", note: null, source: "sync", sourceVocabulary: "LOSPOR_COMPLICATION", standardConceptId: 317002, mappingStatus: "mapped" }
    mapComplicationsToOmop(ctx as never, { complications: [
      { ...coded, label: "Hypotension", sourceCode: "Hypotension", ordinal: 0, timestamp: new Date("2026-11-01T09:10:00.000Z"), endTimestamp: new Date("2026-11-01T09:35:00.000Z") },
      { ...coded, label: "Hypotension", sourceCode: "Hypotension", ordinal: 1, timestamp: new Date("2026-11-01T10:00:00.000Z"), endTimestamp: null },
      { ...coded, label: "Hypotension", sourceCode: "Hypotension", ordinal: 2, timestamp: null },
    ] } as never)
    expect(conditions.map(row => [row.condition_start_date, row.condition_start_datetime, row.condition_end_date, row.condition_end_datetime])).toEqual([
      ["2026-11-01", "2026-11-01T09:10:00.000Z", "2026-11-01", "2026-11-01T09:35:00.000Z"],
      ["2026-11-01", "2026-11-01T10:00:00.000Z", null, null],
      ["2026-11-01", null, null, null],
    ])
    // The research CSV carries the three columns after the start date, in CDM order.
    expect(OMOP_COLUMNS.condition_occurrence.slice(3, 7)).toEqual([
      "condition_start_date", "condition_start_datetime", "condition_end_date", "condition_end_datetime",
    ])
  })

  it("keeps an unsynchronised shock's row as Defibrillation, whatever label the client sent", () => {
    const row = buildRow("case-1", "user-1", { id: "s", type: "defibrillation", ts: "2026-11-01T09:00:00.000Z", energyJ: 200, synchronized: false, label: "Cardioversion" } as never, 1, "active", "k", "test")
    expect(row).toMatchObject({ label: "Defibrillation", value: "200", unit: "J" })
  })
})
