import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"
import { logAuditInTransaction } from "@/lib/audit"
import { revokeAllSessionsInTransaction } from "@/lib/auth-sessions"
import {
  activeClinicalAdminWhere,
  isTransactionConflict,
  serializableTransaction,
} from "@/lib/account-lifecycle"
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
  if (id === actor.id) {
    return NextResponse.json({ error: "Cannot suspend your own account" }, { status: 400 })
  }
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "A reason is required" }, { status: 400 })

  const now = new Date()
  try {
    const outcome = await prisma.$transaction(async transaction => {
      const target = await transaction.user.findUnique({
        where: { id },
        select: {
          id: true,
          role: true,
          accountKind: true,
          activatedAt: true,
          suspendedAt: true,
          recoveryRequiredAt: true,
          deletedAt: true,
          anonymizedAt: true,
        },
      })
      if (!target) return "NOT_FOUND" as const
      if (target.deletedAt || target.anonymizedAt) return "DELETED" as const
      if (target.suspendedAt) return "ALREADY_SUSPENDED" as const
      if (target.role === "ADMIN" && target.accountKind === "CLINICAL") {
        const admins = await transaction.user.count({ where: activeClinicalAdminWhere })
        if (admins <= 1) return "LAST_ADMIN" as const
      }

      const changed = await transaction.user.updateMany({
        where: { id, suspendedAt: null, deletedAt: null, anonymizedAt: null },
        data: { suspendedAt: now, passwordChangedAt: now },
      })
      if (changed.count !== 1) return "CONFLICT" as const
      await transaction.passwordResetToken.updateMany({
        where: { userId: id, usedAt: null },
        data: { usedAt: now },
      })
      const revokedCount = await revokeAllSessionsInTransaction(
        transaction,
        id,
        now,
        "ACCOUNT_SUSPENDED",
      )
      await logAuditInTransaction(transaction, actor.id, "ADMIN_ACCOUNT_SUSPEND", id, {
        reason: parsed.data.reason,
        revokedSessionCount: revokedCount,
      })
      return "OK" as const
    }, serializableTransaction)

    const statuses: Record<Exclude<typeof outcome, "OK">, number> = {
      NOT_FOUND: 404,
      DELETED: 409,
      ALREADY_SUSPENDED: 409,
      LAST_ADMIN: 409,
      CONFLICT: 409,
    }
    if (outcome !== "OK") return NextResponse.json({ error: outcome }, { status: statuses[outcome] })
  } catch (error) {
    if (isTransactionConflict(error)) {
      return NextResponse.json({ error: "Concurrent account change; retry" }, { status: 409 })
    }
    throw error
  }

  notePasswordChanged(id, now)
  invalidateAccountState(id)
  return NextResponse.json({ ok: true, suspendedAt: now.toISOString() })
}
