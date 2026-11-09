import { describe, expect, it } from "vitest"
import { DEFAULT_INTRAOP_AUTOMATION } from "@lospor/core/intraop-automation"
import { SEED_SUCCESSION, SUCCESSION_MIN_CASES } from "@lospor/core/event-succession"
import { intraopAutomationForClient, learnedSuccession, successionForClient, successionOverviewForStatus } from "@/lib/intraop-automation"

type Row = { caseId: string; label: string; timestamp: Date }

/** A database with just what the succession counts read: finished cases, and their sequence events. */
function fakeDb(cases: Array<{ id: string; clinicalMode?: string; techniques?: string[]; events: Array<[string, number]> }>, config: unknown = null) {
  const T0 = Date.parse("2026-11-03T08:00:00.000Z")
  const rows: Row[] = cases.flatMap(item => item.events.map(([label, minutes]) => ({ caseId: item.id, label, timestamp: new Date(T0 + minutes * 60_000) })))
  const asked: unknown[] = []
  return {
    asked,
    db: {
      case: { findMany: async (args: unknown) => { asked.push(args); return cases.map(item => ({ id: item.id, clinicalMode: item.clinicalMode ?? "ADULT", intraop: { techniques: item.techniques ?? ["GENERAL_TIVA"] } })) } },
      caseEvent: { findMany: async (args: { where: { caseId: { in: string[] } } }) => rows.filter(row => args.where.caseId.in.includes(row.caseId)) },
      intraopAutomationPolicy: { findUnique: async () => (config ? { config } : null) },
    } as never,
  }
}

const unique = () => ({ company: `scope-${Math.random()}` }) as never

describe("what usually comes next, learned from finished cases (10.2.0)", () => {
  it("tells Status which links are learned and how many cases each starting event has so far", async () => {
    const { db } = fakeDb(Array.from({ length: SUCCESSION_MIN_CASES }, (_, index) => ({ id: `s${index}`, events: [["Positioned", 0], ["Incision", 15]] as Array<[string, number]> })))
    const rows = await successionOverviewForStatus(db, unique())
    expect(rows.find(row => row.context === "general" && row.from === "Positioned")).toMatchObject({ source: "learned", learnedCases: SUCCESSION_MIN_CASES, gapMinutes: 15, share: 1 })
    expect(rows.find(row => row.context === "general" && row.from === "Induction")).toMatchObject({ source: "starting", learnedCases: 0 })
    expect(JSON.stringify(rows)).not.toMatch(/"s[0-9]+"/)
  })

  it("counts which event followed which, per technique family, from the finished cases", async () => {
    const { db } = fakeDb([
      { id: "a", events: [["Positioned", 0], ["Incision", 4]] },
      { id: "b", events: [["Positioned", 0], ["Incision", 6]] },
      { id: "c", techniques: ["SPINAL_SINGLE_LUMBAR"], events: [["Positioned", 0], ["Incision", 20]] },
    ])
    const links = await learnedSuccession(db, unique())
    expect(links).toEqual(expect.arrayContaining([
      { context: "general", from: "Positioned", to: "Incision", count: 2, total: 2, gapMinutes: 5 },
      { context: "neuraxial", from: "Positioned", to: "Incision", count: 1, total: 1, gapMinutes: 20 },
    ]))
  })

  it("reads only finished cases that started, and only the sequence events", async () => {
    const { db, asked } = fakeDb([{ id: "a", events: [["Positioned", 0], ["Hypotension", 1], ["Incision", 4]] }])
    const links = await learnedSuccession(db, unique())
    expect(links.map(link => link.to)).toEqual(["Incision"])
    expect(JSON.stringify(asked[0])).toContain("COMPLETE")
  })

  it("keeps the starting values until a starting event has been seen in enough cases, then replaces it", async () => {
    const few = fakeDb(Array.from({ length: SUCCESSION_MIN_CASES - 1 }, (_, index) => ({ id: `f${index}`, events: [["Positioned", 0], ["Incision", 15]] as Array<[string, number]> })))
    const early = await successionForClient(few.db, unique())
    expect(early.find(link => link.context === "general" && link.from === "Positioned")).toMatchObject({ gapMinutes: 5 })

    const many = fakeDb(Array.from({ length: SUCCESSION_MIN_CASES }, (_, index) => ({ id: `m${index}`, events: [["Positioned", 0], ["Incision", 15]] as Array<[string, number]> })))
    const later = await successionForClient(many.db, unique())
    expect(later.find(link => link.context === "general" && link.from === "Positioned")).toMatchObject({ gapMinutes: 15, count: SUCCESSION_MIN_CASES })
    expect(later.length).toBeGreaterThanOrEqual(SEED_SUCCESSION.length - 1)
  })

  it("is sent to the apps only while the reminders are on, and carries no case or clinician", async () => {
    const off = fakeDb([{ id: "a", events: [["Positioned", 0], ["Incision", 4]] }], { ...DEFAULT_INTRAOP_AUTOMATION, groups: { ...DEFAULT_INTRAOP_AUTOMATION.groups, reminders: false } })
    expect((await intraopAutomationForClient(off.db, unique())).succession).toBeNull()
    // Nothing saved is the defaults, with the reminders on.
    const fresh = fakeDb([{ id: "a", events: [["Positioned", 0], ["Incision", 4]] }])
    expect((await intraopAutomationForClient(fresh.db, unique())).succession).not.toBeNull()

    const on = fakeDb([{ id: "secret-case-id", events: [["Positioned", 0], ["Incision", 4]] }], { ...DEFAULT_INTRAOP_AUTOMATION, enabled: true, groups: { ...DEFAULT_INTRAOP_AUTOMATION.groups, reminders: true } })
    const body = await intraopAutomationForClient(on.db, unique())
    expect(body.succession).not.toBeNull()
    expect(JSON.stringify(body.succession)).not.toContain("secret-case-id")
  })
})
