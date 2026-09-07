import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  findMany: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: { case: { count: mocks.count, findMany: mocks.findMany } },
}))

import { findCasesByPriority } from "./priority-case-list"

describe("findCasesByPriority", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("skips an empty tier entirely without querying it for rows", async () => {
    mocks.count.mockImplementation(({ where }: { where: { status: string } }) =>
      Promise.resolve(where.status === "AWAITING_REVIEW" ? 0 : where.status === "IN_PROGRESS" ? 2 : 0))
    mocks.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }])

    const result = await findCasesByPriority({}, {}, 0, 5)

    expect(result).toEqual([{ id: "a" }, { id: "b" }])
    expect(mocks.findMany).toHaveBeenCalledTimes(1)
    expect(mocks.findMany.mock.calls[0][0].where.status).toBe("IN_PROGRESS")
  })

  it("stops once take is satisfied, never touching a lower-priority tier", async () => {
    mocks.count.mockResolvedValue(5)
    mocks.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }])

    const result = await findCasesByPriority({}, {}, 0, 2)

    expect(result).toEqual([{ id: "a" }, { id: "b" }])
    expect(mocks.findMany).toHaveBeenCalledTimes(1)
    expect(mocks.findMany.mock.calls[0][0].where.status).toBe("AWAITING_REVIEW")
  })

  it("carries skip forward across tiers rather than re-applying it to each one", async () => {
    mocks.count.mockImplementation(({ where }: { where: { status: string } }) =>
      Promise.resolve(where.status === "AWAITING_REVIEW" ? 3 : where.status === "IN_PROGRESS" ? 3 : 0))
    mocks.findMany.mockImplementation(({ where, skip, take }: { where: { status: string }; skip: number; take: number }) =>
      Promise.resolve(where.status === "IN_PROGRESS"
        ? [{ id: `in-progress-skip${skip}-take${take}` }]
        : []))

    // 3 AWAITING_REVIEW rows exist; skip=3 exhausts that tier entirely, so
    // the remaining skip (0) and the full take carry into IN_PROGRESS.
    const result = await findCasesByPriority({}, {}, 3, 1)

    expect(result).toEqual([{ id: "in-progress-skip0-take1" }])
  })

  it("returns an empty list without querying anything once take is already zero", async () => {
    const result = await findCasesByPriority({}, {}, 0, 0)
    expect(result).toEqual([])
    expect(mocks.count).not.toHaveBeenCalled()
    expect(mocks.findMany).not.toHaveBeenCalled()
  })
})
