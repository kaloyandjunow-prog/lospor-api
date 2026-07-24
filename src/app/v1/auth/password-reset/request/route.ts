import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { rateLimit } from "@/lib/rate-limit"
import { createAuthToken, emailSchema, hashAuthToken, normalizeEmail, PASSWORD_RESET_TTL_MS, tokenExpiry } from "@/lib/auth-email-tokens"
import { appUrl, sendPasswordResetEmail } from "@/lib/transactional-email"

const schema = z.object({ email: emailSchema })

export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for") ?? "unknown"

  let email: string
  try {
    email = normalizeEmail(schema.parse(await req.json()).email)
  } catch {
    return NextResponse.json({ ok: true })
  }

  const [rlIp, rlEmail] = await Promise.all([
    rateLimit(`password-reset-ip:${ip}`, 20, 60 * 60 * 1000),
    rateLimit(`password-reset:${email}`, 5, 60 * 60 * 1000),
  ])
  if (!rlIp.allowed || !rlEmail.allowed) return NextResponse.json({ ok: true }, { status: 202 })

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, deletedAt: true },
  })

  if (!user || user.deletedAt) return NextResponse.json({ ok: true })

  const token = createAuthToken()
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashAuthToken(token),
      expiresAt: tokenExpiry(PASSWORD_RESET_TTL_MS),
    },
  })

  const resetUrl = appUrl(`/reset-password?token=${encodeURIComponent(token)}`)
  let emailSent = false
  try {
    const result = await sendPasswordResetEmail({ email: user.email, name: user.name }, resetUrl)
    emailSent = result.sent
  } catch (err) {
    console.error("[password-reset.email]", err)
  }

  const exposeTestLink = process.env.NODE_ENV !== "production" && (process.env.AUTH_EMAIL_TEST_LINKS === "true" || !process.env.BREVO_API_KEY)
  return NextResponse.json({
    ok: true,
    emailSent,
    ...(exposeTestLink ? { devResetUrl: resetUrl } : {}),
  })
}
