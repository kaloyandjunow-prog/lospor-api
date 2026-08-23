import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  authorizeResearchRequest,
  findFirst,
  findUniqueOrThrow,
  update,
  updateMany,
  logAudit,
} = vi.hoisted(() => ({
  authorizeResearchRequest: vi.fn(),
  findFirst: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  logAudit: vi.fn(),
}))

vi.mock("next/server", async importOriginal => {
  const original = await importOriginal<typeof import("next/server")>()
  return { ...original, after: (operation: () => void) => operation() }
})

vi.mock("@/lib/prisma", () => ({
  prisma: {
    researchCohort: { findFirst, findUniqueOrThrow, update, updateMany },
  },
}))

vi.mock("@/lib/audit", () => ({ logAudit }))
vi.mock("@/lib/research/request", () => ({
  authorizeResearchRequest,
  researchRouteError: (error: unknown) => {
    throw error
  },
}))

import { PATCH } from "./route"

const updatedAt = new Date("2026-08-22T18:00:00.000Z")
const current = {
  id: "cohort-1",
  ownerId: "owner-1",
  name: "Cohort",
  description: null,
  visibility: "PRIVATE",
  institutionId: null,
  definition: { version: 1, filters: { statuses: ["COMPLETE"] } },
  createdAt: new Date("2026-08-22T17:00:00.000Z"),
  updatedAt,
  lastRunAt: null,
}

describe("saved cohort optimistic update", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    authorizeResearchRequest.mockResolvedValue({
      context: {
        user: { id: "owner-1" },
        scopeKind: "INSTITUTION",
        institutionIds: ["institution-1"],
        permissions: { shareInstitutionCohorts: false },
      },
    })
    findFirst.mockResolvedValue(current)
  })

  it("rejects a stale timestamp before attempting a write", async () => {
    const response = await PATCH(new Request("http://localhost/v1/research/cohorts/cohort-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Stale edit",
        expectedUpdatedAt: "2026-08-22T17:59:59.000Z",
      }),
    }), { params: Promise.resolve({ id: "cohort-1" }) })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: "COHORT_CHANGED" })
    expect(updateMany).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("uses the timestamp in the atomic update predicate and audits success", async () => {
    const changed = { ...current, name: "Updated", updatedAt: new Date("2026-08-22T18:01:00.000Z") }
    updateMany.mockResolvedValue({ count: 1 })
    findUniqueOrThrow.mockResolvedValue(changed)
    const response = await PATCH(new Request("http://localhost/v1/research/cohorts/cohort-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Updated", expectedUpdatedAt: updatedAt.toISOString() }),
    }), { params: Promise.resolve({ id: "cohort-1" }) })

    expect(response.status).toBe(200)
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "cohort-1", ownerId: "owner-1", updatedAt },
      data: { name: "Updated" },
    }))
    expect(update).not.toHaveBeenCalled()
    expect(logAudit).toHaveBeenCalledWith("owner-1", "RESEARCH_COHORT_UPDATE", "cohort-1")
  })

  it("detects a race that happens after the initial owner read", async () => {
    updateMany.mockResolvedValue({ count: 0 })
    const response = await PATCH(new Request("http://localhost/v1/research/cohorts/cohort-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Racing edit", expectedUpdatedAt: updatedAt.toISOString() }),
    }), { params: Promise.resolve({ id: "cohort-1" }) })

    expect(response.status).toBe(409)
    expect(findUniqueOrThrow).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })
})
