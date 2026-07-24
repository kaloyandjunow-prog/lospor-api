import { NextRequest, NextResponse, after } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"
import { writeSnapshotAsync } from "@/lib/case-audit"
import { syncCaseRelational } from "@/lib/relational-sync"
import { canAccessCase } from "@/lib/access-control"
import { corsHeaders } from "@/lib/cors"
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

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = user.id

  const { id } = await params

  const c = await prisma.case.findUnique({
    where: { id },
    select: {
      userId: true,
      status: true,
      user:   { select: { institutionId: true } },
      preop:  { select: { id: true } },
      intraop: {
        select: {
          id: true,
          startTime: true,
          endTime: true,
          techniques: true,
        },
      },
      postop: {
        select: {
          aldreteActivity:      true,
          aldreteRespiration:   true,
          aldreteCirculation:   true,
          aldreteConsciousness: true,
          aldreteSpO2:          true,
          disposition:          true,
        },
      },
    },
  })

  if (!c) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (!canAccessCase(user, c)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (c.status === "COMPLETE") return NextResponse.json({ error: "Case is already finalised" }, { status: 409 })

  const readiness = evaluateCaseFinalization({
    preop: c.preop,
    intraop: c.intraop,
    postop: c.postop,
  })
  if (!readiness.valid) {
    const blocker = readiness.issues.find(issue => issue.severity === "error")!
    return NextResponse.json({
      error: FINALIZATION_ERRORS[blocker.code] ?? "Cannot finalise: required clinical documentation is incomplete",
      reason: blocker.code,
    }, { status: 422 })
  }

  // Reconcile the relational mirror before locking the case, so the snapshot
  // and any subsequent OMOP export agree with the queryable rows.
  try {
    await syncCaseRelational(prisma, id)
  } catch (err) {
    console.error("[finalize] relational sync failed", id, err)
    return NextResponse.json({ error: "Failed to reconcile relational clinical rows. Case status unchanged." }, { status: 500 })
  }

  // Write the immutable snapshot first (upsert = idempotent). If this throws,
  // the case status is not changed — caller can retry.
  try {
    await writeSnapshotAsync(prisma, id)
  } catch (err) {
    console.error("[finalize] snapshot failed", id, err)
    return NextResponse.json({ error: "Failed to write finalization snapshot. Case status unchanged." }, { status: 500 })
  }

  // Commit the status change only after the snapshot is safely written.
  const finalizedAt = new Date()
  await prisma.case.update({
    where: { id },
    data: { status: "COMPLETE", finalizedAt },
  })

  after(() => logAudit(userId, "CASE_FINALIZED", id, { from: c.status, to: "COMPLETE" }))

  return NextResponse.json({ id, status: "COMPLETE", finalizedAt })
}
