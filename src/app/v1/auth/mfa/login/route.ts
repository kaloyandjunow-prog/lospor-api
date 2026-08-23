import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import type { Prisma } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { rateLimit } from "@/lib/rate-limit"
import { corsHeaders } from "@/lib/cors"
import {
  MFA_RECOVERY_CODE_COUNT,
  MfaConfigurationError,
  administratorMfaRequired,
  challengeTokenHash,
  decryptTotpSecret,
  generateRecoveryCodes,
  recoveryCodeHash,
  verifyTotpCode,
} from "@/lib/administrator-mfa"
import {
  AUTH_COOKIE_NAME,
  AUTH_TOKEN_TTL_SECONDS,
  signMobileToken,
} from "@/lib/mobile-auth"
import { createAuthSessionInTransaction } from "@/lib/auth-sessions"
import { preferencesWithPreferredLocale } from "@lospor/core/account"
import { mapLegalAcceptance } from "@/lib/legal-documents"
import { logAuditInTransaction } from "@/lib/audit"
import { invalidateAccountState } from "@/lib/password-epoch"

const schema = z.object({
  challengeToken: z.string().min(32).max(256),
  code: z.string().min(6).max(64),
})

class MfaContinuationConflict extends Error {}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: AUTH_TOKEN_TTL_SECONDS,
  }
}

function responseHeaders(req: NextRequest) {
  return corsHeaders(req, "POST, OPTIONS", "Content-Type, Authorization")
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: responseHeaders(req) })
}

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, {
      status: 400,
      headers: responseHeaders(req),
    })
  }

  const tokenHash = challengeTokenHash(parsed.data.challengeToken)
  const ip = req.headers.get("x-forwarded-for") ?? "unknown"
  const [challengeLimit, ipLimit] = await Promise.all([
    rateLimit(`mfa-login:${tokenHash}`, 10, 15 * 60 * 1000),
    rateLimit(`mfa-login-ip:${ip}`, 50, 15 * 60 * 1000),
  ])
  if (!challengeLimit.allowed || !ipLimit.allowed) {
    return NextResponse.json({ error: "Too many requests" }, {
      status: 429,
      headers: responseHeaders(req),
    })
  }

  const now = new Date()
  const challenge = await prisma.mfaLoginChallenge.findUnique({
    where: { tokenHash },
    include: {
      user: {
        include: {
          institution: true,
          legalAcceptances: { orderBy: { acceptedAt: "desc" } },
        },
      },
    },
  })
  const user = challenge?.user
  if (
    !challenge
    || !user
    || challenge.usedAt
    || challenge.expiresAt <= now
    || !user.activatedAt
    || user.deletedAt
    || user.suspendedAt
    || user.recoveryRequiredAt
    || user.anonymizedAt
    || (user.passwordChangedAt && user.passwordChangedAt >= challenge.createdAt)
    || !administratorMfaRequired(user.role)
  ) {
    return NextResponse.json({ error: "Invalid or expired MFA challenge" }, {
      status: 401,
      headers: responseHeaders(req),
    })
  }

  const enrollment = Boolean(challenge.enrollmentSecretCiphertext)
  const secretCiphertext = challenge.enrollmentSecretCiphertext
    ?? user.mfaTotpSecretCiphertext
  if (!secretCiphertext || (!enrollment && !user.mfaEnabledAt)) {
    return NextResponse.json({ error: "Invalid or expired MFA challenge" }, {
      status: 401,
      headers: responseHeaders(req),
    })
  }

  let totpStep: number | null
  try {
    totpStep = verifyTotpCode(decryptTotpSecret(secretCiphertext), parsed.data.code, now.getTime())
  } catch (error) {
    if (error instanceof MfaConfigurationError) {
      return NextResponse.json({
        error: "Administrator multi-factor authentication is unavailable",
        code: error.code,
      }, { status: 503, headers: responseHeaders(req) })
    }
    throw error
  }

  const candidateRecoveryHash = enrollment
    ? null
    : recoveryCodeHash(user.id, parsed.data.code)
  const recovery = totpStep === null && candidateRecoveryHash
    ? await prisma.mfaRecoveryCode.findFirst({
        where: { userId: user.id, codeHash: candidateRecoveryHash, usedAt: null },
        select: { id: true },
      })
    : null
  if (totpStep === null && !recovery) {
    return NextResponse.json({ error: "Invalid authentication code" }, {
      status: 401,
      headers: responseHeaders(req),
    })
  }

  const preferredLocale = challenge.preferredLocale === "en" ? "en" : "bg"
  const jti = crypto.randomUUID()
  const expiresAt = new Date(now.getTime() + AUTH_TOKEN_TTL_SECONDS * 1000)
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
    lastLoginAt: now.toISOString(),
    clientType: challenge.clientType,
    mfaVerified: true,
  })

  const recoveryCodes = enrollment ? generateRecoveryCodes() : null
  try {
    await prisma.$transaction(async transaction => {
      // This conditional write is the account-state lock for the continuation.
      // If suspension, deletion, recovery, demotion, or a password epoch wins
      // the race after the read above, no session may be created from the stale
      // password proof. If this write wins first, the competing lifecycle
      // transaction waits and then revokes the session we create.
      const activeAdministrator = await transaction.user.updateMany({
        where: {
          id: user.id,
          role: "ADMIN",
          activatedAt: { not: null },
          deletedAt: null,
          suspendedAt: null,
          recoveryRequiredAt: null,
          anonymizedAt: null,
          OR: [
            { passwordChangedAt: null },
            { passwordChangedAt: { lt: challenge.createdAt } },
          ],
        },
        data: {
          lastLoginAt: now,
          preferences: preferencesWithPreferredLocale(
            user.preferences,
            preferredLocale,
          ) as Prisma.InputJsonValue,
        },
      })
      if (activeAdministrator.count !== 1) throw new MfaContinuationConflict()

      const consumedChallenge = await transaction.mfaLoginChallenge.updateMany({
        where: { id: challenge.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      })
      if (consumedChallenge.count !== 1) throw new MfaContinuationConflict()

      if (enrollment) {
        const enabled = await transaction.user.updateMany({
          where: { id: user.id, mfaEnabledAt: null },
          data: {
            mfaTotpSecretCiphertext: secretCiphertext,
            mfaEnabledAt: now,
            mfaLastTotpStep: totpStep,
          },
        })
        if (enabled.count !== 1) throw new MfaContinuationConflict()
        await transaction.mfaRecoveryCode.deleteMany({ where: { userId: user.id } })
        await transaction.mfaRecoveryCode.createMany({
          data: recoveryCodes!.map(code => ({
            userId: user.id,
            codeHash: recoveryCodeHash(user.id, code),
          })),
        })
        await logAuditInTransaction(transaction, user.id, "ADMIN_MFA_ENROLL", user.id, {
          recoveryCodeCount: MFA_RECOVERY_CODE_COUNT,
        })
      } else if (totpStep !== null) {
        const acceptedStep = await transaction.user.updateMany({
          where: {
            id: user.id,
            OR: [
              { mfaLastTotpStep: null },
              { mfaLastTotpStep: { lt: totpStep } },
            ],
          },
          data: { mfaLastTotpStep: totpStep },
        })
        if (acceptedStep.count !== 1) throw new MfaContinuationConflict()
      } else {
        const consumedRecovery = await transaction.mfaRecoveryCode.updateMany({
          where: { id: recovery!.id, userId: user.id, usedAt: null },
          data: { usedAt: now },
        })
        if (consumedRecovery.count !== 1) throw new MfaContinuationConflict()
        await logAuditInTransaction(transaction, user.id, "ADMIN_MFA_RECOVERY_CODE_USE", user.id)
      }

      await createAuthSessionInTransaction(transaction, {
        jti,
        userId: user.id,
        clientType: challenge.clientType,
        deviceLabel: challenge.deviceLabel,
        issuedAt: now,
        expiresAt,
      })
    })
  } catch (error) {
    if (error instanceof MfaContinuationConflict) {
      return NextResponse.json({ error: "MFA challenge or code was already used" }, {
        status: 409,
        headers: responseHeaders(req),
      })
    }
    throw error
  }
  invalidateAccountState(user.id)

  if (challenge.clientType === "NATIVE") {
    return NextResponse.json({
      access_token: token,
      token_type: "Bearer",
      expires_in: AUTH_TOKEN_TTL_SECONDS,
      preferredLocale,
      ...(recoveryCodes ? { recoveryCodes } : {}),
    }, { headers: responseHeaders(req) })
  }

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
      lastLoginAt: now.toISOString(),
    },
    ...(recoveryCodes ? { recoveryCodes } : {}),
  }, { headers: responseHeaders(req) })
  response.cookies.set(AUTH_COOKIE_NAME, token, cookieOptions())
  return response
}
