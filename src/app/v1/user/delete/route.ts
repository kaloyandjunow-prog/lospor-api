import { NextRequest, NextResponse } from "next/server"
import { AUTH_COOKIE_NAME, getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { invalidateAccountState, notePasswordChanged } from "@/lib/password-epoch"
import { logAuditInTransaction } from "@/lib/audit"
import { corsHeaders } from "@/lib/cors"
import { revokeAllSessionsInTransaction } from "@/lib/auth-sessions"
import {
  activeClinicalAdminWhere,
  isTransactionConflict,
  serializableTransaction,
} from "@/lib/account-lifecycle"
import { RETENTION_DAYS } from "@/lib/purge-deleted"

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Bumping passwordChangedAt kills every token issued before now, not just the
  // one that made this request. Without it a deleted account kept full API
  // access from any other signed-in device until its token expired (up to 8 h).
  const now = new Date()
  try {
    const outcome = await prisma.$transaction(async transaction => {
      if (user.role === "ADMIN" && user.accountKind === "CLINICAL") {
        const admins = await transaction.user.count({ where: activeClinicalAdminWhere })
        if (admins <= 1) return "LAST_ADMIN" as const
      }
      const changed = await transaction.user.updateMany({
        where: { id: user.id, deletedAt: null, anonymizedAt: null },
        data: {
          deletedAt: now,
          recoveryRequiredAt: null,
          passwordChangedAt: now,
        },
      })
      if (changed.count !== 1) return "CONFLICT" as const
      await transaction.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: now },
      })
      const revokedCount = await revokeAllSessionsInTransaction(
        transaction,
        user.id,
        now,
        "ACCOUNT_DELETION_PENDING",
      )
      await logAuditInTransaction(
        transaction,
        user.id,
        "ACCOUNT_DELETE_REQUEST",
        user.id,
        { retentionDays: RETENTION_DAYS, revokedSessionCount: revokedCount },
      )
      return "OK" as const
    }, serializableTransaction)
    if (outcome !== "OK") {
      return NextResponse.json(
        { error: outcome },
        { status: 409, headers: CORS(req) },
      )
    }
  } catch (error) {
    if (isTransactionConflict(error)) {
      return NextResponse.json(
        { error: "Concurrent account change; retry" },
        { status: 409, headers: CORS(req) },
      )
    }
    throw error
  }
  notePasswordChanged(user.id, now)
  invalidateAccountState(user.id)

  // Clears the web cookie — no-op for mobile bearer token clients
  const response = NextResponse.json({ ok: true })
  response.cookies.set(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  })
  return response
}
