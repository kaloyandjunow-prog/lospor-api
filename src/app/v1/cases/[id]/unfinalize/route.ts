import { NextRequest, NextResponse, after } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { logAudit } from "@/lib/audit"
import { canAccessCaseWithOwnerFallback } from "@/lib/access-control"
import { corsHeaders } from "@/lib/cors"
import { FINALIZE_UNDO_WINDOW_MS } from "@/lib/constants"
import { CaseWriteError, withLockedCaseTransaction } from "@/lib/clinical-transaction"

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

// POST — undo finalization within the shared FINALIZE_UNDO_WINDOW_MS window
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params

  try {
    const result = await withLockedCaseTransaction(id, async tx => {
      const caseRecord = await tx.case.findUnique({
        where: { id },
        select: {
          userId: true,
          status: true,
          finalizedAt: true,
          institutionId: true,
        },
      })
      if (!caseRecord) throw new CaseWriteError("CASE_NOT_FOUND", 404, "Not found")

      if (!await canAccessCaseWithOwnerFallback(tx, user, caseRecord)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
      if (caseRecord.status !== "COMPLETE") {
        return NextResponse.json({ error: "Case is not finalized" }, { status: 400 })
      }
      if (!caseRecord.finalizedAt || Date.now() - caseRecord.finalizedAt.getTime() >= FINALIZE_UNDO_WINDOW_MS) {
        return NextResponse.json({ error: "Undo window expired" }, { status: 403 })
      }

      return tx.case.update({
        where: { id },
        data: { status: "IN_PROGRESS", finalizedAt: null },
      })
    })

    if (result instanceof Response) return result
    after(() => logAudit(user.id, "CASE_UNFINALIZED", id, { by: user.id }))
    return NextResponse.json(result)
  } catch (error: unknown) {
    if (error instanceof CaseWriteError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    console.error("[unfinalize] transaction failed", id, error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
