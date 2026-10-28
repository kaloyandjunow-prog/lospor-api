import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { corsHeaders } from "@/lib/cors"
import { getAuthUser } from "@/lib/mobile-auth"
import { caseReadWhereForUser } from "@/lib/access-control"
import { logAuditInTransaction } from "@/lib/audit"
import { CaseWriteError, withLockedCaseTransaction } from "@/lib/clinical-transaction"
import { assignCaseTheatre, OperatingTheatreError } from "@/lib/operating-theatres"

// Assigns a case's operating theatre, or clears it (10.0.0). Anyone who can
// open the case may, until intraop starts; the server holds that line, so web
// and phone cannot drift.
// expectedTheatreId: the theatre the clinician saw (null for none). If the case
// has another by now, the change is refused rather than silently overwriting it.
const bodySchema = z.object({
  theatreId: z.string().min(1).max(64).nullable(),
  expectedTheatreId: z.string().min(1).max(64).nullable().optional(),
}).strict()

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id: caseId } = await params
  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "theatreId required" }, { status: 400 })

  try {
    const result = await withLockedCaseTransaction(caseId, async tx => {
      const visible = await tx.case.count({ where: caseReadWhereForUser(user, caseId) })
      if (!visible) throw new OperatingTheatreError("CASE_NOT_FOUND", 404)
      const change = await assignCaseTheatre(tx, caseId, parsed.data.theatreId, parsed.data.expectedTheatreId)
      if (change.before !== change.after) {
        await logAuditInTransaction(tx, user.id, "CASE_THEATRE_ASSIGN", caseId, { from: change.before, to: change.after })
      }
      return change
    })
    return NextResponse.json({ theatreId: result.after }, { headers: corsHeaders(req) })
  } catch (error) {
    if (error instanceof OperatingTheatreError) return NextResponse.json({ error: error.code, code: error.code, ...error.details }, { status: error.status, headers: corsHeaders(req) })
    if (error instanceof CaseWriteError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error("[case theatre]", caseId, error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
