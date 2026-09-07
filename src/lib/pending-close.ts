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
 *    documentation, and an expired window does not make a case ready. A
 *    blocked case backs off and is retried later, once whatever is missing has
 *    had time to be filled in.
 *
 *    That backoff is not politeness, it is the whole correctness of the job.
 *    This scan is bounded and ordered oldest-first, so a case that can never
 *    close used to be re-selected on every run for ever -- and twenty-five of
 *    them at the head of the queue meant the twenty-sixth was never examined
 *    at all, however complete it was. One ward's unfinished paperwork could
 *    silently stop automatic closure for the entire hospital, with nothing
 *    anywhere saying so. This comment previously called that "cheap and
 *    correct"; it was true of one case and false of the queue.
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

const CLOSE_BACKOFF_BASE_MS = 15 * 60 * 1000
const CLOSE_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000

/**
 * How long a case that could not be closed waits before the sweep looks again.
 *
 * Exponential from fifteen minutes to a day. The lower bound is set by what is
 * actually being waited for -- a human finishing the documentation, which does
 * not happen in seconds -- and the upper bound keeps a case that was completed
 * overnight from waiting days for its next look.
 *
 * No jitter, unlike the ingest backoff in Central: these run in one sequential
 * sweep against one database rather than as competing workers, so a thundering
 * herd is not the failure mode here.
 */
export function closeBackoffMs(attemptCount: number): number {
  const attempt = Math.max(1, attemptCount)
  return Math.min(CLOSE_BACKOFF_MAX_MS, CLOSE_BACKOFF_BASE_MS * 2 ** (attempt - 1))
}

/**
 * Records a refused attempt and pushes the case past the next few sweeps.
 *
 * Guarded on the status still being AWAITING_REVIEW: if a client finalised or
 * unfinalised the case between the scan and here, this must not write a
 * backoff onto whatever it has become.
 */
async function deferCase(caseId: string, attemptCount: number, now: Date): Promise<void> {
  await prisma.case.updateMany({
    where: { id: caseId, status: "AWAITING_REVIEW" },
    data: {
      closeAttemptCount: attemptCount + 1,
      closeNextAttemptAt: new Date(now.getTime() + closeBackoffMs(attemptCount + 1)),
    },
  })
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
      // Cases still backing off from a refused attempt are not candidates.
      // This is what lets the scan reach past them; without it the oldest
      // unclosable cases occupy every slot on every run.
      OR: [
        { closeNextAttemptAt: null },
        { closeNextAttemptAt: { lte: now } },
      ],
    },
    select: { id: true, userId: true, status: true, closeAttemptCount: true },
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
      else {
        sweep.blocked += 1
        await deferCase(candidate.id, candidate.closeAttemptCount, now)
      }
    } catch (error) {
      // One case failing must not stop the sweep: the next one may be fine, and
      // this runs unattended.
      sweep.failed += 1
      // Backed off like a blocked one. A case that throws every time -- a
      // relational reconcile that always fails on its data -- would otherwise
      // hold its slot exactly as an incomplete one did.
      await deferCase(candidate.id, candidate.closeAttemptCount, now).catch(() => {})
      const reason = error instanceof CaseFinalizationStepError ? error.step : "transaction"
      console.error("[pending-close] could not close case", candidate.id, reason, error)
    }
  }

  return sweep
}
