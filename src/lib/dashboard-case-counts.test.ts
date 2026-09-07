import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  findMany: vi.fn(),
  transferCount: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    case: { count: mocks.count, findMany: mocks.findMany },
    caseTransfer: { count: mocks.transferCount },
  },
}))

import { dashboardCaseCounts } from "./dashboard-case-counts"

const NOW = new Date("2026-09-07T10:00:00.000Z") // 13:00 in Sofia (UTC+3, summer)
const USER_ID = "user-1"

describe("dashboardCaseCounts", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.count.mockResolvedValue(0)
    mocks.findMany.mockResolvedValue([])
    mocks.transferCount.mockResolvedValue(0)
  })

  it("counts every column-filter scope from the database, not a loaded page", async () => {
    mocks.count
      .mockResolvedValueOnce(120) // all
      .mockResolvedValueOnce(30)  // active
      .mockResolvedValueOnce(5)   // drafts
      .mockResolvedValueOnce(90)  // complete
      .mockResolvedValueOnce(4)   // awaitingPostop
      .mockResolvedValueOnce(7)   // icu
    mocks.transferCount.mockResolvedValueOnce(2) // handovers

    const result = await dashboardCaseCounts({}, USER_ID, NOW)

    expect(result).toMatchObject({
      all: 120, active: 30, drafts: 5, complete: 90, awaitingPostop: 4, icu: 7, handovers: 2,
    })
    expect(mocks.count).toHaveBeenCalledTimes(6)
  })

  // "Handovers" means awaiting action by this user specifically -- matching
  // /v1/cases/transfers/pending's own default (incoming) -- not any pending
  // transfer on any case this user can otherwise see.
  it("counts handovers as pending transfers addressed to this user, independent of the case-access where clause", async () => {
    await dashboardCaseCounts({ institutionId: "inst-1" }, USER_ID, NOW)

    expect(mocks.transferCount).toHaveBeenCalledWith({
      where: { toUserId: USER_ID, status: "PENDING" },
    })
  })

  it("counts today by the calendar day in Europe/Sofia, not the server's own local clock", async () => {
    // 23:30 UTC on the 6th is already the 7th in Sofia.
    mocks.findMany.mockResolvedValueOnce([
      { createdAt: new Date("2026-09-06T23:30:00.000Z"), intraop: null },
      { createdAt: new Date("2026-09-06T20:00:00.000Z"), intraop: null },
    ])
    const result = await dashboardCaseCounts({}, USER_ID, NOW)
    expect(result.today).toBe(1)
  })

  it("prefers a case's own monthYear label over its createdAt for 'this month'", async () => {
    mocks.findMany.mockResolvedValueOnce([
      // Created in August but the intraoperative record is labelled September --
      // the label wins, because it is the calendar month the case belongs to
      // clinically, not merely when the row was first drafted.
      { createdAt: new Date("2026-08-31T22:00:00.000Z"), intraop: { monthYear: "2026-9" } },
      { createdAt: new Date("2026-08-15T10:00:00.000Z"), intraop: null },
    ])
    const result = await dashboardCaseCounts({}, USER_ID, NOW)
    expect(result.month).toBe(1)
  })
})
