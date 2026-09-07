import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { canWriteCaseWithOwnerFallback } from "@/lib/access-control"
import { corsHeaders } from "@/lib/cors"
import { CaseWriteError, withLockedCaseTransaction } from "@/lib/clinical-transaction"
import { logAuditInTransaction } from "@/lib/audit"
import { evaluateCaseReadiness } from "@/lib/case-finalization"

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

/**
 * The clinician's deliberate "I am done with postop" action -- the one path
 * into AWAITING_REVIEW, pressed from the button that takes both web and
 * mobile from the postop form to the case summary.
 *
 * This replaced an automatic promotion that fired the instant a merged postop
 * record looked complete, wherever that happened to occur -- an autosave
 * mid-scoring, not a clinician's decision.
 *
 * It now runs finalize's own gate, via the function finalize itself calls.
 * That was previously claimed and not true: this asked only whether postop
 * was complete, so a case with an empty preoperative assessment could enter
 * AWAITING_REVIEW and start a countdown it could never satisfy.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = user.id
  const { id } = await params

  try {
    const result = await withLockedCaseTransaction(id, async tx => {
      const caseRecord = await tx.case.findUnique({
        where: { id },
        select: { userId: true, status: true, institutionId: true, clinicalMode: true, awaitingReviewAt: true },
      })
      if (!caseRecord) throw new CaseWriteError("CASE_NOT_FOUND", 404, "Not found")
      if (!await canWriteCaseWithOwnerFallback(tx, user, caseRecord)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      if (caseRecord.status === "COMPLETE") {
        return NextResponse.json({ error: "Case is already finalised" }, { status: 409 })
      }
      // Idempotent: revisiting the summary (or a retried request) must not
      // restart the countdown a second time. shouldStampAwaitingReview in
      // ./_patch-status.ts documents the same rule for the PATCH path.
      if (caseRecord.status === "AWAITING_REVIEW") {
        return NextResponse.json({ status: "AWAITING_REVIEW", awaitingReviewAt: caseRecord.awaitingReviewAt })
      }
      if (caseRecord.status !== "IN_PROGRESS") {
        return NextResponse.json(
          { error: "Case must be in progress before it can be submitted for review" },
          { status: 409 },
        )
      }

      // The same question finalize asks, asked of the same record -- not an
      // approximation of it. Checking postop alone let a case with an empty
      // preoperative assessment and no intraoperative record start the
      // thirty-minute countdown and then be refused by the check that
      // countdown exists to run.
      const readiness = await evaluateCaseReadiness(tx, id)
      if (!readiness.valid) {
        const blockers = readiness.issues.filter(issue => issue.severity === "error")
        return NextResponse.json({
          error: "Cannot submit for review: this case is not complete enough to close",
          blockers: blockers.map(issue => ({ code: issue.code, path: issue.path })),
        }, { status: 422 })
      }

      const awaitingReviewAt = new Date()
      await tx.case.update({
        where: { id },
        data: {
          status: "AWAITING_REVIEW",
          awaitingReviewAt,
          // A fresh submission is a fresh answer to the question the sweep
          // asks, so any backoff from a previously refused close is cleared --
          // otherwise a case that was fixed and resubmitted would still sit
          // out the wait its incomplete version earned.
          closeAttemptCount: 0,
          closeNextAttemptAt: null,
        },
      })
      await logAuditInTransaction(tx, userId, "CASE_SUBMITTED_FOR_REVIEW", id, {
        from: caseRecord.status,
        to: "AWAITING_REVIEW",
      })

      return { awaitingReviewAt }
    })

    if (result instanceof Response) return result
    return NextResponse.json({ status: "AWAITING_REVIEW", awaitingReviewAt: result.awaitingReviewAt })
  } catch (error: unknown) {
    if (error instanceof CaseWriteError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error("[submit-for-review] transaction failed", id, error)
    return NextResponse.json({ error: "Failed to submit for review. Case status unchanged." }, { status: 500 })
  }
}
