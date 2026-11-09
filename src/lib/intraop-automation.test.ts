import { describe, expect, it, vi } from "vitest"

import { buildRow } from "@/lib/case-events"
import { closeOpenVitalEpisodes, intraopAutomationForClient, readIntraopAutomation, saveIntraopAutomation, suggestionAcceptance, vitalStats } from "@/lib/intraop-automation"
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

describe("how the suggestions were received (10.2.0)", () => {
  const row = (caseId: string, logicalId: string, version: number, metadataJson: Record<string, unknown>) => ({ caseId, logicalId, version, metadataJson })
  const store = (rows: unknown[]) => ({
    case: { findMany: vi.fn().mockResolvedValue([{ id: "c1" }, { id: "c2" }]) },
    caseEvent: { findMany: vi.fn().mockResolvedValue(rows) },
  })

  it("adds the cases up under each automation, from the newest version of each entry", async () => {
    const rows = [
      row("c1", "q1", 1, { id: "q1", type: "complication", label: "Local anaesthetic systemic toxicity (LAST)", suggestion: "reverse:lipid" }),
      row("c1", "a1", 1, { id: "a1", type: "prompt_answer", answerKind: "reverse:adenosine", answerFor: "d1", answer: "not_now" }),
      // Two versions of the same entry count once: the newer one.
      row("c2", "a2", 1, { id: "a2", type: "prompt_answer", answerKind: "reverse:adenosine", answerFor: "d2", answer: "not_now" }),
      row("c2", "a2", 2, { id: "a2", type: "prompt_answer", answerKind: "reverse:adenosine", answerFor: "d2", answer: "not_now" }),
    ]
    const result = await suggestionAcceptance(store(rows) as never, 30, Date.now() + 1_000_000)
    expect(result.cases).toBe(2)
    expect(result.days).toBe(30)
    expect(result.byId).toEqual({ "reverse:lipid": { accepted: 1, dismissed: 0 }, "reverse:adenosine": { accepted: 0, dismissed: 2 } })
  })

  it("keeps the answer ten minutes rather than reading every chart again", async () => {
    const db = store([])
    const at = Date.now() + 5_000_000
    await suggestionAcceptance(db as never, 45, at)
    await suggestionAcceptance(db as never, 45, at + 60_000)
    expect(db.case.findMany).toHaveBeenCalledTimes(1)
    await suggestionAcceptance(db as never, 45, at + 11 * 60_000)
    expect(db.case.findMany).toHaveBeenCalledTimes(2)
  })
})

describe("settings", () => {
  it("uses the public demo profile when nothing was ever saved", async () => {
    const previous = process.env.LOSPOR_DEPLOYMENT_MODE
    process.env.LOSPOR_DEPLOYMENT_MODE = "public"
    try {
      const settings = await readIntraopAutomation(db(undefined) as never)
      expect(settings.enabled).toBe(true)
      expect(settings.groups.reminders).toBe(true)
      expect(settings.groups.treatmentSuggestions).toBe(true)
      expect(settings.groups.reverseQuestions).toBe(true)
      expect(settings.groups.labQuestions).toBe(true)
      expect(settings.groups.readingQuestions).toBe(true)
      expect(settings.groups.timers).toBe(true)
      expect(settings.vitalQuestions.enabled).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.LOSPOR_DEPLOYMENT_MODE
      else process.env.LOSPOR_DEPLOYMENT_MODE = previous
    }
  })

  it("gives an appliance with no saved policy the same everything-on default", async () => {
    const previous = process.env.LOSPOR_DEPLOYMENT_MODE
    process.env.LOSPOR_DEPLOYMENT_MODE = "hospital"
    try {
      const settings = await readIntraopAutomation(db(undefined) as never)
      expect(settings.enabled).toBe(true)
      expect(settings.groups.reminders).toBe(true)
      expect(settings.groups.treatmentSuggestions).toBe(true)
      expect(settings.groups.reverseQuestions).toBe(true)
      expect(settings.groups.labQuestions).toBe(true)
      expect(settings.vitalQuestions.enabled).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.LOSPOR_DEPLOYMENT_MODE
      else process.env.LOSPOR_DEPLOYMENT_MODE = previous
    }
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

  it("round-trips the stocked dantrolene sizes, including mixed stock and 20 mg only", async () => {
    const mixed = await readIntraopAutomation(db({ enabled: true, dantroleneVialsMg: [250, 20, 250] }) as never)
    expect(mixed.dantroleneVialsMg).toEqual([20, 250])

    const twentyOnly = await readIntraopAutomation(db({ enabled: true, dantroleneVialsMg: [20] }) as never)
    expect(twentyOnly.dantroleneVialsMg).toEqual([20])

    const store = db(undefined)
    await saveIntraopAutomation(store as never, { ...ON, dantroleneVialsMg: [250, 20, 250] })
    expect(store.intraopAutomationPolicy.upsert.mock.calls[0][0].create.config.dantroleneVialsMg).toEqual([20, 250])
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

  it("includes arterial-line and stored MAP readings using the shared lowest-pressure rule", async () => {
    const store = db(ON, {
      bp: [
        { caseId: "ibp", systolic: null, diastolic: null, ibpSystolic: 90, ibpDiastolic: 40, ibpMap: null, nibpMap: null, month: null, n: 1 },
        { caseId: "map", systolic: null, diastolic: null, ibpSystolic: null, ibpDiastolic: null, ibpMap: 55, nibpMap: null, month: null, n: 2 },
        { caseId: "nibp-map", systolic: null, diastolic: null, ibpSystolic: null, ibpDiastolic: null, ibpMap: null, nibpMap: 77, month: null, n: 1 },
      ],
      hr: [],
    }, [
      { id: "ibp", status: "COMPLETE", preop: { ageYears: 40 } },
      { id: "map", status: "COMPLETE", preop: { ageYears: 50 } },
      { id: "nibp-map", status: "COMPLETE", preop: { ageYears: 60 } },
    ])
    const stats = await vitalStats(store as never, { institutionId: "ibp-test" }, 1)
    expect(stats.ADULT?.sbp).toEqual({ min: 90, counts: [1], cases: 1 })
    expect(stats.ADULT?.dbp).toEqual({ min: 40, counts: [1], cases: 1 })
    expect(stats.ADULT?.map?.min).toBe(55)
    expect(stats.ADULT?.map?.counts[0]).toBe(2)
    expect(stats.ADULT?.map?.counts[2]).toBe(1)
    expect(stats.ADULT?.map?.counts[22]).toBe(1)
    expect(stats.ADULT?.map?.cases).toBe(3)
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

describe("the running tally", () => {
  it("serves the scopes the apps use, and counts any other scope directly", async () => {
    const { tallyScopeKey } = await import("@/lib/intraop-automation")
    expect(tallyScopeKey({ institutionId: "i1" })).toBe("institution:i1")
    expect(tallyScopeKey({ userId: "u1" })).toBe("user:u1")
    expect(tallyScopeKey({ institutionId: "i1", userId: "u1" })).toBeNull()
    expect(tallyScopeKey({})).toBeNull()
  })

  it("builds the same table shape as the direct count, with the case counts it kept", async () => {
    const { tallyTable } = await import("@/lib/intraop-automation")
    const table = tallyTable(
      [{ band: "ADULT", sign: "sbp", value: 120, count: 3 }, { band: "ADULT", sign: "sbp", value: 122, count: 1 }],
      [{ band: "ADULT", sign: "sbp", cases: 2 }],
    )
    expect(table.ADULT?.sbp).toEqual({ min: 120, counts: [3, 0, 1], cases: 2 })
  })
})
