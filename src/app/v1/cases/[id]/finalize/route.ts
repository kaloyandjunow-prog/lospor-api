import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { canWriteCaseWithOwnerFallback } from "@/lib/access-control"
import { corsHeaders } from "@/lib/cors"
import { CaseWriteError, withLockedCaseTransaction } from "@/lib/clinical-transaction"
import { pediatricMutationResponse } from "@/lib/pediatric-http"
import {
  CaseFinalizationStepError,
  finalizeCaseWithinTransaction,
} from "@/lib/case-finalization"
import type { ClinicalIssueCode } from "@lospor/core/clinical-validation"

const CORS = (req: NextRequest) => corsHeaders(req)

const FINALIZATION_ERRORS: Partial<Record<ClinicalIssueCode, string>> = {
  missing_preop: "Cannot finalise: preoperative assessment is missing",
  incomplete_preop: "Cannot finalise: the preoperative assessment is incomplete",
  missing_intraop: "Cannot finalise: intraoperative record has not been started",
  missing_start_time: "Cannot finalise: intraoperative start time is missing",
  missing_end_time: "Cannot finalise: intraoperative end time is missing",
  missing_technique: "Cannot finalise: at least one anaesthesia technique must be recorded",
  invalid_intraop_times: "Cannot finalise: intraop end time must be after start time",
  missing_postop: "Cannot finalise: postoperative record is missing",
  missing_aldrete: "Cannot finalise: every Aldrete component must be recorded",
  missing_disposition: "Cannot finalise: patient disposition (Ward/PACU/ICU) must be recorded",
}

class FinalizeResponse extends Error {
  constructor(readonly response: NextResponse) {
    super("FINALIZE_RESPONSE")
  }
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = user.id
  const { id } = await params

  try {
    const result = await withLockedCaseTransaction(id, async tx => {
      const caseRecord = await tx.case.findUnique({
        where: { id },
        select: { userId: true, status: true, institutionId: true, clinicalMode: true },
      })
      if (!caseRecord) throw new CaseWriteError("CASE_NOT_FOUND", 404, "Not found")
      if (!await canWriteCaseWithOwnerFallback(tx, user, caseRecord)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      if (caseRecord.status === "COMPLETE") {
        return NextResponse.json({ error: "Case is already finalised" }, { status: 409 })
      }
      const pediatricBlock = pediatricMutationResponse(req, caseRecord.clinicalMode)
      if (pediatricBlock) return pediatricBlock

      // The readiness gate, relational reconcile, snapshot and audit row live
      // in @/lib/case-finalization, shared with the sweep that closes a case
      // whose review window elapsed -- the two must not be able to drift.
      let outcome
      try {
        outcome = await finalizeCaseWithinTransaction(tx, id, userId, {
          currentStatus: caseRecord.status,
        })
      } catch (error) {
        if (error instanceof CaseFinalizationStepError) {
          console.error(`[finalize] ${error.step} failed`, id, error.cause)
          throw new FinalizeResponse(NextResponse.json(
            {
              error: error.step === "snapshot"
                ? "Failed to write finalization snapshot. Case status unchanged."
                : "Failed to reconcile relational clinical rows. Case status unchanged.",
            },
            { status: 500 },
          ))
        }
        throw error
      }

      if (!outcome.ok) {
        const blocker = outcome.blockers[0]!
        return NextResponse.json({
          error: FINALIZATION_ERRORS[blocker.code] ?? "Cannot finalise: required clinical documentation is incomplete",
          reason: blocker.code,
          // Every blocker, not just the first. An incomplete preoperative
          // assessment usually has several gaps, and reporting them one at a
          // time makes finalising a guessing game. `error` and `reason` keep
          // their existing meaning for clients that only read those.
          blockers: outcome.blockers.map(item => ({ code: item.code, path: item.path })),
        }, { status: 422 })
      }

      return { from: outcome.from, finalizedAt: outcome.finalizedAt }
    })

    if (result instanceof Response) return result
    return NextResponse.json({ id, status: "COMPLETE", finalizedAt: result.finalizedAt })
  } catch (error: unknown) {
    if (error instanceof FinalizeResponse) return error.response
    if (error instanceof CaseWriteError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error("[finalize] transaction failed", id, error)
    return NextResponse.json({ error: "Failed to finalise case. Case status unchanged." }, { status: 500 })
  }
}
