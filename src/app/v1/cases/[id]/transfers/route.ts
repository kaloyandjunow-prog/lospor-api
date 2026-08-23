import { NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/cors"
import { getAuthUser } from "@/lib/mobile-auth"
import { caseReadWhereForUser } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"

const CORS = (req: NextRequest) => corsHeaders(req, "GET, OPTIONS")

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

/**
 * Who has held this case, and who moved it.
 *
 * The audit log records every one of these, but only an administrator can read
 * it and only as a flat table filtered by action — which answers a compliance
 * question, not a clinical one. The people who need this are the clinicians on
 * the case: weeks later, asked why a record is in their name, "accepted from Dr
 * X on the 14th" is the answer, and it should not require asking an admin to
 * run a query.
 *
 * Read from CaseTransfer rather than AuditLog because it is the structured
 * record of the same events: both parties, the outcome, and the code the case
 * carried before it moved. previousCaseCode is the one that matters on paper —
 * a printed sheet carrying the old number is how a chart stops matching its
 * record.
 *
 * Visibility follows the case. Anyone who may open the case may see how it got
 * to them; anyone who may not gets 404, the same answer as a case that does not
 * exist.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: caseId } = await params
  const caseRecord = await prisma.case.findFirst({
    where: caseReadWhereForUser(user, caseId),
    select: { id: true },
  })
  if (!caseRecord) return NextResponse.json({ error: "Case not found" }, { status: 404 })

  const transfers = await prisma.caseTransfer.findMany({
    where: { caseId },
    select: {
      id: true,
      status: true,
      createdAt: true,
      resolvedAt: true,
      previousCaseCode: true,
      initiatedBy: true,
      fromUser: { select: { id: true, name: true, title: true } },
      toUser: { select: { id: true, name: true, title: true } },
    },
    // Oldest first: this is read as a history, and a history runs forwards.
    orderBy: { createdAt: "asc" },
  })

  return NextResponse.json(transfers)
}
