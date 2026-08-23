import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { rateLimit } from "@/lib/rate-limit"
import { AUTH_TOKEN_TTL_SECONDS, signMobileToken } from "@/lib/mobile-auth"
import { corsHeaders } from "@/lib/cors"
import { verifyCredentials } from "@/lib/credentials"
import {
  authenticationRateLimitKey,
  parseAuthenticationRequest,
} from "@/lib/authentication-identity"
import { authenticationDeploymentMode } from "@/lib/deployment-capabilities"
import {
  preferredLocaleFromPreferences,
  preferencesWithPreferredLocale,
} from "@lospor/core/account"
import { invalidateAccountState } from "@/lib/password-epoch"
import type { Prisma } from "@/generated/prisma/client"
import {
  createAuthSessionInTransaction,
  normalizeDeviceLabel,
} from "@/lib/auth-sessions"
import {
  administratorMfaRequired,
  beginAdministratorMfaLogin,
  MfaConfigurationError,
} from "@/lib/administrator-mfa"

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req, "POST, OPTIONS", "Content-Type, Authorization") })
}

// Mobile login — returns a signed JWT as { access_token, token_type, expires_in }.
// Web sessions continue to use NextAuth cookie auth; this endpoint is for the React Native app only.
export async function POST(req: NextRequest) {
  const body = parseAuthenticationRequest(await req.json().catch(() => null))
  if (!body) {
    if (authenticationDeploymentMode() === "UNAVAILABLE") {
      return NextResponse.json({
        error: "Authentication is unavailable",
        code: "AUTHENTICATION_DEPLOYMENT_UNAVAILABLE",
      }, {
        status: 503,
        headers: corsHeaders(req, "POST, OPTIONS", "Content-Type, Authorization"),
      })
    }
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  // Throttle per-identity AND per-IP without persisting the raw identifier.
  const ip = req.headers.get("x-forwarded-for") ?? "unknown"
  const [rlIdentity, rlIp] = await Promise.all([
    rateLimit(authenticationRateLimitKey(body.identifier), 10, 15 * 60 * 1000),
    rateLimit(`login-ip:${ip}`, 50, 15 * 60 * 1000),
  ])
  if (!rlIdentity.allowed || !rlIp.allowed) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 })
  }

  const user = await verifyCredentials(body.identifier, body.password)
  if (!user) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 })
  }

  const preferredLocale = body.locale ?? preferredLocaleFromPreferences(user.preferences)
  const deviceLabel = normalizeDeviceLabel(body.deviceLabel, "Mobile device")
  if (administratorMfaRequired(user.role)) {
    try {
      const mfa = await beginAdministratorMfaLogin({
        userId: user.id,
        accountLabel: user.username ?? user.email ?? user.id,
        clientType: "NATIVE",
        preferredLocale,
        deviceLabel,
      })
      return NextResponse.json(
        { code: mfa.code, mfa },
        { status: 202, headers: corsHeaders(req, "POST, OPTIONS", "Content-Type, Authorization") },
      )
    } catch (error) {
      if (error instanceof MfaConfigurationError) {
        return NextResponse.json({
          error: "Administrator multi-factor authentication is unavailable",
          code: error.code,
        }, {
          status: 503,
          headers: corsHeaders(req, "POST, OPTIONS", "Content-Type, Authorization"),
        })
      }
      throw error
    }
  }
  const loginAt = new Date()
  const jti = crypto.randomUUID()
  const expiresAt = new Date(loginAt.getTime() + AUTH_TOKEN_TTL_SECONDS * 1000)

  const token = await signMobileToken({
    id:              user.id,
    jti,
    role:            user.role,
    accountKind:     user.accountKind,
    preferredLocale,
    institutionId:   user.institutionId,
    institutionName: user.institution?.name ?? null,
    firstName:       user.firstName,
    lastName:        user.lastName,
    title:           user.title,
    lastLoginAt:     loginAt.toISOString(),
    clientType:      "NATIVE",
  })

  await prisma.$transaction(async transaction => {
    await transaction.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: loginAt,
        ...(body.locale
          ? { preferences: preferencesWithPreferredLocale(user.preferences, body.locale) as Prisma.InputJsonValue }
          : {}),
      },
    })
    await createAuthSessionInTransaction(transaction, {
      jti,
      userId: user.id,
      clientType: "NATIVE",
      deviceLabel,
      issuedAt: loginAt,
      expiresAt,
    })
  })
  if (body.locale) invalidateAccountState(user.id)

  return NextResponse.json({
    access_token: token,
    token_type:   "Bearer",
    expires_in:   AUTH_TOKEN_TTL_SECONDS,
    preferredLocale,
  })
}
