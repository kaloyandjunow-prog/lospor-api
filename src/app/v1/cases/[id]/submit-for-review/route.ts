import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { canWriteCaseWithOwnerFallback } from "@/lib/access-control"
import { corsHeaders } from "@/lib/cors"
import { CaseWriteError, withLockedCaseTransaction } from "@/lib/clinical-transaction"
import { logAuditInTransaction } from "@/lib/audit"
import { evaluatePostopReadiness } from "@lospor/core/clinical-validation"

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

/**
 * The clinician's deliberate "I am done with postop" action -- the one path
 * into AWAITING_REVIEW, pressed from the button that takes both web and
 * mobile from the postop form to the case summary.
 *
 * This replaced an automatic promotion that fired the instant a merged
 * postop record satisfied `evaluatePostopReadiness`, wherever that completion
 * happened to occur -- an autosave mid-scoring, not a clinician's decision.
 * The check itself is unchanged and still the same one finalize() applies;
 * only when it runs has moved, from "on every postop write" to "when asked".
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

      const postop = await tx.postoperativeRecord.findUnique({ where: { caseId: id } })
      const readiness = evaluatePostopReadiness(postop)
      if (!readiness.valid) {
        return NextResponse.json({
          error: "Cannot submit for review: postoperative documentation is incomplete",
          blockers: readiness.issues.map(issue => ({ code: issue.code, path: issue.path })),
        }, { status: 422 })
      }

      const awaitingReviewAt = new Date()
      await tx.case.update({
        where: { id },
        data: { status: "AWAITING_REVIEW", awaitingReviewAt },
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
