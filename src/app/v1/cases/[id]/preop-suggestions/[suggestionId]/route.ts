import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { getAuthUser } from "@/lib/mobile-auth"
import { canWriteCaseWithOwnerFallback } from "@/lib/access-control"
import { CaseWriteError, isCaseFinalizedDatabaseError, withLockedCaseTransaction } from "@/lib/clinical-transaction"
import { reviewPreopSuggestion } from "@/lib/preop/suggestions"

const bodySchema = z.object({ status: z.enum(["ACCEPTED", "REJECTED"]) })

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string, suggestionId: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id, suggestionId } = await params
  try {
    const body = bodySchema.parse(await req.json())
    // Accepting a suggestion writes an answer, so it takes the same case lock
    // as any other clinical write: it serialises with the clinician's saves and
    // with finalization, and the database guard refuses it once the case is
    // closed.
    const result = await withLockedCaseTransaction(id, async tx => {
      const record = await tx.case.findUnique({ where: { id }, select: { userId: true, createdById: true, institutionId: true, status: true } })
      if (!record) return null
      if (record.status === "COMPLETE") return "FROZEN" as const
      if (!await canWriteCaseWithOwnerFallback(tx, user, record)) return "FORBIDDEN" as const
      return reviewPreopSuggestion(tx, { caseId: id, suggestionId, reviewerId: user.id, status: body.status })
    })
    if (result === null) return NextResponse.json({ error: "Not found" }, { status: 404 })
    if (result === "FROZEN") return NextResponse.json({ error: "Case is finalised" }, { status: 403 })
    if (result === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid request", issues: error.issues }, { status: 400 })
    if (error instanceof CaseWriteError) return NextResponse.json({ error: error.message }, { status: error.status })
    if (isCaseFinalizedDatabaseError(error)) return NextResponse.json({ error: "Case is finalised" }, { status: 403 })
    if (error instanceof Error && error.message === "PREOP_SUGGESTION_NOT_FOUND") return NextResponse.json({ error: "Suggestion not found" }, { status: 404 })
    return NextResponse.json({ error: "Suggestion review failed" }, { status: 500 })
  }
}
