import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import bcrypt from "bcryptjs"
import { z } from "zod"
import { rateLimit } from "@/lib/rate-limit"
import { corsHeaders } from "@/lib/cors"
import { createAuthToken, EMAIL_VERIFICATION_TTL_MS, emailSchema, hashAuthToken, normalizeEmail, tokenExpiry } from "@/lib/auth-email-tokens"
import { appUrl, sendVerificationEmail } from "@/lib/transactional-email"
import { preferencesWithPreferredLocale } from "@lospor/core/account"
import { passwordSchema } from "@/lib/password-policy"
import type { Prisma } from "@/generated/prisma/client"
import { legalAcceptancesSchema } from "@/lib/legal-request"
import {
  LegalAcceptanceError,
  LegalConfigurationError,
  legalAcceptanceAuditDetail,
  legalAcceptanceCreateMany,
} from "@/lib/legal-documents"
import { logAuditInTransaction } from "@/lib/audit"
import {
  authenticationCapabilities,
  publicEmailAuthenticationRefusal,
} from "@/lib/deployment-capabilities"

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req, "POST, OPTIONS", "Content-Type, Authorization") })
}

const schema = z.object({
  title:          z.string().optional(),
  firstName:      z.string().min(1, "First name required"),
  lastName:       z.string().min(1, "Last name required"),
  email:          emailSchema,
  // Required. An account with no institution produced cases stamped with no
  // institution, and those became visible to whichever department the author
  // later joined. Anyone without a department picks "Без институция"
  // (NO_INSTITUTION_ID), which is a real institution that cannot have a head.
  // Not .cuid(): NO_INSTITUTION_ID is a fixed readable id, not a generated one.
  institutionId:  z.string().min(1),
  locale:          z.enum(["bg", "en"]).optional(),
  legalAcceptances: legalAcceptancesSchema,
  password: passwordSchema,
})

export async function POST(req: NextRequest) {
  const deploymentRefusal = publicEmailAuthenticationRefusal()
  if (deploymentRefusal) {
    return NextResponse.json(deploymentRefusal.body, { status: deploymentRefusal.status })
  }
  if (!authenticationCapabilities().selfRegistration) {
    return NextResponse.json({
      error: "Self-registration is disabled for this deployment",
      code: "SELF_REGISTRATION_DISABLED_BY_DEPLOYMENT",
    }, { status: 404 })
  }
  const ip = req.headers.get("x-forwarded-for") ?? "unknown"
  const rl = await rateLimit(`register:${ip}`, 5, 60 * 60 * 1000)
  if (!rl.allowed) {
    return NextResponse.json({ error: "Too many requests" }, {
      status: 429, headers: { "Retry-After": String(rl.retryAfter) },
    })
  }

  try {
    const body = await req.json()
    const data = schema.parse(body)
    const email = normalizeEmail(data.email)

    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) {
      return NextResponse.json({ error: "Email already registered" }, { status: 409 })
    }

    const institution = await prisma.institution.findUnique({ where: { id: data.institutionId } })
    if (!institution) {
      return NextResponse.json({ error: "Institution not found" }, { status: 404 })
    }

    const acceptanceLocale = data.legalAcceptances[0]?.locale
    if (data.locale && data.locale !== acceptanceLocale) {
      return NextResponse.json(
        { error: "Account locale must match the accepted documents", code: "LEGAL_LOCALE_MISMATCH" },
        { status: 422 },
      )
    }
    const preferredLocale = data.locale ?? acceptanceLocale ?? "bg"

    const passwordHash = await bcrypt.hash(data.password, 12)
    const name = [data.title, data.firstName, data.lastName].filter(Boolean).join(" ")

    const token = createAuthToken()
    const acceptedAt = new Date()
    const user = await prisma.$transaction(async transaction => {
      const created = await transaction.user.create({
        data: {
          name,
          firstName:       data.firstName,
          lastName:        data.lastName,
          title:           data.title ?? "",
          email,
          passwordHash,
          institutionId:   data.institutionId,
          role:            "MEMBER",
          accountKind:     "CLINICAL",
          activatedAt:     null,
          emailVerifiedAt: null,
          preferences:     preferencesWithPreferredLocale({}, preferredLocale) as Prisma.InputJsonValue,
          acceptedTermsAt: acceptedAt,
          acceptedPrivacyAt: acceptedAt,
          termsVersion: data.legalAcceptances.find(item => item.kind === "TERMS")?.version,
          emailVerificationTokens: {
            create: {
              tokenHash: hashAuthToken(token),
              expiresAt: tokenExpiry(EMAIL_VERIFICATION_TTL_MS),
            },
          },
        },
      })
      const legalRows = legalAcceptanceCreateMany(created.id, data.legalAcceptances)
        .map(row => ({ ...row, acceptedAt }))
      await transaction.legalAcceptance.createMany({ data: legalRows })
      await logAuditInTransaction(transaction, created.id, "ACCOUNT_PROVISION", created.id, {
        provisioningChannel: "SELF_REGISTRATION",
        institutionId: data.institutionId,
        role: "MEMBER",
        accountKind: "CLINICAL",
      })
      await logAuditInTransaction(
        transaction,
        created.id,
        "LEGAL_ACCEPTANCE_RECORD",
        created.id,
        legalAcceptanceAuditDetail(legalRows),
      )
      return created
    })

    const verifyUrl = appUrl(`/verify-email?token=${encodeURIComponent(token)}`)
    let emailSent = false
    try {
      const result = await sendVerificationEmail({ email, name: user.name }, verifyUrl)
      emailSent = result.sent
    } catch (err) {
      console.error("[register.verify-email]", err)
    }

    const exposeTestLink = process.env.NODE_ENV !== "production" && (process.env.AUTH_EMAIL_TEST_LINKS === "true" || !process.env.BREVO_API_KEY)
    return NextResponse.json({
      id: user.id,
      email,
      verificationRequired: true,
      emailSent,
      ...(exposeTestLink ? { devVerifyUrl: verifyUrl } : {}),
    }, { status: 201 })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.issues[0]?.message ?? "Validation error" }, { status: 400 })
    }
    if (err instanceof LegalAcceptanceError || err instanceof LegalConfigurationError) {
      return NextResponse.json(
        { error: err.message, code: err.code, ...(err instanceof LegalAcceptanceError ? { details: err.details } : {}) },
        { status: err.status },
      )
    }
    console.error("[register]", err)
    const msg = "Internal server error"
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
