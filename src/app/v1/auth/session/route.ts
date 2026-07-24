import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { emailSchema, normalizeEmail } from "@/lib/auth-email-tokens"
import { verifyCredentials } from "@/lib/credentials"
import {
  AUTH_COOKIE_NAME,
  AUTH_TOKEN_TTL_SECONDS,
  getAuthUser,
  signMobileToken,
} from "@/lib/mobile-auth"
import { rateLimit } from "@/lib/rate-limit"
import { prisma } from "@/lib/prisma"
import { revokeToken } from "@/lib/token-blocklist"

const schema = z.object({
  email: emailSchema,
  password: z.string().min(1),
})

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: AUTH_TOKEN_TTL_SECONDS,
  }
}

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  const email = normalizeEmail(parsed.data.email)
  const ip = req.headers.get("x-forwarded-for") ?? "unknown"
  const [emailLimit, ipLimit] = await Promise.all([
    rateLimit(`login:${email}`, 10, 15 * 60 * 1000),
    rateLimit(`login-ip:${ip}`, 50, 15 * 60 * 1000),
  ])
  if (!emailLimit.allowed || !ipLimit.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 })
  }

  const user = await verifyCredentials(email, parsed.data.password)
  if (!user) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 })
  }

  const jti = crypto.randomUUID()
  const token = await signMobileToken({
    id: user.id,
    jti,
    role: user.role,
    institutionId: user.institutionId,
    institutionName: user.institution?.name ?? null,
    firstName: user.firstName,
    lastName: user.lastName,
    title: user.title,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  })

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  }).catch(() => null)

  const response = NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      title: user.title,
      role: user.role,
      institutionId: user.institutionId,
      institutionName: user.institution?.name ?? null,
      acceptedTermsAt: user.acceptedTermsAt?.toISOString() ?? null,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    },
  })
  response.cookies.set(AUTH_COOKIE_NAME, token, cookieOptions())
  return response
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const account = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      email: true,
      name: true,
      acceptedTermsAt: true,
      lastLoginAt: true,
    },
  })
  if (!account) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  return NextResponse.json({
    user: {
      ...user,
      email: account.email,
      name: account.name,
      acceptedTermsAt: account.acceptedTermsAt?.toISOString() ?? null,
      lastLoginAt: account.lastLoginAt?.toISOString() ?? null,
    },
  })
}

export async function DELETE(req: NextRequest) {
  const user = await getAuthUser(req)
  if (user?.jti) {
    await revokeToken(
      user.jti,
      new Date(Date.now() + AUTH_TOKEN_TTL_SECONDS * 1000),
    )
  }

  const response = NextResponse.json({ ok: true })
  response.cookies.set(AUTH_COOKIE_NAME, "", {
    ...cookieOptions(),
    maxAge: 0,
  })
  return response
}
