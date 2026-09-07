import { beforeEach, describe, expect, it, vi } from "vitest"

const hoisted = vi.hoisted(() => ({
  findMany: vi.fn(),
  finalize: vi.fn(),
  lockedTransaction: vi.fn(),
  caseFindUnique: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: { case: { findMany: hoisted.findMany } },
}))

vi.mock("@/lib/clinical-transaction", () => ({
  withLockedCaseTransaction: hoisted.lockedTransaction,
}))

vi.mock("@/lib/case-finalization", async () => {
  const actual = await vi.importActual<typeof import("@/lib/case-finalization")>("@/lib/case-finalization")
  return { ...actual, finalizeCaseWithinTransaction: hoisted.finalize }
})

import { closeExpiredPendingCases } from "./pending-close"
import { CaseFinalizationStepError } from "./case-finalization"

const NOW = new Date("2026-09-06T12:00:00.000Z")
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000)

/** Runs the callback against a fake tx whose case.findUnique the test controls. */
function runTransaction() {
  hoisted.lockedTransaction.mockImplementation(async (_id: string, fn: (tx: unknown) => unknown) =>
    fn({ case: { findUnique: hoisted.caseFindUnique } }))
}

beforeEach(() => {
  vi.clearAllMocks()
  runTransaction()
  hoisted.finalize.mockResolvedValue({ ok: true, from: "AWAITING_REVIEW", finalizedAt: NOW })
})

describe("closeExpiredPendingCases", () => {
  it("closes a case whose review window elapsed", async () => {
    hoisted.findMany.mockResolvedValue([{ id: "c1", userId: "u1", status: "AWAITING_REVIEW" }])
    hoisted.caseFindUnique.mockResolvedValue({
      status: "AWAITING_REVIEW", awaitingReviewAt: minutesAgo(31), userId: "u1",
    })

    const sweep = await closeExpiredPendingCases({ now: NOW })

    expect(sweep).toMatchObject({ scanned: 1, closed: 1, blocked: 0, failed: 0 })
  })

  /**
   * The sweep still passes the case's assignee through as `actorUserId` --
   * finalizeCaseWithinTransaction is what decides that an automatic close
   * records the system, not this person, as who actually signed it, but it
   * still needs to know who was assigned to record that separately. See its
   * own doc comment.
   */
  it("passes the case's assignee through, under the automatic action", async () => {
    hoisted.findMany.mockResolvedValue([{ id: "c1", userId: "stale", status: "AWAITING_REVIEW" }])
    hoisted.caseFindUnique.mockResolvedValue({
      status: "AWAITING_REVIEW", awaitingReviewAt: minutesAgo(31), userId: "current-assignee",
    })

    await closeExpiredPendingCases({ now: NOW })

    expect(hoisted.finalize).toHaveBeenCalledWith(
      expect.anything(),
      "c1",
      "current-assignee",
      expect.objectContaining({ automatic: true }),
    )
  })

  /**
   * An expired window does not make a case ready. Finalization still gates on
   * complete documentation, so an incomplete case is counted and left for a
   * later sweep rather than closed.
   */
  it("leaves an incomplete case open and counts it as blocked", async () => {
    hoisted.findMany.mockResolvedValue([{ id: "c1", userId: "u1", status: "AWAITING_REVIEW" }])
    hoisted.caseFindUnique.mockResolvedValue({
      status: "AWAITING_REVIEW", awaitingReviewAt: minutesAgo(31), userId: "u1",
    })
    hoisted.finalize.mockResolvedValue({ ok: false, blockers: [{ code: "missing_postop", path: ["postop"], severity: "error" }] })

    const sweep = await closeExpiredPendingCases({ now: NOW })

    expect(sweep).toMatchObject({ scanned: 1, closed: 0, blocked: 1 })
  })

  // The scan is not under the lock, so anything may have moved since.
  it("skips a case a client already closed between the scan and the lock", async () => {
    hoisted.findMany.mockResolvedValue([{ id: "c1", userId: "u1", status: "AWAITING_REVIEW" }])
    hoisted.caseFindUnique.mockResolvedValue({
      status: "COMPLETE", awaitingReviewAt: minutesAgo(31), userId: "u1",
    })

    const sweep = await closeExpiredPendingCases({ now: NOW })

    expect(hoisted.finalize).not.toHaveBeenCalled()
    expect(sweep).toMatchObject({ scanned: 0, closed: 0 })
  })

  /**
   * Unfinalize clears awaitingReviewAt, but a case reopened and pushed back to
   * review carries a fresh stamp -- so a re-read showing a stamp inside the
   * window means somebody restarted the clock deliberately.
   */
  it("skips a case whose window was restarted since the scan", async () => {
    hoisted.findMany.mockResolvedValue([{ id: "c1", userId: "u1", status: "AWAITING_REVIEW" }])
    hoisted.caseFindUnique.mockResolvedValue({
      status: "AWAITING_REVIEW", awaitingReviewAt: minutesAgo(2), userId: "u1",
    })

    const sweep = await closeExpiredPendingCases({ now: NOW })

    expect(hoisted.finalize).not.toHaveBeenCalled()
    expect(sweep).toMatchObject({ scanned: 0 })
  })

  it("skips a case whose row vanished between the scan and the lock", async () => {
    hoisted.findMany.mockResolvedValue([{ id: "c1", userId: "u1", status: "AWAITING_REVIEW" }])
    hoisted.caseFindUnique.mockResolvedValue(null)

    const sweep = await closeExpiredPendingCases({ now: NOW })

    expect(hoisted.finalize).not.toHaveBeenCalled()
    expect(sweep).toMatchObject({ scanned: 0 })
  })

  // This runs unattended: one bad case must not strand every case behind it.
  it("keeps going when one case fails, and counts the failure", async () => {
    hoisted.findMany.mockResolvedValue([
      { id: "c1", userId: "u1", status: "AWAITING_REVIEW" },
      { id: "c2", userId: "u2", status: "AWAITING_REVIEW" },
    ])
    hoisted.caseFindUnique.mockResolvedValue({
      status: "AWAITING_REVIEW", awaitingReviewAt: minutesAgo(31), userId: "u1",
    })
    hoisted.finalize
      .mockRejectedValueOnce(new CaseFinalizationStepError("snapshot", new Error("disk full")))
      .mockResolvedValueOnce({ ok: true, from: "AWAITING_REVIEW", finalizedAt: NOW })
    vi.spyOn(console, "error").mockImplementation(() => {})

    const sweep = await closeExpiredPendingCases({ now: NOW })

    expect(sweep).toMatchObject({ scanned: 2, closed: 1, failed: 1 })
  })

  it("asks only for cases past the window, oldest first, and bounded", async () => {
    hoisted.findMany.mockResolvedValue([])

    await closeExpiredPendingCases({ now: NOW, limit: 5 })

    expect(hoisted.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: "AWAITING_REVIEW",
        awaitingReviewAt: { not: null, lte: minutesAgo(30) },
      },
      orderBy: { awaitingReviewAt: "asc" },
      take: 5,
    }))
  })

  it("does nothing when no case is due", async () => {
    hoisted.findMany.mockResolvedValue([])

    expect(await closeExpiredPendingCases({ now: NOW }))
      .toEqual({ scanned: 0, closed: 0, blocked: 0, failed: 0 })
  })
})
