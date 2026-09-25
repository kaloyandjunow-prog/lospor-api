import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { canReadCase, canWriteCaseWithOwnerFallback } from "@/lib/access-control"
import { CaseWriteError, isCaseFinalizedDatabaseError, withLockedCaseTransaction } from "@/lib/clinical-transaction"
import { prisma } from "@/lib/prisma"
import { generatePreopSuggestions } from "@/lib/preop/suggestions"
import { preparePreopProfile } from "@/lib/preop/service"

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const record = await prisma.case.findUnique({
    where: { id },
    select: { userId: true, createdById: true, institutionId: true, preop: { select: { id: true } } },
  })
  if (!record || !canReadCase(user, record)) return NextResponse.json({ error: "Not found" }, { status: 404 })
  // No assessment, no suggestions. `preopId: undefined` is not a filter to
  // Prisma -- it is the absence of one, and returned every case's suggestions.
  if (!record.preop) return NextResponse.json([])
  const suggestions = await prisma.preopAssessmentSuggestion.findMany({
    where: { preopId: record.preop.id },
    orderBy: { createdAt: "desc" },
    include: { question: { select: { stableKey: true, labelEn: true, labelBg: true } }, linkedDiagnosis: true },
  })
  return NextResponse.json(suggestions)
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  try {
    await preparePreopProfile(prisma, user.id)
    const result = await withLockedCaseTransaction(id, async tx => {
      const record = await tx.case.findUnique({
        where: { id },
        select: { userId: true, createdById: true, institutionId: true, status: true, preop: { select: { id: true } } },
      })
      if (!record) return null
      if (record.status === "COMPLETE") return "FROZEN" as const
      if (!await canWriteCaseWithOwnerFallback(tx, user, record)) return "FORBIDDEN" as const
      if (!record.preop) return "NO_PREOP" as const
      return generatePreopSuggestions(tx, { caseId: id, preopId: record.preop.id, actorId: user.id })
    })
    if (result === null) return NextResponse.json({ error: "Not found" }, { status: 404 })
    if (result === "FROZEN") return NextResponse.json({ error: "Case is finalised" }, { status: 403 })
    if (result === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    if (result === "NO_PREOP") return NextResponse.json({ error: "Preoperative assessment missing" }, { status: 409 })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof CaseWriteError) return NextResponse.json({ error: error.message }, { status: error.status })
    if (isCaseFinalizedDatabaseError(error)) return NextResponse.json({ error: "Case is finalised" }, { status: 403 })
    return NextResponse.json({ error: "Suggestion generation failed" }, { status: 500 })
  }
}
