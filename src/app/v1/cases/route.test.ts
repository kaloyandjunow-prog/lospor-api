import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
}))

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: mocks.auth }))
vi.mock("@/lib/prisma", () => ({
  prisma: { case: { findMany: mocks.findMany, count: mocks.count } },
}))
vi.mock("@/lib/access-control", () => ({
  caseReadWhereForUser: () => ({}),
  caseCapabilitiesForUser: () => ({ canWrite: true }),
}))
vi.mock("@/lib/dashboard-case-counts", () => ({
  dashboardCaseCounts: vi.fn().mockResolvedValue({
    all: 0, today: 0, month: 0, active: 0, drafts: 0, awaitingPostop: 0, complete: 0, icu: 0, handovers: 0,
  }),
}))

describe("GET /v1/cases pagination", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({ id: "user-1", role: "CLINICIAN" })
    mocks.findMany.mockResolvedValue([])
    mocks.count.mockResolvedValue(0)
  })

  it("truncates a fractional take/skip instead of handing Prisma a non-integer", async () => {
    // Every tier has rows, so the first (AWAITING_REVIEW) tier is queried.
    mocks.count.mockResolvedValue(5)
    mocks.findMany.mockResolvedValue([{ id: "c1" }])
    const { GET } = await import("./route")
    const res = await GET(new NextRequest("http://localhost/v1/cases?skip=1.9&take=1.5"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.skip).toBe(1)
    expect(body.take).toBe(1)
    expect(Number.isInteger(mocks.findMany.mock.calls[0][0].skip)).toBe(true)
    expect(Number.isInteger(mocks.findMany.mock.calls[0][0].take)).toBe(true)
  })

  it("still falls back to the defaults for a non-numeric query string", async () => {
    const { GET } = await import("./route")
    const res = await GET(new NextRequest("http://localhost/v1/cases?skip=abc&take=xyz"))
    const body = await res.json()
    expect(body.skip).toBe(0)
    expect(body.take).toBe(50)
  })

  // A plain `orderBy: { status: "asc" }` sorts by the enum's declared order
  // (DRAFT, IN_PROGRESS, AWAITING_REVIEW, COMPLETE), which would put every
  // draft ahead of the case closest to auto-closing. This is the regression
  // that ordering shipped with; the fix queries one status tier at a time.
  it("orders cases by clinical urgency: AWAITING_REVIEW, then IN_PROGRESS, then DRAFT, then COMPLETE", async () => {
    mocks.count.mockImplementation(({ where }: { where?: { status?: string } }) =>
      Promise.resolve(where?.status ? 1 : 4)) // per-tier counts of 1; the plain `total` count of 4
    mocks.findMany.mockImplementation(({ where }: { where: { status: string } }) =>
      Promise.resolve([{ id: `${where.status}-case`, status: where.status }]))

    const { GET } = await import("./route")
    const res = await GET(new NextRequest("http://localhost/v1/cases?take=10"))
    const body = await res.json()
    expect(body.cases.map((c: { id: string }) => c.id)).toEqual([
      "AWAITING_REVIEW-case", "IN_PROGRESS-case", "DRAFT-case", "COMPLETE-case",
    ])
  })

  it("carries skip across tiers instead of restarting it for each one", async () => {
    // 1 AWAITING_REVIEW case, 3 IN_PROGRESS cases; skip=1 should land inside
    // IN_PROGRESS at its second row, not re-apply skip=1 to every tier.
    mocks.count.mockImplementation(({ where }: { where?: { status?: string } }) => {
      if (!where?.status) return Promise.resolve(4)
      return Promise.resolve(where.status === "AWAITING_REVIEW" ? 1 : where.status === "IN_PROGRESS" ? 3 : 0)
    })
    mocks.findMany.mockImplementation(({ where, skip, take }: { where: { status: string }; skip: number; take: number }) => {
      if (where.status === "IN_PROGRESS") {
        return Promise.resolve(
          Array.from({ length: take }, (_, i) => ({ id: `in-progress-${skip + i}`, status: "IN_PROGRESS" })),
        )
      }
      return Promise.resolve([])
    })

    const { GET } = await import("./route")
    const res = await GET(new NextRequest("http://localhost/v1/cases?skip=1&take=2"))
    const body = await res.json()
    expect(body.cases.map((c: { id: string }) => c.id)).toEqual(["in-progress-0", "in-progress-1"])
  })
})
