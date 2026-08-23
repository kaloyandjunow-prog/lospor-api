import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"
import { logAuditInTransaction } from "@/lib/audit"
import { revokeAllSessionsInTransaction } from "@/lib/auth-sessions"
import { deletionDeadline } from "@/lib/account-lifecycle"
import { invalidateAccountState, notePasswordChanged } from "@/lib/password-epoch"
import { accountAdministrationRefusal } from "@/lib/deployment-capabilities"

const schema = z.object({ reason: z.string().trim().min(3).max(500) }).strict()

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const deploymentRefusal = accountAdministrationRefusal()
  if (deploymentRefusal) {
    return NextResponse.json(deploymentRefusal.body, { status: deploymentRefusal.status })
  }
  const actor = await getAuthUser(request)
  if (!requireRole(actor, ["ADMIN"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const { id } = await params
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "A reason is required" }, { status: 400 })

  const now = new Date()
  const outcome = await prisma.$transaction(async transaction => {
    const target = await transaction.user.findUnique({
      where: { id },
      select: { deletedAt: true, anonymizedAt: true },
    })
    if (!target) return "NOT_FOUND" as const
    if (target.anonymizedAt) return "ANONYMIZED" as const
    if (!target.deletedAt) return "NOT_DELETED" as const
    if (deletionDeadline(target.deletedAt) <= now) return "RETENTION_EXPIRED" as const

    const changed = await transaction.user.updateMany({
      where: { id, deletedAt: target.deletedAt, anonymizedAt: null },
      data: {
        deletedAt: null,
        suspendedAt: null,
        recoveryRequiredAt: now,
        passwordChangedAt: now,
      },
    })
    if (changed.count !== 1) return "CONFLICT" as const
    await transaction.passwordResetToken.updateMany({
      where: { userId: id, usedAt: null },
      data: { usedAt: now },
    })
    await revokeAllSessionsInTransaction(transaction, id, now, "ACCOUNT_RESTORED")
    await logAuditInTransaction(transaction, actor.id, "ADMIN_ACCOUNT_RESTORE", id, {
      reason: parsed.data.reason,
      recoveryRequired: true,
    })
    return "OK" as const
  })

  if (outcome !== "OK") {
    return NextResponse.json(
      { error: outcome },
      { status: outcome === "NOT_FOUND" ? 404 : 409 },
    )
  }
  notePasswordChanged(id, now)
  invalidateAccountState(id)
  return NextResponse.json({
    ok: true,
    status: "RECOVERY_REQUIRED",
    recoveryRequiredAt: now.toISOString(),
  })
}
