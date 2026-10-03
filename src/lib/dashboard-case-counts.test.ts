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

import { dashboardCaseCounts, dashboardDayRange, dashboardMonthRange } from "./dashboard-case-counts"

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
      .mockResolvedValueOnce(1)   // today
      .mockResolvedValueOnce(12)  // month
      .mockResolvedValueOnce(30)  // active
      .mockResolvedValueOnce(5)   // drafts
      .mockResolvedValueOnce(90)  // complete
      .mockResolvedValueOnce(4)   // awaitingPostop
      .mockResolvedValueOnce(7)   // icu
    mocks.transferCount.mockResolvedValueOnce(2) // handovers

    const result = await dashboardCaseCounts({}, USER_ID, NOW)

    expect(result).toMatchObject({
      all: 120, today: 1, month: 12, active: 30, drafts: 5, complete: 90, awaitingPostop: 4, icu: 7, handovers: 2,
    })
    expect(mocks.count).toHaveBeenCalledTimes(8)
    expect(mocks.findMany).not.toHaveBeenCalled()
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
    mocks.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1)
    const result = await dashboardCaseCounts({}, USER_ID, NOW)
    expect(result.today).toBe(1)
    expect(mocks.findMany).not.toHaveBeenCalled()
    expect(mocks.count.mock.calls[1][0].where).toEqual({
      AND: [ {}, { createdAt: dashboardDayRange(NOW) } ],
    })
  })

  it("prefers a case's own monthYear label over its createdAt for 'this month'", async () => {
    mocks.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(1)
    const result = await dashboardCaseCounts({}, USER_ID, NOW)
    expect(result.month).toBe(1)
    expect(mocks.findMany).not.toHaveBeenCalled()
    const monthWhere = mocks.count.mock.calls[2][0].where
    expect(JSON.stringify(monthWhere)).toContain("2026-09")
    expect(JSON.stringify(monthWhere)).toContain("2026-9")
    expect(JSON.stringify(monthWhere)).toContain(dashboardMonthRange(NOW).gte.toISOString())
  })

  it("uses half-open Sofia calendar boundaries at the UTC edge", () => {
    const day = dashboardDayRange(NOW)
    expect(day.gte.toISOString()).toBe("2026-09-06T21:00:00.000Z")
    expect(day.lt.toISOString()).toBe("2026-09-07T21:00:00.000Z")

    const month = dashboardMonthRange(NOW)
    expect(month.gte.toISOString()).toBe("2026-08-31T21:00:00.000Z")
    expect(month.lt.toISOString()).toBe("2026-09-30T21:00:00.000Z")
  })

  it("keeps the calendar day correct across Sofia's autumn offset change", () => {
    const day = dashboardDayRange(new Date("2026-10-25T10:00:00.000Z"))

    // Midnight at the start of the day is UTC+3; midnight at the end is
    // UTC+2 because the offset changes during that local calendar day.
    expect(day.gte.toISOString()).toBe("2026-10-24T21:00:00.000Z")
    expect(day.lt.toISOString()).toBe("2026-10-25T22:00:00.000Z")
  })
})
