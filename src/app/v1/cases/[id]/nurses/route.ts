import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { corsHeaders } from "@/lib/cors"
import { getAuthUser } from "@/lib/mobile-auth"
import { caseReadWhereForUser, caseWriteWhereForUser } from "@/lib/access-control"
import { logAuditInTransaction } from "@/lib/audit"
import { isNurse, refuseIfNotAllowed } from "@/lib/nurse-access"
import { prisma } from "@/lib/prisma"

/**
 * The anaesthesia nurses of a case (10.8.0), any number. The case's doctor, a
 * head of department or an administrator assigns and removes them; a nurse
 * hands her place over to another nurse (POST with handoverTo).
 */
const bodySchema = z.union([
  z.object({ assign: z.string().min(1).max(64) }).strict(),
  z.object({ remove: z.string().min(1).max(64) }).strict(),
  z.object({ handoverTo: z.string().min(1).max(64) }).strict(),
])

const NURSE_USER = { select: { id: true, name: true, firstName: true, lastName: true, title: true } } as const

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) })
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  if (!await prisma.case.count({ where: caseReadWhereForUser(user, id) })) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const nurses = await prisma.caseNurse.findMany({ where: { caseId: id }, orderBy: { assignedAt: "asc" }, include: { user: NURSE_USER } })
  return NextResponse.json({ nurses: nurses.map(row => ({ userId: row.userId, source: row.source, assignedAt: row.assignedAt, user: row.user })) }, { headers: corsHeaders(req) })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "assign, remove or handoverTo required" }, { status: 400 })
  const body = parsed.data
  const refusal = "handoverTo" in body ? refuseIfNotAllowed(user, "HAND_OVER_TO_NURSE") : refuseIfNotAllowed(user, "ASSIGN_NURSES")
  if (refusal) return refusal

  const caseRecord = await prisma.case.findFirst({ where: caseWriteWhereForUser(user, id), select: { id: true, status: true, institutionId: true } })
  if (!caseRecord) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (caseRecord.status === "COMPLETE" || caseRecord.status === "CANCELLED") return NextResponse.json({ error: "Case is closed" }, { status: 409 })

  const targetId = "assign" in body ? body.assign : "remove" in body ? body.remove : body.handoverTo
  if (!("remove" in body)) {
    const target = await prisma.user.findFirst({
      where: { id: targetId, role: "ANAESTHESIA_NURSE", activatedAt: { not: null }, suspendedAt: null, deletedAt: null, anonymizedAt: null, ...(caseRecord.institutionId ? { institutionId: caseRecord.institutionId } : {}) },
      select: { id: true },
    })
    if (!target) return NextResponse.json({ error: "Not an anaesthesia nurse of this department", code: "NOT_A_NURSE" }, { status: 400 })
  }

  await prisma.$transaction(async tx => {
    if ("assign" in body) {
      await tx.caseNurse.upsert({ where: { caseId_userId: { caseId: id, userId: body.assign } }, create: { caseId: id, userId: body.assign, assignedById: user.id, source: "ASSIGNED" }, update: {} })
      await logAuditInTransaction(tx, user.id, "CASE_NURSE_ASSIGN", id, { nurse: body.assign })
    } else if ("remove" in body) {
      await tx.caseNurse.deleteMany({ where: { caseId: id, userId: body.remove } })
      await logAuditInTransaction(tx, user.id, "CASE_NURSE_REMOVE", id, { nurse: body.remove })
    } else {
      if (!isNurse(user)) return
      await tx.caseNurse.deleteMany({ where: { caseId: id, userId: user.id } })
      await tx.caseNurse.upsert({ where: { caseId_userId: { caseId: id, userId: body.handoverTo } }, create: { caseId: id, userId: body.handoverTo, assignedById: user.id, source: "HANDOVER" }, update: {} })
      await logAuditInTransaction(tx, user.id, "CASE_NURSE_HANDOVER", id, { to: body.handoverTo })
    }
  })
  const nurses = await prisma.caseNurse.findMany({ where: { caseId: id }, orderBy: { assignedAt: "asc" }, include: { user: NURSE_USER } })
  return NextResponse.json({ nurses: nurses.map(row => ({ userId: row.userId, source: row.source, assignedAt: row.assignedAt, user: row.user })) }, { headers: corsHeaders(req) })
}
