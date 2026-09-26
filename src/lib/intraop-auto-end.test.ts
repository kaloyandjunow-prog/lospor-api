import { beforeEach, describe, expect, it, vi } from "vitest"

const tx = {
  case: { findUnique: vi.fn() },
  intraoperativeRecord: { update: vi.fn() },
}
const rebuildProjection = vi.fn()
const activeCaseLog = vi.fn()
const logAuditInTransaction = vi.fn()
const findMany = vi.fn()

vi.mock("@/lib/prisma", () => ({ prisma: { intraoperativeRecord: { findMany: (...args: unknown[]) => findMany(...args) } } }))
vi.mock("@/lib/clinical-transaction", () => ({
  withLockedCaseTransaction: (_id: string, operation: (client: typeof tx) => unknown) => operation(tx),
}))
vi.mock("@/lib/case-events", () => ({
  activeCaseLog: (...args: unknown[]) => activeCaseLog(...args),
  rebuildProjection: (...args: unknown[]) => rebuildProjection(...args),
}))
vi.mock("@/lib/audit", () => ({ logAuditInTransaction: (...args: unknown[]) => logAuditInTransaction(...args) }))

import { AUTO_END_SYSTEM_ACTOR_ID, autoEndCaseIfStale, autoEndStaleIntraopCases } from "./intraop-auto-end"

const startedAt = new Date("2026-09-20T08:00:00.000Z")
const now = new Date("2026-09-22T08:30:00.000Z")

function caseRecord(overrides: Record<string, unknown> = {}) {
  return { status: "IN_PROGRESS", userId: "u1", intraop: { startedAt, endedAt: null, updatedAt: startedAt }, lock: null, ...overrides }
}

describe("48-hour automatic end", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    activeCaseLog.mockResolvedValue([
      { id: "a", type: "drug", name: "Fentanyl", ts: "2026-09-20T10:15:00.000Z" },
      { id: "b", type: "drug", name: "Planned", ts: "2026-09-23T10:00:00.000Z" },
    ])
  })

  it("ends at the last recorded entry, marks it, rebuilds and audits as the system", async () => {
    tx.case.findUnique.mockResolvedValue(caseRecord())
    const endedAt = await autoEndCaseIfStale("c1", now)
    expect(endedAt?.toISOString()).toBe("2026-09-20T10:15:00.000Z")
    expect(tx.intraoperativeRecord.update).toHaveBeenCalledWith({
      where: { caseId: "c1" },
      data: { endedAt, autoEndedAt: now, syncRevision: { increment: 1 } },
    })
    expect(rebuildProjection).toHaveBeenCalled()
    expect(logAuditInTransaction).toHaveBeenCalledWith(tx, AUTO_END_SYSTEM_ACTOR_ID, "CASE_INTRAOP_AUTO_ENDED", "c1", expect.objectContaining({ assignedUserId: "u1" }))
  })

  it("leaves a case alone while a screen holds it, once ended, or when finalised", async () => {
    for (const record of [
      caseRecord({ lock: { expiresAt: new Date(now.getTime() + 10_000) } }),
      caseRecord({ intraop: { startedAt, endedAt: now } }),
      caseRecord({ status: "COMPLETE" }),
      caseRecord({ intraop: { startedAt: new Date(now.getTime() - 60 * 60_000), endedAt: null, updatedAt: startedAt } }),
      // Charted retrospectively: an old start, but saved to an hour ago.
      caseRecord({ intraop: { startedAt, endedAt: null, updatedAt: new Date(now.getTime() - 60 * 60_000) } }),
    ]) {
      tx.case.findUnique.mockResolvedValue(record)
      expect(await autoEndCaseIfStale("c1", now)).toBeNull()
    }
    expect(tx.intraoperativeRecord.update).not.toHaveBeenCalled()
  })

  it("sweeps the candidates and counts what it ended", async () => {
    findMany.mockResolvedValue([{ caseId: "c1" }, { caseId: "c2" }])
    tx.case.findUnique.mockResolvedValueOnce(caseRecord()).mockResolvedValueOnce(caseRecord({ status: "COMPLETE" }))
    expect(await autoEndStaleIntraopCases({ now })).toEqual({ scanned: 2, ended: 1, failed: 0 })
  })
})
