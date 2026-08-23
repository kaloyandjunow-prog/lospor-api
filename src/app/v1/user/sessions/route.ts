import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { revokeAllSessionsInTransaction } from "@/lib/auth-sessions"
import { logAuditInTransaction } from "@/lib/audit"

export async function GET(request: NextRequest) {
  const user = await getAuthUser(request)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const now = new Date()
  const sessions = await prisma.authSession.findMany({
    where: { userId: user.id, revokedAt: null, expiresAt: { gt: now } },
    select: {
      jti: true,
      clientType: true,
      deviceLabel: true,
      issuedAt: true,
      lastSeenAt: true,
      expiresAt: true,
    },
    orderBy: { lastSeenAt: "desc" },
  })

  return NextResponse.json({
    sessions: sessions.map(session => ({
      id: session.jti,
      clientType: session.clientType,
      deviceLabel: session.deviceLabel,
      issuedAt: session.issuedAt.toISOString(),
      lastSeenAt: session.lastSeenAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      current: session.jti === user.jti,
    })),
  })
}

/** Revoke every active session except the one authorizing this request. */
export async function DELETE(request: NextRequest) {
  const user = await getAuthUser(request)
  if (!user?.jti) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const now = new Date()
  const revoked = await prisma.$transaction(async transaction => {
    const count = await revokeAllSessionsInTransaction(
      transaction,
      user.id,
      now,
      "USER_REVOKE_OTHER_SESSIONS",
      user.jti,
    )
    await logAuditInTransaction(
      transaction,
      user.id,
      "SESSION_REVOKE_OTHERS",
      user.id,
      { revokedCount: count },
    )
    return count
  })

  return NextResponse.json({ ok: true, revokedCount: revoked })
}
