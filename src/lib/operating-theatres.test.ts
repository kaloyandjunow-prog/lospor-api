import { describe, expect, it, vi } from "vitest"
import { CASE_SELECT } from "./omop-export-source"
import { RESEARCH_SUMMARY_SELECT } from "./research/mappers"
import { assignCaseTheatre, changeOperatingTheatres, keepTheatreNameAtStart, OperatingTheatreError, readOperatingTheatreConfig } from "./operating-theatres"

type Theatre = { id: string; name: string; active: boolean; sortOrder: number; createdAt: Date }
type CaseRow = { id: string; status: string; operatingTheatreId: string | null; operatingTheatreName: string | null; intraop: { startedAt: Date | null; startTime: Date | null } | null }

function fakeDb(state: { enabled: boolean; theatres: Theatre[]; cases: CaseRow[] }) {
  const theatreOf = (id: string | null) => state.theatres.find(theatre => theatre.id === id) ?? null
  const db = {
    operatingTheatrePolicy: {
      findUnique: vi.fn(async () => ({ enabled: state.enabled })),
      upsert: vi.fn(async ({ update }: { update: { enabled: boolean } }) => { state.enabled = update.enabled }),
    },
    operatingTheatre: {
      findMany: vi.fn(async ({ where }: { where?: { active?: boolean } }) => state.theatres
        .filter(theatre => where?.active === undefined || theatre.active === where.active)
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map(theatre => ({ id: theatre.id, name: theatre.name }))),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => theatreOf(where.id)),
      findFirst: vi.fn(async ({ where }: { where: { name: { equals: string }; id?: { not: string } } }) =>
        state.theatres.find(theatre => theatre.active && theatre.name.toLowerCase() === where.name.equals.toLowerCase() && theatre.id !== where.id?.not) ?? null),
      aggregate: vi.fn(async () => ({ _max: { sortOrder: Math.max(-1, ...state.theatres.map(theatre => theatre.sortOrder)) } })),
      create: vi.fn(async ({ data }: { data: { name: string; sortOrder: number } }) => {
        const theatre = { id: `t${state.theatres.length + 1}`, active: true, createdAt: new Date(), ...data }
        state.theatres.push(theatre)
        return theatre
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Theatre> }) => Object.assign(theatreOf(where.id)!, data)),
    },
    auditLog: { findFirst: vi.fn(async () => ({ userId: "u-hod" })) },
    user: { findUnique: vi.fn(async () => ({ name: "Dr Head" })) },
    case: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = state.cases.find(item => item.id === where.id)
        return row ? { ...row, operatingTheatre: theatreOf(row.operatingTheatreId) } : null
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<CaseRow> }) => Object.assign(state.cases.find(item => item.id === where.id)!, data)),
      updateMany: vi.fn(async ({ where, data }: { where: { operatingTheatreId: string }; data: Partial<CaseRow> }) => {
        const rows = state.cases.filter(item => item.operatingTheatreId === where.operatingTheatreId && !item.operatingTheatreName
          && item.status !== "COMPLETE" && (item.intraop?.startedAt || item.intraop?.startTime))
        rows.forEach(row => Object.assign(row, data))
        return { count: rows.length }
      }),
    },
  }
  return db as unknown as Parameters<typeof assignCaseTheatre>[0]
}

const theatre = (id: string, name: string, sortOrder: number, active = true): Theatre => ({ id, name, sortOrder, active, createdAt: new Date() })
const draft = (id: string, theatreId: string | null = null): CaseRow => ({ id, status: "DRAFT", operatingTheatreId: theatreId, operatingTheatreName: null, intraop: null })

describe("operating theatres in the API (10.0.0)", () => {
  it("offers nothing while off, and the active theatres in order when on", async () => {
    const state = { enabled: false, theatres: [theatre("b", "Зала 2", 1), theatre("a", "Зала 1", 0), theatre("x", "Стара", 2, false)], cases: [] }
    expect(await readOperatingTheatreConfig(fakeDb(state))).toEqual({ enabled: false, theatres: [] })
    state.enabled = true
    expect(await readOperatingTheatreConfig(fakeDb(state))).toEqual({ enabled: true, theatres: [{ id: "a", name: "Зала 1" }, { id: "b", name: "Зала 2" }] })
  })

  it("assigns until intraop starts, then refuses", async () => {
    const state = { enabled: true, theatres: [theatre("a", "Зала 1", 0), theatre("x", "Стара", 1, false)], cases: [draft("c1")] }
    const db = fakeDb(state)
    expect(await assignCaseTheatre(db, "c1", "a")).toEqual({ before: null, after: "a" })
    await expect(assignCaseTheatre(db, "c1", "x")).rejects.toEqual(new OperatingTheatreError("THEATRE_NOT_FOUND", 404))
    state.cases[0].intraop = { startedAt: new Date(), startTime: null }
    await expect(assignCaseTheatre(db, "c1", null)).rejects.toEqual(new OperatingTheatreError("THEATRE_LOCKED_INTRAOP_STARTED", 409))
    state.enabled = false
    await expect(assignCaseTheatre(db, "c1", "a")).rejects.toEqual(new OperatingTheatreError("OPERATING_THEATRES_OFF", 409))
  })

  it("refuses a change made on an out-of-date view, naming what the case has now and who set it", async () => {
    const state = { enabled: true, theatres: [theatre("a", "Зала 1", 0), theatre("b", "Зала 2", 1)], cases: [draft("c1")] }
    const db = fakeDb(state)
    // Both opened the menu while the case had no theatre; the head of department saves first.
    expect(await assignCaseTheatre(db, "c1", "a", null)).toEqual({ before: null, after: "a" })
    const refused = await assignCaseTheatre(db, "c1", "b", null).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(OperatingTheatreError)
    expect(refused).toMatchObject({ code: "THEATRE_CHANGED", status: 409, details: { current: { id: "a", name: "Зала 1" }, changedBy: "Dr Head" } })
    expect(state.cases[0].operatingTheatreId).toBe("a")
    // Chosen again on the current view, it goes through.
    expect(await assignCaseTheatre(db, "c1", "b", "a")).toEqual({ before: "a", after: "b" })
  })

  it("keeps the name a case started with, through a rename", async () => {
    const state = { enabled: true, theatres: [theatre("a", "Зала 1", 0)], cases: [draft("started", "a"), draft("waiting", "a")] }
    const db = fakeDb(state)
    state.cases[0].intraop = { startedAt: new Date(), startTime: null }
    await keepTheatreNameAtStart(db, "started")
    await keepTheatreNameAtStart(db, "waiting")
    expect(state.cases.map(item => item.operatingTheatreName)).toEqual(["Зала 1", null])
    await changeOperatingTheatres(db, { action: "rename", id: "a", name: "  Зала   1А " })
    expect(state.theatres[0].name).toBe("Зала 1А")
    expect(state.cases[0].operatingTheatreName).toBe("Зала 1")
  })

  it("names a theatre once among the active ones", async () => {
    const state = { enabled: true, theatres: [theatre("a", "Зала 1", 0)], cases: [] }
    const db = fakeDb(state)
    await expect(changeOperatingTheatres(db, { action: "add", name: "зала 1" })).rejects.toEqual(new OperatingTheatreError("THEATRE_NAME_TAKEN", 409))
    await expect(changeOperatingTheatres(db, { action: "add", name: " " })).rejects.toEqual(new OperatingTheatreError("THEATRE_NAME_INVALID"))
    await changeOperatingTheatres(db, { action: "add", name: "Зала 2" })
    expect(state.theatres.map(item => [item.name, item.sortOrder])).toEqual([["Зала 1", 0], ["Зала 2", 1]])
  })

  it("is left out of every research export", () => {
    for (const select of [CASE_SELECT, RESEARCH_SUMMARY_SELECT]) {
      expect(Object.keys(select)).not.toContain("operatingTheatreId")
      expect(Object.keys(select)).not.toContain("operatingTheatreName")
      expect(Object.keys(select)).not.toContain("operatingTheatre")
    }
  })
})
