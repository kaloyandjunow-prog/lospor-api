import { NextRequest, NextResponse } from "next/server"
import { verifyCredentials } from "@/lib/credentials"
import {
  authenticationRateLimitKey,
  parseAuthenticationRequest,
} from "@/lib/authentication-identity"
import { authenticationDeploymentMode } from "@/lib/deployment-capabilities"
import {
  AUTH_COOKIE_NAME,
  AUTH_TOKEN_TTL_SECONDS,
  authTokenFromRequest,
  getAuthUser,
  signMobileToken,
} from "@/lib/mobile-auth"
import { rateLimit } from "@/lib/rate-limit"
import { prisma } from "@/lib/prisma"
import { revokeToken } from "@/lib/token-blocklist"
import {
  preferredLocaleFromPreferences,
  preferencesWithPreferredLocale,
} from "@lospor/core/account"
import { mapLegalAcceptance } from "@/lib/legal-documents"
import { invalidateAccountState } from "@/lib/password-epoch"
import type { Prisma } from "@/generated/prisma/client"
import {
  createAuthSessionInTransaction,
  normalizeDeviceLabel,
  revokeTrackedSession,
} from "@/lib/auth-sessions"
import type { AuthSessionClient } from "@/lib/auth-sessions"
import {
  administratorMfaRequired,
  beginAdministratorMfaLogin,
  MfaConfigurationError,
} from "@/lib/administrator-mfa"

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: AUTH_TOKEN_TTL_SECONDS,
  }
}

function sessionClientType(req: NextRequest): AuthSessionClient {
  return req.headers.get("x-lospor-client")?.trim().toLowerCase() === "pwa"
    ? "PWA"
    : "WEB"
}

export async function POST(req: NextRequest) {
  const parsed = parseAuthenticationRequest(await req.json().catch(() => null))
  if (!parsed) {
    if (authenticationDeploymentMode() === "UNAVAILABLE") {
      return NextResponse.json({
        error: "Authentication is unavailable",
        code: "AUTHENTICATION_DEPLOYMENT_UNAVAILABLE",
      }, { status: 503 })
    }
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  const ip = req.headers.get("x-forwarded-for") ?? "unknown"
  const [identifierLimit, ipLimit] = await Promise.all([
    rateLimit(authenticationRateLimitKey(parsed.identifier), 10, 15 * 60 * 1000),
    rateLimit(`login-ip:${ip}`, 50, 15 * 60 * 1000),
  ])
  if (!identifierLimit.allowed || !ipLimit.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 })
  }

  const user = await verifyCredentials(parsed.identifier, parsed.password)
  if (!user) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 })
  }

  const preferredLocale = parsed.locale
    ?? preferredLocaleFromPreferences(user.preferences)
  const clientType = sessionClientType(req)
  const deviceLabel = normalizeDeviceLabel(
    parsed.deviceLabel,
    normalizeDeviceLabel(req.headers.get("user-agent"), "Web browser"),
  )
  if (administratorMfaRequired(user.role)) {
    try {
      const mfa = await beginAdministratorMfaLogin({
        userId: user.id,
        accountLabel: user.username ?? user.email ?? user.id,
        clientType,
        preferredLocale,
        deviceLabel,
      })
      return NextResponse.json({ code: mfa.code, mfa }, { status: 202 })
    } catch (error) {
      if (error instanceof MfaConfigurationError) {
        return NextResponse.json({
          error: "Administrator multi-factor authentication is unavailable",
          code: error.code,
        }, { status: 503 })
      }
      throw error
    }
  }
  const loginAt = new Date()
  const jti = crypto.randomUUID()
  const expiresAt = new Date(loginAt.getTime() + AUTH_TOKEN_TTL_SECONDS * 1000)
  const token = await signMobileToken({
    id: user.id,
    jti,
    role: user.role,
    accountKind: user.accountKind,
    preferredLocale,
    institutionId: user.institutionId,
    institutionName: user.institution?.name ?? null,
    firstName: user.firstName,
    lastName: user.lastName,
    title: user.title,
    lastLoginAt: loginAt.toISOString(),
    clientType,
  })

  await prisma.$transaction(async transaction => {
    await transaction.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: loginAt,
        ...(parsed.locale
          ? { preferences: preferencesWithPreferredLocale(user.preferences, parsed.locale) as Prisma.InputJsonValue }
          : {}),
      },
    })
    await createAuthSessionInTransaction(transaction, {
      jti,
      userId: user.id,
      clientType,
      deviceLabel,
      issuedAt: loginAt,
      expiresAt,
    })
  })
  if (parsed.locale) invalidateAccountState(user.id)

  const response = NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      title: user.title,
      role: user.role,
      accountKind: user.accountKind,
      preferredLocale,
      institutionId: user.institutionId,
      institutionName: user.institution?.name ?? null,
      acceptedTermsAt: user.acceptedTermsAt?.toISOString() ?? null,
      legalAcceptances: user.legalAcceptances.map(mapLegalAcceptance),
      lastLoginAt: loginAt.toISOString(),
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
      username: true,
      name: true,
      acceptedTermsAt: true,
      legalAcceptances: { orderBy: { acceptedAt: "desc" } },
      preferences: true,
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
      username: account.username,
      name: account.name,
      acceptedTermsAt: account.acceptedTermsAt?.toISOString() ?? null,
      preferredLocale: preferredLocaleFromPreferences(account.preferences),
      legalAcceptances: account.legalAcceptances.map(mapLegalAcceptance),
      lastLoginAt: account.lastLoginAt?.toISOString() ?? null,
    },
  })
}

export async function DELETE(req: NextRequest) {
  const user = await getAuthUser(req)
  const hadCredential = authTokenFromRequest(req) !== null
  let confirmed = !hadCredential
  if (user?.jti) {
    const now = new Date()
    try {
      const tracked = await revokeTrackedSession(user.jti, user.id, now, "LOGOUT")
      const blocklisted = await revokeToken(
        user.jti,
        new Date(now.getTime() + AUTH_TOKEN_TTL_SECONDS * 1000),
      )
      confirmed = tracked || blocklisted
    } catch {
      confirmed = false
    }
  }

  const response = confirmed
    ? NextResponse.json({ ok: true })
    : NextResponse.json(
        { error: "Logout revocation could not be confirmed; retry" },
        { status: 503 },
      )
  response.cookies.set(AUTH_COOKIE_NAME, "", {
    ...cookieOptions(),
    maxAge: 0,
  })
  return response
}
