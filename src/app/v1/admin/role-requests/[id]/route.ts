import { NextRequest, NextResponse } from "next/server"
import { canHaveHeadOfDepartment } from "@/lib/institutions"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"
import { invalidateAccountState, notePasswordChanged } from "@/lib/password-epoch"
import { z } from "zod"
import { corsHeaders } from "@/lib/cors"
import { lockMembership } from "@/lib/membership-change"
import { logAuditInTransaction } from "@/lib/audit"
import { revokeAllSessionsInTransaction } from "@/lib/auth-sessions"

const schema = z.object({ action: z.enum(["approve", "reject"]) })

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!requireRole(user, ["ADMIN"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id } = await params
  const { action } = schema.parse(await req.json())

  const now = new Date()
  const updated = await prisma.$transaction(async transaction => {
    const roleRequest = await transaction.roleRequest.findUnique({ where: { id } })
    if (!roleRequest) return "NOT_FOUND" as const
    if (roleRequest.status !== "PENDING") return "ALREADY_RESOLVED" as const
    if (action === "approve") {
      const target = await lockMembership(transaction, roleRequest.userId)
      if (!target) return "NOT_FOUND" as const
      if (
        !target.activatedAt
        || target.suspendedAt
        || target.recoveryRequiredAt
        || target.deletedAt
        || target.anonymizedAt
      ) return "INACTIVE_ACCOUNT" as const
      if (!canHaveHeadOfDepartment(target.institutionId)) return "INVALID_HOD_INSTITUTION" as const
      await transaction.user.update({
        where: { id: roleRequest.userId },
        data:  { role: "HEAD_OF_DEPT", passwordChangedAt: now },
      })
    }
    const resolved = await transaction.roleRequest.updateMany({
      where: { id, status: "PENDING" },
      data:  { status: action === "approve" ? "APPROVED" : "REJECTED", resolvedAt: now },
    })
    if (resolved.count !== 1) return "ALREADY_RESOLVED" as const
    const revokedSessionCount = action === "approve"
      ? await revokeAllSessionsInTransaction(
          transaction,
          roleRequest.userId,
          now,
          "HOD_ROLE_APPROVED",
        )
      : 0
    await logAuditInTransaction(
      transaction,
      user.id,
      action === "approve" ? "HOD_ROLE_REQUEST_APPROVE" : "HOD_ROLE_REQUEST_REJECT",
      roleRequest.userId,
      { requestId: id, revokedSessionCount },
    )
    return transaction.roleRequest.findUniqueOrThrow({ where: { id } })
  })
  if (updated === "NOT_FOUND") return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (updated === "ALREADY_RESOLVED") {
    return NextResponse.json({ error: "This request has already been resolved" }, { status: 409 })
  }
  if (updated === "INVALID_HOD_INSTITUTION") {
    return NextResponse.json(
      { error: "This user's institution cannot have a head of department" },
      { status: 422 },
    )
  }
  if (updated === "INACTIVE_ACCOUNT") {
    return NextResponse.json({ error: "The account is not active" }, { status: 409 })
  }
  if (action === "approve") {
    notePasswordChanged(updated.userId, now)
    invalidateAccountState(updated.userId)
  }

  return NextResponse.json({
    ...updated,
    targetReauthenticationRequired: action === "approve",
  })
}
