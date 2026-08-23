import { NextRequest, NextResponse } from "next/server"
import bcrypt from "bcryptjs"
import { z } from "zod"
import { getAuthUser, AUTH_COOKIE_NAME } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { passwordSchema } from "@/lib/password-policy"
import { revokeAllSessionsInTransaction } from "@/lib/auth-sessions"
import { logAuditInTransaction } from "@/lib/audit"
import { invalidateAccountState, notePasswordChanged } from "@/lib/password-epoch"

const schema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
}).strict()

class ConcurrentPasswordChange extends Error {}

export async function POST(request: NextRequest) {
  const user = await getAuthUser(request)
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    )
  }

  const account = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      passwordHash: true,
      deletedAt: true,
      suspendedAt: true,
      recoveryRequiredAt: true,
      anonymizedAt: true,
    },
  })
  if (
    !account
    || account.deletedAt
    || account.suspendedAt
    || account.recoveryRequiredAt
    || account.anonymizedAt
    || !await bcrypt.compare(parsed.data.currentPassword, account.passwordHash)
  ) {
    return NextResponse.json({ error: "Current password is incorrect" }, { status: 400 })
  }
  if (await bcrypt.compare(parsed.data.newPassword, account.passwordHash)) {
    return NextResponse.json({ error: "New password must be different" }, { status: 409 })
  }

  const now = new Date()
  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12)
  try {
    await prisma.$transaction(async transaction => {
      const changed = await transaction.user.updateMany({
        where: {
          id: user.id,
          passwordHash: account.passwordHash,
          deletedAt: null,
          suspendedAt: null,
          recoveryRequiredAt: null,
          anonymizedAt: null,
        },
        data: { passwordHash, passwordChangedAt: now },
      })
      if (changed.count !== 1) throw new ConcurrentPasswordChange()

      await transaction.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: now },
      })
      const revokedCount = await revokeAllSessionsInTransaction(
        transaction,
        user.id,
        now,
        "PASSWORD_CHANGE",
      )
      await logAuditInTransaction(
        transaction,
        user.id,
        "PASSWORD_CHANGE",
        user.id,
        { revokedSessionCount: revokedCount },
      )
    })
  } catch (error) {
    if (error instanceof ConcurrentPasswordChange) {
      return NextResponse.json(
        { error: "The password changed in another session; sign in again" },
        { status: 409 },
      )
    }
    throw error
  }

  notePasswordChanged(user.id, now)
  invalidateAccountState(user.id)
  const response = NextResponse.json({ ok: true, reauthenticationRequired: true })
  response.cookies.set(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  })
  return response
}
