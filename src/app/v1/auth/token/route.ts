import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { rateLimit } from "@/lib/rate-limit"
import { AUTH_TOKEN_TTL_SECONDS, signMobileToken } from "@/lib/mobile-auth"
import { corsHeaders } from "@/lib/cors"
import { emailSchema, normalizeEmail } from "@/lib/auth-email-tokens"
import { verifyCredentials } from "@/lib/credentials"

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req, "POST, OPTIONS", "Content-Type, Authorization") })
}

const schema = z.object({
  email:    emailSchema,
  password: z.string().min(1),
})

// Mobile login — returns a signed JWT as { access_token, token_type, expires_in }.
// Web sessions continue to use NextAuth cookie auth; this endpoint is for the React Native app only.
export async function POST(req: NextRequest) {
  let body: z.infer<typeof schema>
  try {
    body = schema.parse(await req.json())
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  // Throttle per-email AND per-IP: the email key stops targeting one account,
  // the IP key stops credential-stuffing many accounts from one source.
  const email = normalizeEmail(body.email)
  const ip = req.headers.get("x-forwarded-for") ?? "unknown"
  const [rlEmail, rlIp] = await Promise.all([
    rateLimit(`login:${email}`, 10, 15 * 60 * 1000),
    rateLimit(`login-ip:${ip}`, 50, 15 * 60 * 1000),
  ])
  if (!rlEmail.allowed || !rlIp.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 })
  }

  const user = await verifyCredentials(email, body.password)
  if (!user) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 })
  }

  const jti = crypto.randomUUID()
  prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }).catch(() => {})

  const token = await signMobileToken({
    id:              user.id,
    jti,
    role:            user.role,
    institutionId:   user.institutionId,
    institutionName: user.institution?.name ?? null,
    firstName:       user.firstName,
    lastName:        user.lastName,
    title:           user.title,
    lastLoginAt:     user.lastLoginAt?.toISOString() ?? null,
  })

  return NextResponse.json({
    access_token: token,
    token_type:   "Bearer",
    expires_in:   AUTH_TOKEN_TTL_SECONDS,
  })
}
