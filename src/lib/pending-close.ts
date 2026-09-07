import { prisma } from "@/lib/prisma"
import { PENDING_CLOSE_WINDOW_MS } from "@lospor/core/case-close-window"
import {
  CaseFinalizationStepError,
  finalizeCaseWithinTransaction,
} from "@/lib/case-finalization"
import { withLockedCaseTransaction } from "@/lib/clinical-transaction"

/**
 * Closes cases whose thirty-minute review window has elapsed.
 *
 * The countdown was client-side only: it ran in the summary screen, so a case
 * whose clinician closed the app before it expired stayed AWAITING_REVIEW
 * indefinitely -- for as long as nobody reopened it. "Auto-closes in 29:14" was
 * therefore a promise only a watching browser kept, which is not what an
 * automatic close means on a clinical record.
 *
 * `awaitingReviewAt` is the server's own stamp, written once on the transition
 * into AWAITING_REVIEW, so this needs no client and no per-browser clock.
 *
 * Two rules it must not break:
 *
 *  - **An incomplete case is never closed.** Finalization gates on complete
 *    documentation, and an expired window does not make a case ready. Blocked
 *    cases are counted and left; they close on a later sweep once whatever is
 *    missing is filled in. A case nobody ever completes is scanned forever,
 *    which is cheap and correct.
 *  - **The assignee signs it.** Letting the window run out is their decision as
 *    much as pressing Close Now, so the attestation carries their id -- under
 *    its own audit action, so the log can still tell an automatic close from a
 *    deliberate one.
 */

export type PendingCloseSweep = {
  scanned: number
  closed: number
  blocked: number
  failed: number
}

export async function closeExpiredPendingCases(
  options: { limit?: number; now?: Date } = {},
): Promise<PendingCloseSweep> {
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - PENDING_CLOSE_WINDOW_MS)
  // Bounded so an opportunistic call cannot turn into an unbounded job, and so
  // a backlog drains over several sweeps rather than one very long transaction.
  const limit = options.limit ?? 25

  const due = await prisma.case.findMany({
    where: {
      status: "AWAITING_REVIEW",
      awaitingReviewAt: { not: null, lte: cutoff },
    },
    select: { id: true, userId: true, status: true },
    orderBy: { awaitingReviewAt: "asc" },
    take: limit,
  })

  const sweep: PendingCloseSweep = { scanned: due.length, closed: 0, blocked: 0, failed: 0 }

  for (const candidate of due) {
    try {
      const outcome = await withLockedCaseTransaction(candidate.id, async tx => {
        // Re-read under the lock: the window may have been closed by a client,
        // the case unfinalized, or the status moved on since the scan above.
        const current = await tx.case.findUnique({
          where: { id: candidate.id },
          select: { status: true, awaitingReviewAt: true, userId: true },
        })
        if (!current || current.status !== "AWAITING_REVIEW") return "skipped" as const
        if (!current.awaitingReviewAt || current.awaitingReviewAt > cutoff) return "skipped" as const

        return finalizeCaseWithinTransaction(tx, candidate.id, current.userId, {
          currentStatus: current.status,
          automatic: true,
        })
      })

      if (outcome === "skipped") {
        sweep.scanned -= 1
        continue
      }
      if (outcome.ok) sweep.closed += 1
      else sweep.blocked += 1
    } catch (error) {
      // One case failing must not stop the sweep: the next one may be fine, and
      // this runs unattended.
      sweep.failed += 1
      const reason = error instanceof CaseFinalizationStepError ? error.step : "transaction"
      console.error("[pending-close] could not close case", candidate.id, reason, error)
    }
  }

  return sweep
}
