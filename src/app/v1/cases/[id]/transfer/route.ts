import { NextRequest, NextResponse, after } from "next/server"
import { corsHeaders } from "@/lib/cors"
import { getAuthUser } from "@/lib/mobile-auth"
import { caseWhereForUser } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"
import { transferCaseOwnership } from "@/lib/case-transfer"
import { z } from "zod"

const postSchema  = z.object({ toUserId: z.string().min(1) })
const patchSchema = z.object({ action: z.enum(["accept", "decline"]) })

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

// POST - initiate a transfer
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: caseId } = await params
  const parsed = postSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) return NextResponse.json({ error: "toUserId required" }, { status: 400 })
  const { toUserId } = parsed.data

  if (toUserId === user.id) return NextResponse.json({ error: "Cannot transfer to yourself" }, { status: 400 })

  const isHOD   = user.role === "HEAD_OF_DEPT"
  const isAdmin = user.role === "ADMIN"

  if (!isHOD && !isAdmin) {
    return NextResponse.json({ error: "Only HOD and admin can assign cases" }, { status: 403 })
  }

  // Same ownership/HOD/admin scoping as every other case route - who can
  // initiate a transfer at all (isHOD/isAdmin, checked above) is a separate
  // transfer-specific rule layered on top of this shared visibility scope.
  const caseRecord = await prisma.case.findFirst({ where: caseWhereForUser(user, caseId) })
  if (!caseRecord) return NextResponse.json({ error: "Case not found" }, { status: 404 })

  // Fix 3: Reject transfers to deleted accounts
  const recipient = await prisma.user.findUnique({ where: { id: toUserId, deletedAt: null } })
  if (!recipient) return NextResponse.json({ error: "Recipient not found" }, { status: 400 })

  // Fix 4: ADMIN can cross-institution; HOD cannot - must be same institution as recipient
  if (!isAdmin && recipient.institutionId !== user.institutionId) {
    return NextResponse.json({ error: "Recipient must be in your institution" }, { status: 403 })
  }

  // Superseding pending transfers, renumbering the case if the recipient
  // already holds its code, and moving the institution all happen inside one
  // transaction — see transferCaseOwnership.
  const outcome = await transferCaseOwnership(prisma, caseId, toUserId, { supersedePending: true })
  const transfer = await prisma.caseTransfer.create({
    data: {
      caseId,
      fromUserId:  caseRecord.userId,
      toUserId,
      initiatedBy: user.id,
      status:      "ACCEPTED",
      resolvedAt:  new Date(),
      previousCaseCode: outcome.previousCaseCode,
    },
  })
  after(() => logAudit(user.id, "CASE_TRANSFER_ASSIGN", caseId, {
    toUserId, instant: true, previousCaseCode: outcome.previousCaseCode, caseCode: outcome.caseCode,
  }))
  return NextResponse.json({ instant: true, transfer, caseCode: outcome.caseCode, previousCaseCode: outcome.previousCaseCode })
}

// PATCH - recipient accepts or declines
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id: caseId } = await params
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json({ error: "action must be accept or decline" }, { status: 400 })
  }
  const { action } = parsed.data

  const transfer = await prisma.caseTransfer.findFirst({
    where: { caseId, toUserId: user.id, status: "PENDING" },
  })
  if (!transfer) return NextResponse.json({ error: "No pending transfer found" }, { status: 404 })

  if (action === "accept") {
    const outcome = await transferCaseOwnership(prisma, caseId, user.id, { acceptTransferId: transfer.id })
    after(() => logAudit(user.id, "CASE_TRANSFER_ACCEPT", caseId, {
      previousCaseCode: outcome.previousCaseCode, caseCode: outcome.caseCode,
    }))
    return NextResponse.json({ accepted: true, caseCode: outcome.caseCode, previousCaseCode: outcome.previousCaseCode })
  }

  await prisma.caseTransfer.update({
    where: { id: transfer.id },
    data:  { status: "DECLINED", resolvedAt: new Date() },
  })
  after(() => logAudit(user.id, "CASE_TRANSFER_DECLINE", caseId))
  return NextResponse.json({ declined: true })
}
