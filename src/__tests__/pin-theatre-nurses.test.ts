import { describe, expect, it, vi } from "vitest"
import { pinNursesOfCaseTheatre, pinTheatreNurses } from "@/lib/nurse-access"

// 2026-11-23: a nurse put on a theatre for a day gets a place on that theatre's cases (source THEATRE), not only reach through it.
function fakeDb(opts: { shifts?: { userId: string }[]; cases?: { id: string }[]; theatreCase?: { operatingTheatreId: string | null; plannedSurgeryDate: Date | null } | null }) {
  const createMany = vi.fn(async ({ data }: { data: unknown[] }) => ({ count: data.length }))
  const findMany = vi.fn(async (_args: unknown) => opts.cases ?? [])
  return {
    createMany, caseFindMany: findMany,
    db: {
      theatreNurseShift: { findMany: vi.fn(async () => opts.shifts ?? []) },
      case: { findMany, findUnique: vi.fn(async () => opts.theatreCase ?? null) },
      caseNurse: { createMany },
    } as never,
  }
}

describe("pinning the theatre's nurses to its cases", () => {
  it("puts the nurse on every open case of the theatre that day, source THEATRE", async () => {
    const { db, createMany } = fakeDb({ shifts: [{ userId: "n1" }], cases: [{ id: "c1" }, { id: "c2" }] })
    expect(await pinTheatreNurses(db, { theatreId: "t1", shiftDate: "2026-11-23", userId: "n1", today: "2026-11-23" })).toBe(2)
    expect(createMany).toHaveBeenCalledWith({
      data: [{ caseId: "c1", userId: "n1", source: "THEATRE" }, { caseId: "c2", userId: "n1", source: "THEATRE" }],
      skipDuplicates: true,
    })
  })
  it("takes cases with no planned date only for today", async () => {
    const today = fakeDb({ shifts: [{ userId: "n1" }], cases: [{ id: "c1" }] })
    await pinTheatreNurses(today.db, { theatreId: "t1", shiftDate: "2026-11-23", today: "2026-11-23" })
    expect(JSON.stringify(today.caseFindMany.mock.calls[0][0])).toContain("\"plannedSurgeryDate\":null")
    const later = fakeDb({ shifts: [{ userId: "n1" }], cases: [{ id: "c1" }] })
    await pinTheatreNurses(later.db, { theatreId: "t1", shiftDate: "2026-11-24", today: "2026-11-23" })
    expect(JSON.stringify(later.caseFindMany.mock.calls[0][0])).not.toContain("\"plannedSurgeryDate\":null")
  })
  it("writes nothing with no nurse on the theatre or no case in it", async () => {
    const noNurse = fakeDb({ cases: [{ id: "c1" }] })
    expect(await pinTheatreNurses(noNurse.db, { theatreId: "t1", shiftDate: "2026-11-23", today: "2026-11-23" })).toBe(0)
    const noCase = fakeDb({ shifts: [{ userId: "n1" }] })
    expect(await pinTheatreNurses(noCase.db, { theatreId: "t1", shiftDate: "2026-11-23", today: "2026-11-23" })).toBe(0)
    expect(noNurse.createMany).not.toHaveBeenCalled()
    expect(noCase.createMany).not.toHaveBeenCalled()
  })
  it("does nothing for a case that is in no theatre", async () => {
    const { db, createMany } = fakeDb({ theatreCase: { operatingTheatreId: null, plannedSurgeryDate: null } })
    expect(await pinNursesOfCaseTheatre(db, "c1")).toBe(0)
    expect(createMany).not.toHaveBeenCalled()
  })
})
