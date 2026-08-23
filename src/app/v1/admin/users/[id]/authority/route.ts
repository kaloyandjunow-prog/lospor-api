import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"
import { verifyCurrentPassword } from "@/lib/credentials"
import { prisma } from "@/lib/prisma"
import { canHaveHeadOfDepartment } from "@/lib/institutions"
import { releaseUnrelatedHodLocks } from "@/lib/membership-change"
import { logAuditInTransaction } from "@/lib/audit"
import { revokeAllSessionsInTransaction } from "@/lib/auth-sessions"
import {
  activeClinicalAdminWhere,
  isTransactionConflict,
  serializableTransaction,
} from "@/lib/account-lifecycle"
import { invalidateAccountState, notePasswordChanged } from "@/lib/password-epoch"
import { accountAdministrationRefusal } from "@/lib/deployment-capabilities"

const schema = z.object({
  role: z.enum(["MEMBER", "HEAD_OF_DEPT", "ADMIN"]).optional(),
  accountKind: z.enum(["CLINICAL", "RESEARCH_ONLY"]).optional(),
  currentPassword: z.string().min(1),
  reason: z.string().trim().min(3).max(500),
}).strict().refine(value => value.role !== undefined || value.accountKind !== undefined, {
  message: "At least one authority field is required",
})

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
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    )
  }
  if (!await verifyCurrentPassword(actor.id, parsed.data.currentPassword)) {
    return NextResponse.json({ error: "Current password is incorrect" }, { status: 401 })
  }

  const { id } = await params
  const now = new Date()
  try {
    const outcome = await prisma.$transaction(async transaction => {
      const target = await transaction.user.findUnique({
        where: { id },
        select: {
          id: true,
          role: true,
          accountKind: true,
          institutionId: true,
          activatedAt: true,
          suspendedAt: true,
          recoveryRequiredAt: true,
          deletedAt: true,
          anonymizedAt: true,
        },
      })
      if (!target) return { code: "NOT_FOUND" as const }
      if (target.deletedAt || target.anonymizedAt) return { code: "DELETED" as const }
      if (target.suspendedAt || target.recoveryRequiredAt || !target.activatedAt) {
        return { code: "INACTIVE" as const }
      }

      const nextRole = parsed.data.role ?? target.role
      const nextAccountKind = parsed.data.accountKind ?? target.accountKind
      const roleChanged = nextRole !== target.role
      const accountKindChanged = nextAccountKind !== target.accountKind
      if (!roleChanged && !accountKindChanged) {
        return { code: "NO_CHANGE" as const }
      }
      if (target.role !== "ADMIN" && nextRole !== "ADMIN" && !accountKindChanged) {
        return { code: "STANDARD_ROUTE_REQUIRED" as const }
      }
      // Organizational administrator authority is a clinical appliance role.
      // A research-only account can receive research grants, but must not also
      // inherit the broad ADMIN gates used by clinical routes.
      if (nextRole === "ADMIN" && nextAccountKind !== "CLINICAL") {
        return { code: "ADMIN_MUST_BE_CLINICAL" as const }
      }
      if (nextRole === "HEAD_OF_DEPT" && !canHaveHeadOfDepartment(target.institutionId)) {
        return { code: "INVALID_HOD_INSTITUTION" as const }
      }

      const removesClinicalAdmin = target.role === "ADMIN"
        && target.accountKind === "CLINICAL"
        && (nextRole !== "ADMIN" || nextAccountKind !== "CLINICAL")
      if (removesClinicalAdmin) {
        const admins = await transaction.user.count({ where: activeClinicalAdminWhere })
        if (admins <= 1) return { code: "LAST_ADMIN" as const }
      }

      if (target.role === "HEAD_OF_DEPT" && nextRole === "MEMBER") {
        await releaseUnrelatedHodLocks(transaction, id)
      }
      const changed = await transaction.user.updateMany({
        where: {
          id,
          role: target.role,
          accountKind: target.accountKind,
          suspendedAt: null,
          recoveryRequiredAt: null,
          deletedAt: null,
          anonymizedAt: null,
        },
        data: {
          role: nextRole,
          accountKind: nextAccountKind,
          passwordChangedAt: now,
        },
      })
      if (changed.count !== 1) return { code: "CONFLICT" as const }
      const revokedCount = await revokeAllSessionsInTransaction(
        transaction,
        id,
        now,
        "ADMIN_AUTHORITY_CHANGE",
      )
      const action = target.role !== "ADMIN" && nextRole === "ADMIN"
        ? "ADMIN_ACCOUNT_PROMOTE"
        : target.role === "ADMIN" && nextRole !== "ADMIN"
          ? "ADMIN_ACCOUNT_DEMOTE"
          : "ADMIN_ACCOUNT_AUTHORITY_CHANGE"
      await logAuditInTransaction(transaction, actor.id, action, id, {
        reason: parsed.data.reason,
        previousRole: target.role,
        role: nextRole,
        previousAccountKind: target.accountKind,
        accountKind: nextAccountKind,
        revokedSessionCount: revokedCount,
      })
      return {
        code: "OK" as const,
        account: { id, role: nextRole, accountKind: nextAccountKind },
      }
    }, serializableTransaction)

    if (outcome.code !== "OK") {
      return NextResponse.json(
        { error: outcome.code },
        { status: outcome.code === "NOT_FOUND" ? 404 : 409 },
      )
    }
    notePasswordChanged(id, now)
    invalidateAccountState(id)
    return NextResponse.json({ ...outcome.account, reauthenticationRequired: true })
  } catch (error) {
    if (isTransactionConflict(error)) {
      return NextResponse.json({ error: "Concurrent authority change; retry" }, { status: 409 })
    }
    throw error
  }
}
