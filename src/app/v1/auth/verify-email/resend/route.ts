import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { prisma } from "@/lib/prisma"
import { rateLimit } from "@/lib/rate-limit"
import { createAuthToken, EMAIL_VERIFICATION_TTL_MS, emailSchema, hashAuthToken, normalizeEmail, tokenExpiry } from "@/lib/auth-email-tokens"
import { appUrl, sendVerificationEmail } from "@/lib/transactional-email"

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
    rateLimit(`verify-email-ip:${ip}`, 20, 60 * 60 * 1000),
    rateLimit(`verify-email:${email}`, 5, 60 * 60 * 1000),
  ])
  if (!rlIp.allowed || !rlEmail.allowed) return NextResponse.json({ ok: true }, { status: 202 })

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, emailVerifiedAt: true, deletedAt: true },
  })
  if (!user || user.deletedAt || user.emailVerifiedAt) return NextResponse.json({ ok: true })

  const token = createAuthToken()
  await prisma.emailVerificationToken.create({
    data: {
      userId: user.id,
      tokenHash: hashAuthToken(token),
      expiresAt: tokenExpiry(EMAIL_VERIFICATION_TTL_MS),
    },
  })

  const verifyUrl = appUrl(`/verify-email?token=${encodeURIComponent(token)}`)
  let emailSent = false
  try {
    const result = await sendVerificationEmail({ email: user.email, name: user.name }, verifyUrl)
    emailSent = result.sent
  } catch (err) {
    console.error("[verify-email.resend]", err)
  }

  const exposeTestLink = process.env.NODE_ENV !== "production" && (process.env.AUTH_EMAIL_TEST_LINKS === "true" || !process.env.BREVO_API_KEY)
  return NextResponse.json({
    ok: true,
    emailSent,
    ...(exposeTestLink ? { devVerifyUrl: verifyUrl } : {}),
  })
}
