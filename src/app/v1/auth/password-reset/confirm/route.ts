import { NextRequest, NextResponse } from "next/server"
import bcrypt from "bcryptjs"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { hashAuthToken } from "@/lib/auth-email-tokens"
import { notePasswordChanged } from "@/lib/password-epoch"
import { passwordSchema } from "@/lib/password-policy"
import { revokeAllSessionsInTransaction } from "@/lib/auth-sessions"
import { logAuditInTransaction } from "@/lib/audit"
import { publicEmailAuthenticationRefusal } from "@/lib/deployment-capabilities"

const schema = z.object({
  token: z.string().min(20),
  password: passwordSchema,
})

class ResetClaimFailed extends Error {}

export async function POST(req: NextRequest) {
  const deploymentRefusal = publicEmailAuthenticationRefusal()
  if (deploymentRefusal) {
    return NextResponse.json(deploymentRefusal.body, { status: deploymentRefusal.status })
  }
  let data: z.infer<typeof schema>
  try {
    data = schema.parse(await req.json())
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues[0]?.message : "Invalid request"
    return NextResponse.json({ error: message ?? "Invalid request" }, { status: 400 })
  }

  const now = new Date()
  const resetToken = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashAuthToken(data.token) },
    include: { user: true },
  })

  if (
    !resetToken
    || resetToken.usedAt
    || resetToken.expiresAt < now
    || resetToken.user.deletedAt
    || resetToken.user.anonymizedAt
  ) {
    return NextResponse.json({ error: "Invalid or expired reset link" }, { status: 400 })
  }

  if (await bcrypt.compare(data.password, resetToken.user.passwordHash)) {
    return NextResponse.json({ error: "New password must be different" }, { status: 409 })
  }
  const passwordHash = await bcrypt.hash(data.password, 12)
  try {
    await prisma.$transaction(async transaction => {
      // Conditional claim is the concurrency boundary: at most one request can
      // change usedAt from null, so two confirmations cannot both succeed.
      const claimed = await transaction.passwordResetToken.updateMany({
        where: { id: resetToken.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      })
      if (claimed.count !== 1) throw new ResetClaimFailed()

      const changed = await transaction.user.updateMany({
        where: { id: resetToken.userId, deletedAt: null, anonymizedAt: null },
        data: {
          passwordHash,
          passwordChangedAt: now,
          recoveryRequiredAt: null,
        },
      })
      if (changed.count !== 1) throw new ResetClaimFailed()

      await transaction.passwordResetToken.updateMany({
        where: { userId: resetToken.userId, usedAt: null },
        data: { usedAt: now },
      })
      const revokedCount = await revokeAllSessionsInTransaction(
        transaction,
        resetToken.userId,
        now,
        "PASSWORD_RECOVERY",
      )
      await logAuditInTransaction(
        transaction,
        resetToken.userId,
        "PASSWORD_RECOVERY",
        resetToken.userId,
        { revokedSessionCount: revokedCount },
      )
    })
  } catch (error) {
    if (error instanceof ResetClaimFailed) {
      return NextResponse.json({ error: "Invalid or expired reset link" }, { status: 400 })
    }
    throw error
  }
  // Tracked sessions were revoked transactionally above. Prime this instance's
  // account epoch as well for pre-migration JWTs; another instance re-reads a
  // stale legacy-account cache within its one-minute TTL.
  notePasswordChanged(resetToken.userId, now)

  return NextResponse.json({ ok: true })
}
