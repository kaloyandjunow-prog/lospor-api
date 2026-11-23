import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { corsHeaders } from "@/lib/cors"
import { getAuthUser } from "@/lib/mobile-auth"
import { caseReadWhereForUser, caseWriteWhereForUser } from "@/lib/access-control"
import { logAuditInTransaction } from "@/lib/audit"
import { NURSE_ACCOUNT_ROLES, mayAssignNurses, mayTakeCase } from "@lospor/core/clinical-roles"
import { refuseIfNotAllowed } from "@/lib/nurse-access"
import { prisma } from "@/lib/prisma"

/**
 * The anaesthesia nurses of a case (10.8.0), any number. The head of department and the administrator assign and remove them
 * on any case of their hospital, a doctor on her own cases, a senior nurse on any case of her hospital (Core mayAssignNurses);
 * a nurse hands her place over to another nurse (handoverTo) and may put herself on a case that has no nurse (take).
 */
const bodySchema = z.union([
  z.object({ assign: z.string().min(1).max(64) }).strict(),
  z.object({ remove: z.string().min(1).max(64) }).strict(),
  z.object({ handoverTo: z.string().min(1).max(64) }).strict(),
  z.object({ take: z.literal(true) }).strict(),
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
  if (!parsed.success) return NextResponse.json({ error: "assign, remove, handoverTo or take required" }, { status: 400 })
  const body = parsed.data
  // A nurse hands her place on; the nurses of a case are put on and taken off by whoever Core says (below); a nurse may put herself on a case without one.
  if ("handoverTo" in body) { const refusal = refuseIfNotAllowed(user, "HAND_OVER_TO_NURSE"); if (refusal) return refusal }

  const caseRecord = await prisma.case.findFirst({ where: caseReadWhereForUser(user, id), select: { id: true, status: true, institutionId: true, userId: true } })
  if (!caseRecord) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (caseRecord.status === "COMPLETE" || caseRecord.status === "CANCELLED") return NextResponse.json({ error: "Case is closed" }, { status: 409 })
  const sameInstitution = !!user.institutionId && caseRecord.institutionId === user.institutionId

  if ("assign" in body || "remove" in body) {
    if (!mayAssignNurses({ accountRole: user.role, ownsCase: caseRecord.userId === user.id, sameInstitution })) {
      return NextResponse.json({ error: "Not allowed to put nurses on this case", code: "ASSIGN_NURSES_NOT_ALLOWED" }, { status: 403 })
    }
  } else if ("handoverTo" in body) {
    // She hands over her own place on a case she can work on. Reaching the case through her theatre is no place on it, and
    // handing over to herself is no way onto a case that already has nurses; whoever may put nurses on the case needs no place.
    if (!await prisma.case.count({ where: caseWriteWhereForUser(user, id) })) return NextResponse.json({ error: "Not found" }, { status: 404 })
    if (body.handoverTo === user.id) return NextResponse.json({ error: "Not an anaesthesia nurse of this department", code: "NOT_A_NURSE" }, { status: 400 })
    const mayPlace = mayAssignNurses({ accountRole: user.role, ownsCase: caseRecord.userId === user.id, sameInstitution })
    if (!mayPlace && !await prisma.caseNurse.count({ where: { caseId: id, userId: user.id } })) {
      return NextResponse.json({ error: "Not allowed to put nurses on this case", code: "ASSIGN_NURSES_NOT_ALLOWED" }, { status: 403 })
    }
  } else {
    const nursesOnCase = await prisma.caseNurse.count({ where: { caseId: id } })
    if (!mayTakeCase({ accountRole: user.role, nursesOnCase, sameInstitution })) {
      return NextResponse.json({ error: "A nurse may put herself only on a case that has no nurse", code: "TAKE_CASE_NOT_ALLOWED" }, { status: 403 })
    }
  }

  const targetId = "assign" in body ? body.assign : "remove" in body ? body.remove : "handoverTo" in body ? body.handoverTo : user.id
  if ("assign" in body || "handoverTo" in body) {
    const target = await prisma.user.findFirst({
      where: { id: targetId, role: { in: [...NURSE_ACCOUNT_ROLES] }, activatedAt: { not: null }, suspendedAt: null, deletedAt: null, anonymizedAt: null, ...(caseRecord.institutionId ? { institutionId: caseRecord.institutionId } : {}) },
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
    } else if ("handoverTo" in body) {
      await tx.caseNurse.deleteMany({ where: { caseId: id, userId: user.id } })
      await tx.caseNurse.upsert({ where: { caseId_userId: { caseId: id, userId: body.handoverTo } }, create: { caseId: id, userId: body.handoverTo, assignedById: user.id, source: "HANDOVER" }, update: {} })
      await logAuditInTransaction(tx, user.id, "CASE_NURSE_HANDOVER", id, { to: body.handoverTo })
    } else {
      await tx.caseNurse.upsert({ where: { caseId_userId: { caseId: id, userId: user.id } }, create: { caseId: id, userId: user.id, assignedById: user.id, source: "SELF" }, update: {} })
      await logAuditInTransaction(tx, user.id, "CASE_NURSE_TAKE", id, {})
    }
  })
  const nurses = await prisma.caseNurse.findMany({ where: { caseId: id }, orderBy: { assignedAt: "asc" }, include: { user: NURSE_USER } })
  return NextResponse.json({ nurses: nurses.map(row => ({ userId: row.userId, source: row.source, assignedAt: row.assignedAt, user: row.user })) }, { headers: corsHeaders(req) })
}
