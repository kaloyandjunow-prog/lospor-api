import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { caseReadWhereForUser } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"
import { corsHeaders } from "@/lib/cors"

/**
 * Who was on the case, and when (2026-11-23): every joining and leaving of a doctor or a nurse, oldest first. The history is
 * kept for good (the database refuses to change or remove a row), so this answers "who was the nurse at 02:10?" for any case
 * the caller may read. It is read-only; the people are put on and taken off through the case's nurses and transfer routes.
 */
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) })
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders(req) })
  const { id } = await params
  if (!await prisma.case.count({ where: caseReadWhereForUser(user, id) })) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: corsHeaders(req) })
  }
  const rows = await prisma.caseStaffLog.findMany({
    where: { caseId: id },
    orderBy: [{ at: "asc" }, { id: "asc" }],
    include: {
      user: { select: { id: true, name: true, firstName: true, lastName: true, title: true, role: true } },
      by: { select: { id: true, name: true, firstName: true, lastName: true, title: true } },
    },
  })
  return NextResponse.json({
    staff: rows.map(row => ({ id: row.id, kind: row.kind, action: row.action, reason: row.reason, at: row.at, user: row.user, by: row.by })),
  }, { headers: corsHeaders(req) })
}
