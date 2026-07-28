import { NextRequest, NextResponse, after } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { logAudit } from "@/lib/audit"
import { writeSnapshotAsync } from "@/lib/case-audit"
import { syncCaseRelational } from "@/lib/relational-sync"
import { canAccessCaseWithOwnerFallback } from "@/lib/access-control"
import { corsHeaders } from "@/lib/cors"
import { CaseWriteError, withLockedCaseTransaction } from "@/lib/clinical-transaction"
import {
  evaluateCaseFinalization,
  type ClinicalIssueCode,
} from "@lospor/core/clinical-validation"

const CORS = (req: NextRequest) => corsHeaders(req)

const FINALIZATION_ERRORS: Partial<Record<ClinicalIssueCode, string>> = {
  missing_preop: "Cannot finalise: preoperative assessment is missing",
  missing_intraop: "Cannot finalise: intraoperative record has not been started",
  missing_start_time: "Cannot finalise: intraoperative start time is missing",
  missing_end_time: "Cannot finalise: intraoperative end time is missing",
  missing_technique: "Cannot finalise: at least one anaesthesia technique must be recorded",
  invalid_intraop_times: "Cannot finalise: intraop end time must be after start time",
  missing_postop: "Cannot finalise: postoperative record is missing",
  missing_aldrete: "Cannot finalise: at least one Aldrete subscore must be recorded",
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
        select: { userId: true, status: true, institutionId: true },
      })
      if (!caseRecord) throw new CaseWriteError("CASE_NOT_FOUND", 404, "Not found")
      if (!await canAccessCaseWithOwnerFallback(tx, user, caseRecord)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      if (caseRecord.status === "COMPLETE") {
        return NextResponse.json({ error: "Case is already finalised" }, { status: 409 })
      }

      const preop = await tx.preoperativeAssessment.findUnique({
        where: { caseId: id },
        select: { id: true },
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
        const blocker = readiness.issues.find(issue => issue.severity === "error")!
        return NextResponse.json({
          error: FINALIZATION_ERRORS[blocker.code] ?? "Cannot finalise: required clinical documentation is incomplete",
          reason: blocker.code,
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
        await writeSnapshotAsync(tx, id)
      } catch (error) {
        console.error("[finalize] snapshot failed", id, error)
        throw new FinalizeResponse(NextResponse.json(
          { error: "Failed to write finalization snapshot. Case status unchanged." },
          { status: 500 },
        ))
      }

      return { from: caseRecord.status, finalizedAt }
    })

    if (result instanceof Response) return result
    after(() => logAudit(userId, "CASE_FINALIZED", id, { from: result.from, to: "COMPLETE" }))
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
