import { NextRequest, NextResponse } from "next/server"
import { canHaveHeadOfDepartment } from "@/lib/institutions"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"
import { invalidateAccountState, notePasswordChanged } from "@/lib/password-epoch"
import { logAuditInTransaction } from "@/lib/audit"
import { RETENTION_DAYS } from "@/lib/purge-deleted"
import { z } from "zod"
import { corsHeaders } from "@/lib/cors"
import {
  isHodDemotion,
  lockMembership,
  releaseUnrelatedHodLocks,
} from "@/lib/membership-change"
import { revokeAllSessionsInTransaction } from "@/lib/auth-sessions"
import {
  activeClinicalAdminWhere,
  isTransactionConflict,
  serializableTransaction,
} from "@/lib/account-lifecycle"

const schema = z.object({
  role: z.enum(["MEMBER", "HEAD_OF_DEPT"]).optional(),
  accountKind: z.enum(["CLINICAL", "RESEARCH_ONLY"]).optional(),
}).strict().refine(value => value.role !== undefined || value.accountKind !== undefined, {
  message: "At least one account field is required",
})

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
  const parsed = schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    )
  }
  const data = parsed.data
  if (data.accountKind) {
    return NextResponse.json(
      { error: "Account-kind changes require password re-entry and a reason" },
      { status: 409 },
    )
  }

  // "Без институция" is not a department, so it has no head. Its members share
  // no workplace, and a head there would see every unaffiliated clinician's
  // cases across the whole register.
  const now = new Date()
  const updated = await prisma.$transaction(async transaction => {
    const target = await lockMembership(transaction, id)
    if (!target) return null
    if (target.role === "ADMIN") return "ADMIN_AUTHORITY_ROUTE" as const
    if (
      !target.activatedAt
      || target.suspendedAt
      || target.recoveryRequiredAt
      || target.deletedAt
      || target.anonymizedAt
    ) return "INACTIVE_ACCOUNT" as const
    if (data.role === "HEAD_OF_DEPT" && !canHaveHeadOfDepartment(target.institutionId)) {
      return "INVALID_HOD_INSTITUTION" as const
    }
    if (data.role === target.role) {
      return {
        id,
        role: target.role,
        accountKind: target.accountKind ?? "CLINICAL",
        reauthenticationRequired: false,
      }
    }
    if (isHodDemotion(target, data.role)) {
      await releaseUnrelatedHodLocks(transaction, id)
    }
    const changed = await transaction.user.updateMany({
      where: {
        id,
        role: target.role,
        suspendedAt: null,
        recoveryRequiredAt: null,
        deletedAt: null,
        anonymizedAt: null,
      },
      data:  {
        ...(data.role ? { role: data.role } : {}),
        passwordChangedAt: now,
      },
    })
    if (changed.count !== 1) return "CONFLICT" as const
    const revokedSessionCount = await revokeAllSessionsInTransaction(
      transaction,
      id,
      now,
      "ADMIN_AUTHORITY_CHANGE",
    )
    const result = {
      id,
      role: data.role ?? target.role,
      accountKind: target.accountKind ?? "CLINICAL",
      reauthenticationRequired: true,
    }
    await logAuditInTransaction(transaction, user.id, "ADMIN_ACCOUNT_AUTHORITY_CHANGE", id, {
      previousRole: target.role,
      role: result.role,
      previousAccountKind: target.accountKind ?? "CLINICAL",
      accountKind: result.accountKind,
      revokedSessionCount,
    })
    return result
  })
  if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (updated === "INVALID_HOD_INSTITUTION") {
    return NextResponse.json(
      { error: "This user's institution cannot have a head of department" },
      { status: 422 },
    )
  }
  if (updated === "ADMIN_AUTHORITY_ROUTE") {
    return NextResponse.json(
      { error: "Administrator authority changes require password re-entry and a reason" },
      { status: 409 },
    )
  }
  if (updated === "INACTIVE_ACCOUNT") {
    return NextResponse.json({ error: "The account is not active" }, { status: 409 })
  }
  if (updated === "CONFLICT") {
    return NextResponse.json({ error: "Concurrent account change; retry" }, { status: 409 })
  }
  // Role is resolved live per request from a short-lived cache. Dropping the
  // entry makes a demotion effective on the target's very next request instead
  // of waiting out the cache TTL.
  if (updated.reauthenticationRequired) {
    notePasswordChanged(id, now)
    invalidateAccountState(id)
  }

  return NextResponse.json(updated)
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!requireRole(user, ["ADMIN"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id } = await params
  if (id === user.id) {
    return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 })
  }

  // Soft-delete, exactly as an account deleting itself does.
  //
  // This was `prisma.user.delete()`. Case.user declares no onDelete, so Prisma
  // defaults to Restrict: deleting any clinician who holds a case raised a
  // foreign-key error, and with no try/catch it surfaced as an unhandled 500.
  // The endpoint therefore worked only for accounts with no clinical record,
  // which is the population it least needs to exist for.
  //
  // Where it did succeed it cascaded through nine relations, including
  // ResearchAccessGrant, ResearchCohort and ResearchExport -- destroying the
  // record of what the account had been permitted to see, at the moment someone
  // was most likely to want it.
  //
  // Marking the account deleted hands it to the retention job, which anonymises
  // it after RETENTION_DAYS. Until then the deletion is reversible, and the
  // clinical records the account authored keep their author.
  const now = new Date()
  try {
    const removed = await prisma.$transaction(async tx => {
      const target = await tx.user.findUnique({
        where: { id },
        select: {
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
      if (target.deletedAt || target.anonymizedAt) return "ALREADY_DELETED" as const
      if (
        target.role === "ADMIN"
        && target.accountKind === "CLINICAL"
        && target.activatedAt
        && !target.suspendedAt
        && !target.recoveryRequiredAt
      ) {
        const activeAdmins = await tx.user.count({ where: activeClinicalAdminWhere })
        if (activeAdmins <= 1) return "LAST_ADMIN" as const
      }
      const changed = await tx.user.updateMany({
        where: { id, deletedAt: null, anonymizedAt: null },
      // Bumping passwordChangedAt kills every token issued before now, not just
      // the session that happens to be open. Without it a deleted account keeps
      // full API access from any other signed-in device until its token
      // expires.
        data: {
          deletedAt: now,
          recoveryRequiredAt: null,
          passwordChangedAt: now,
        },
      })
      if (changed.count !== 1) return "CONFLICT" as const
      await tx.passwordResetToken.updateMany({
        where: { userId: id, usedAt: null },
        data: { usedAt: now },
      })
      const revokedCount = await revokeAllSessionsInTransaction(
        tx,
        id,
        now,
        "ACCOUNT_DELETION_PENDING",
      )
      await logAuditInTransaction(tx, user.id, "ADMIN_ACCOUNT_DELETE", id, {
        retentionDays: RETENTION_DAYS,
        revokedSessionCount: revokedCount,
      })
      return "OK" as const
    }, serializableTransaction)
    if (removed !== "OK") {
      return NextResponse.json(
        { error: removed },
        { status: removed === "NOT_FOUND" ? 404 : 409 },
      )
    }
  } catch (error) {
    if (isTransactionConflict(error)) {
      return NextResponse.json({ error: "Concurrent account change; retry" }, { status: 409 })
    }
    throw error
  }
  // Prime this instance's cache so the revocation takes effect without waiting
  // for the next read.
  notePasswordChanged(id, now)
  invalidateAccountState(id)

  return NextResponse.json({ ok: true, deletedAt: now.toISOString() })
}
