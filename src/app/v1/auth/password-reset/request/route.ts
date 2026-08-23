import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { rateLimit } from "@/lib/rate-limit"
import { createAuthToken, emailSchema, hashAuthToken, normalizeEmail, PASSWORD_RESET_TTL_MS, tokenExpiry } from "@/lib/auth-email-tokens"
import { appUrl, sendPasswordResetEmail } from "@/lib/transactional-email"
import { logAuditInTransaction } from "@/lib/audit"
import { publicEmailAuthenticationRefusal } from "@/lib/deployment-capabilities"

const schema = z.object({ email: emailSchema })

export async function POST(req: NextRequest) {
  const deploymentRefusal = publicEmailAuthenticationRefusal()
  if (deploymentRefusal) {
    return NextResponse.json(deploymentRefusal.body, { status: deploymentRefusal.status })
  }
  const ip = req.headers.get("x-forwarded-for") ?? "unknown"

  const generic = () => NextResponse.json({ ok: true }, { status: 202 })
  let email: string
  try {
    email = normalizeEmail(schema.parse(await req.json()).email)
  } catch {
    return generic()
  }

  const [rlIp, rlEmail] = await Promise.all([
    rateLimit(`password-reset-ip:${ip}`, 20, 60 * 60 * 1000),
    rateLimit(`password-reset:${email}`, 5, 60 * 60 * 1000),
  ])
  if (!rlIp.allowed || !rlEmail.allowed) return generic()

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      name: true,
      deletedAt: true,
      suspendedAt: true,
      anonymizedAt: true,
    },
  })

  if (!user || !user.email || user.deletedAt || user.suspendedAt || user.anonymizedAt) return generic()

  const token = createAuthToken()
  const now = new Date()
  await prisma.$transaction(async transaction => {
    const replaced = await transaction.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: now },
    })
    await transaction.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: hashAuthToken(token),
        expiresAt: tokenExpiry(PASSWORD_RESET_TTL_MS),
      },
    })
    await logAuditInTransaction(
      transaction,
      user.id,
      "PASSWORD_RECOVERY_TOKEN_ISSUE",
      user.id,
      { replacedActiveTokenCount: replaced.count },
    )
  })

  const resetUrl = appUrl(`/reset-password?token=${encodeURIComponent(token)}`)
  try {
    await sendPasswordResetEmail({ email: user.email, name: user.name }, resetUrl)
  } catch (err) {
    console.error("[password-reset.email]", err)
  }

  // Account existence and mail-provider state are deliberately absent. The
  // public endpoint always returns this exact status/body combination.
  return generic()
}
