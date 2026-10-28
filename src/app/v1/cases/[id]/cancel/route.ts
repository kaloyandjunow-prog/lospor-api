import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { corsHeaders } from "@/lib/cors"
import { getAuthUser } from "@/lib/mobile-auth"
import { caseWriteWhereForUser } from "@/lib/access-control"
import { logAuditInTransaction } from "@/lib/audit"
import { CaseWriteError, withLockedCaseTransaction } from "@/lib/clinical-transaction"
import { cancellationAllowed, isCancellationReason, MAX_CANCELLATION_NOTE_LENGTH } from "@lospor/core/case-cancellation"

/**
 * A cancelled procedure (10.0.0). POST cancels: until the anaesthesia start is
 * set, by those who can edit the case, with a reason. Everything recorded is
 * kept; the case is closed to editing and exported with its cancellation.
 * DELETE undoes it, returning the case to the status it had.
 */
const cancelSchema = z.object({
  reason: z.string().refine(isCancellationReason),
  note: z.string().trim().max(MAX_CANCELLATION_NOTE_LENGTH).optional(),
}).strict()

class CancelRefused extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code)
  }
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) })
}

function refused(req: NextRequest, error: unknown, caseId: string) {
  if (error instanceof CancelRefused) return NextResponse.json({ error: error.code, code: error.code }, { status: error.status, headers: corsHeaders(req) })
  if (error instanceof CaseWriteError) return NextResponse.json({ error: error.message }, { status: error.status, headers: corsHeaders(req) })
  console.error("[case cancel]", caseId, error)
  return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: corsHeaders(req) })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id: caseId } = await params
  const parsed = cancelSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "CANCELLATION_REASON_REQUIRED", code: "CANCELLATION_REASON_REQUIRED" }, { status: 400, headers: corsHeaders(req) })
  // "Other" needs a few words saying what; any other reason may have them.
  const note = parsed.data.note || null
  if (parsed.data.reason === "OTHER" && !note) {
    return NextResponse.json({ error: "CANCELLATION_NOTE_REQUIRED", code: "CANCELLATION_NOTE_REQUIRED" }, { status: 400, headers: corsHeaders(req) })
  }
  try {
    const result = await withLockedCaseTransaction(caseId, async tx => {
      const record = await tx.case.findFirst({
        where: caseWriteWhereForUser(user, caseId),
        select: { status: true, intraop: { select: { startedAt: true, startTime: true } } },
      })
      if (!record) throw new CancelRefused("CASE_NOT_FOUND", 404)
      if (!cancellationAllowed(record)) {
        throw new CancelRefused(record.status === "CANCELLED" ? "CASE_ALREADY_CANCELLED" : "CANCELLATION_TOO_LATE", 409)
      }
      const cancelledAt = new Date()
      await tx.case.update({
        where: { id: caseId },
        data: { status: "CANCELLED", statusBeforeCancel: record.status, cancelledAt, cancelledById: user.id, cancellationReason: parsed.data.reason, cancellationNote: note },
      })
      // Nothing else on the case changes: what was recorded stays.
      await logAuditInTransaction(tx, user.id, "CASE_CANCEL", caseId, { reason: parsed.data.reason, from: record.status })
      return { status: "CANCELLED", cancelledAt: cancelledAt.toISOString(), cancellationReason: parsed.data.reason }
    })
    return NextResponse.json(result, { headers: corsHeaders(req) })
  } catch (error) {
    return refused(req, error, caseId)
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id: caseId } = await params
  try {
    const result = await withLockedCaseTransaction(caseId, async tx => {
      const record = await tx.case.findFirst({
        where: caseWriteWhereForUser(user, caseId),
        select: { status: true, statusBeforeCancel: true, cancellationReason: true },
      })
      if (!record) throw new CancelRefused("CASE_NOT_FOUND", 404)
      if (record.status !== "CANCELLED") throw new CancelRefused("CASE_NOT_CANCELLED", 409)
      const status = record.statusBeforeCancel && record.statusBeforeCancel !== "CANCELLED" ? record.statusBeforeCancel : "DRAFT"
      await tx.case.update({
        where: { id: caseId },
        data: { status, statusBeforeCancel: null, cancelledAt: null, cancelledById: null, cancellationReason: null, cancellationNote: null },
      })
      await logAuditInTransaction(tx, user.id, "CASE_CANCEL_UNDO", caseId, { reason: record.cancellationReason, to: status })
      return { status }
    })
    return NextResponse.json(result, { headers: corsHeaders(req) })
  } catch (error) {
    return refused(req, error, caseId)
  }
}
