import type { CaseStatus } from "@/generated/prisma/enums"

/**
 * Where a case's status goes after this PATCH, or undefined to leave it alone.
 *
 * Status is monotonic: an explicit status in the payload is honoured, intraop
 * data promotes a DRAFT, and nothing here may ever move a case backwards.
 * COMPLETE is reachable only through POST /v1/cases/:id/finalize, which is why
 * it is absent from the request schema rather than merely rejected here.
 * AWAITING_REVIEW is the same shape of thing, for the same reason:
 * POST /v1/cases/:id/submit-for-review is the only path into it, and it is
 * absent from *this* schema too.
 *
 * DO NOT add postop completeness back into this function (e.g. `postopReady`,
 * `!!postop`, `hasPostop`). This used to auto-promote IN_PROGRESS to
 * AWAITING_REVIEW the instant a merged postop record satisfied
 * evaluatePostopReadiness -- which meant the countdown started on whichever
 * autosave happened to fill in the last field, not on the clinician saying
 * they were done. submit-for-review runs the identical readiness check, but
 * only when the clinician has actually pressed the button that takes them to
 * the case summary -- see its route for the one place that check now lives.
 */

const STATUS_ORDER: Record<string, number> = {
  DRAFT: 0,
  IN_PROGRESS: 1,
  AWAITING_REVIEW: 2,
  COMPLETE: 3,
}

export function computeNextStatus(input: {
  currentStatus: string
  /** An explicit status from the request body, if the client sent one. */
  requestedStatus?: CaseStatus
  /** True when this request writes intraop data carrying a start time. */
  intraopStarted: boolean
}): CaseStatus | undefined {
  let next: CaseStatus | undefined
  if (input.requestedStatus !== undefined) {
    next = input.requestedStatus
  } else if (input.intraopStarted && input.currentStatus === "DRAFT") {
    next = "IN_PROGRESS"
  }
  if (next && STATUS_ORDER[next] !== undefined && STATUS_ORDER[input.currentStatus] !== undefined) {
    if (STATUS_ORDER[next] < STATUS_ORDER[input.currentStatus]) next = undefined
  }
  return next
}

/**
 * `awaitingReviewAt` is set once, on the genuine transition into
 * AWAITING_REVIEW, and never touched by a later edit that leaves the case
 * there -- it is the one server timestamp the pending-close countdown anchors
 * to, and every client must compute the same remaining time from it.
 */
export function shouldStampAwaitingReview(
  currentStatus: string,
  nextStatus: CaseStatus | undefined,
): boolean {
  return nextStatus === "AWAITING_REVIEW" && currentStatus !== "AWAITING_REVIEW"
}
