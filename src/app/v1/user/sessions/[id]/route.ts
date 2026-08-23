import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { logAuditInTransaction } from "@/lib/audit"

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(request)
  if (!user?.jti) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  if (id === user.jti) {
    return NextResponse.json(
      { error: "Use logout to revoke the current session" },
      { status: 409 },
    )
  }

  const now = new Date()
  const revoked = await prisma.$transaction(async transaction => {
    const result = await transaction.authSession.updateMany({
      where: { jti: id, userId: user.id, revokedAt: null, expiresAt: { gt: now } },
      data: { revokedAt: now, revokedReason: "USER_REVOKE_SESSION" },
    })
    if (result.count !== 1) return false
    await logAuditInTransaction(
      transaction,
      user.id,
      "SESSION_REVOKE",
      user.id,
      { sessionId: id },
    )
    return true
  })

  if (!revoked) return NextResponse.json({ error: "Session not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}
