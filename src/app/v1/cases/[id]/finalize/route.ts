import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { logAuditInTransaction } from "@/lib/audit"
import { writeSnapshotAsync } from "@/lib/case-audit"
import { syncCaseRelational } from "@/lib/relational-sync"
import { canAccessCaseWithOwnerFallback } from "@/lib/access-control"
import { corsHeaders } from "@/lib/cors"
import { CaseWriteError, withLockedCaseTransaction } from "@/lib/clinical-transaction"
import { pediatricMutationResponse } from "@/lib/pediatric-http"
import {
  evaluateCaseFinalization,
  type ClinicalIssueCode,
} from "@lospor/core/clinical-validation"

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
      if (!await canAccessCaseWithOwnerFallback(tx, user, caseRecord)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      if (caseRecord.status === "COMPLETE") {
        return NextResponse.json({ error: "Case is already finalised" }, { status: 409 })
      }
      const pediatricBlock = pediatricMutationResponse(req, caseRecord.clinicalMode)
      if (pediatricBlock) return pediatricBlock

      // The whole record, deliberately. This selected only `id`, so the
      // readiness check could confirm the row existed and nothing more, and a
      // partial draft finalised through the API. Enumerating the fields the
      // validator happens to read today would drift the moment core changes
      // what "complete" means.
      const preop = await tx.preoperativeAssessment.findUnique({
        where: { caseId: id },
      })
      const intraop = await tx.intraoperativeRecord.findUnique({
        where: { caseId: id },
        select: {
          id: true,
          startedAt: true,
          endedAt: true,
          startTime: true,
          endTime: true,
          techniques: true,
        },
      })
      const postop = await tx.postoperativeRecord.findUnique({
        where: { caseId: id },
        select: {
          aldreteActivity: true,
          aldreteRespiration: true,
          aldreteCirculation: true,
          aldreteConsciousness: true,
          aldreteSpO2: true,
          disposition: true,
        },
      })
      const readiness = evaluateCaseFinalization({ preop, intraop, postop })
      if (!readiness.valid) {
        const blockers = readiness.issues.filter(issue => issue.severity === "error")
        const blocker = blockers[0]!
        return NextResponse.json({
          error: FINALIZATION_ERRORS[blocker.code] ?? "Cannot finalise: required clinical documentation is incomplete",
          reason: blocker.code,
          // Every blocker, not just the first. An incomplete preoperative
          // assessment usually has several gaps, and reporting them one at a
          // time makes finalising a guessing game. `error` and `reason` keep
          // their existing meaning for clients that only read those.
          blockers: blockers.map(item => ({ code: item.code, path: item.path })),
        }, { status: 422 })
      }

      try {
        await syncCaseRelational(tx, id)
      } catch (error) {
        console.error("[finalize] relational sync failed", id, error)
        throw new FinalizeResponse(NextResponse.json(
          { error: "Failed to reconcile relational clinical rows. Case status unchanged." },
          { status: 500 },
        ))
      }

      const finalizedAt = new Date()
      await tx.case.update({
        where: { id },
        data: { status: "COMPLETE", finalizedAt },
      })

      try {
        // The snapshot is written after the COMPLETE transition so it contains
        // the exact lifecycle state and revisions committed by this transaction.
        await writeSnapshotAsync(tx, id, userId)
      } catch (error) {
        console.error("[finalize] snapshot failed", id, error)
        throw new FinalizeResponse(NextResponse.json(
          { error: "Failed to write finalization snapshot. Case status unchanged." },
          { status: 500 },
        ))
      }

      // In the transaction, not after the response. Finalization is an
      // attestation; a commit with no record of who made it is the failure
      // this endpoint exists to prevent.
      await logAuditInTransaction(tx, userId, "CASE_FINALIZED", id, {
        from: caseRecord.status, to: "COMPLETE",
      })
      return { from: caseRecord.status, finalizedAt }
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
