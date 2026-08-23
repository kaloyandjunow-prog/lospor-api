import { NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/cors"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { Prisma } from "@/generated/prisma/client"
import {
  applyClinicalPreferencesPatch,
  normalizeClinicalPreferences,
} from "@lospor/core/clinical-preferences"
import {
  preferredLocaleFromPreferences,
  preferencesWithPreferredLocale,
} from "@lospor/core/account"
import { invalidateAccountState } from "@/lib/password-epoch"
import { buildDisplayName, normalizeIdentityPart } from "@/lib/account-profile"
import { logAuditInTransaction } from "@/lib/audit"

const CORS = (req: NextRequest) => corsHeaders(req, "GET, PATCH, OPTIONS")

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: CORS(req) })
  const record = await prisma.user.findUnique({
    where: { id: user.id },
    select: {
      id: true, email: true, username: true, name: true, firstName: true, lastName: true, title: true,
      role: true, accountKind: true,
      preferences: true,
      institutionId: true, institution: { select: { id: true, name: true, city: true } },
    },
  })
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404, headers: CORS(req) })
  return NextResponse.json({
    ...record,
    preferredLocale: preferredLocaleFromPreferences(record.preferences),
    clinicalPreferences: normalizeClinicalPreferences(record.preferences),
  }, { headers: CORS(req) })
}

const unitsPatchSchema = z.object({
  height: z.enum(["cm", "in"]).optional(),
  weight: z.enum(["kg", "lb"]).optional(),
  temperature: z.enum(["C", "F"]).optional(),
  etco2: z.enum(["mmHg", "kPa"]).optional(),
}).strict()

const autoFillPatchSchema = z.object({
  enabled: z.boolean().optional(),
  includeBloodPressure: z.boolean().optional(),
  backfillOnReopen: z.boolean().optional(),
}).strict()

const preferencesPatchSchema = z.object({
  ui: z.object({ locale: z.enum(["bg", "en"]) }).partial().strict().optional(),
  clinicalPreferencesVersion: z.number().int().optional(),
  units: unitsPatchSchema.optional(),
  defaultMonitoring: z.enum(["standard", "advanced"]).optional(),
  autoFillVitals: z.union([z.boolean(), autoFillPatchSchema]).optional(),
  intraopFavouriteDrugs: z.array(z.string()).optional(),
  intraopFavouriteInfusions: z.array(z.string()).optional(),
  heightUnit: z.enum(["cm", "in"]).optional(),
  weightUnit: z.enum(["kg", "lb"]).optional(),
  temperatureUnit: z.enum(["C", "F"]).optional(),
  etco2Unit: z.enum(["mmHg", "kPa"]).optional(),
  autoFillBP: z.boolean().optional(),
  autoFillBackground: z.boolean().optional(),
  autoFillBg: z.boolean().optional(),
}).passthrough()

/**
 * Institution is deliberately not self-editable.
 *
 * Departmental visibility is built on it: a head of department sees the cases of
 * their institution. While any authenticated user could change their own
 * institutionId, they could move themselves into another hospital's department
 * at will, and the boundary meant nothing. Membership is set at registration and
 * changed by an administrator.
 */
const patchSchema = z.object({
  preferences: preferencesPatchSchema.optional(),
  firstName: z.string().trim().min(1).max(100).optional(),
  lastName: z.string().trim().min(1).max(100).optional(),
  title: z.string().trim().max(100).optional(),
}).strict().refine(value => (
  value.preferences !== undefined
  || value.firstName !== undefined
  || value.lastName !== undefined
  || value.title !== undefined
), { message: "At least one account field is required" })

function asPreferenceObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export async function PATCH(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = user.id

  try {
    const body = patchSchema.parse(await req.json())
    const identityChanged = body.firstName !== undefined
      || body.lastName !== undefined
      || body.title !== undefined
    const existing = (body.preferences || identityChanged) ? await prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true, firstName: true, lastName: true, title: true },
    }) : null
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404, headers: CORS(req) })
    const currentPreferences = asPreferenceObject(existing?.preferences)
    let nextPreferences: Record<string, unknown> | undefined = body.preferences
      ? {
          ...currentPreferences,
          ...applyClinicalPreferencesPatch(currentPreferences, body.preferences),
        }
      : undefined
    if (nextPreferences && body.preferences?.ui?.locale) {
      nextPreferences = preferencesWithPreferredLocale(
        nextPreferences,
        body.preferences.ui.locale,
      )
    }

    const identity = {
      firstName: normalizeIdentityPart(body.firstName ?? existing.firstName),
      lastName: normalizeIdentityPart(body.lastName ?? existing.lastName),
      title: normalizeIdentityPart(body.title ?? existing.title),
    }
    const changedFields = (["firstName", "lastName", "title"] as const)
      .filter(field => identity[field] !== existing[field])

    const updated = identityChanged
      ? await prisma.$transaction(async transaction => {
          const record = await transaction.user.update({
            where: { id: userId },
            data: {
              // institutionId, email, and username remain governed separately.
              ...identity,
              name: buildDisplayName(identity),
              ...(nextPreferences ? { preferences: nextPreferences as Prisma.InputJsonValue } : {}),
            },
            select: {
              firstName: true,
              lastName: true,
              title: true,
              name: true,
              preferences: true,
              institution: { select: { id: true, name: true, city: true } },
            },
          })
          if (changedFields.length) {
            await logAuditInTransaction(
              transaction,
              userId,
              "PROFILE_CORRECTION",
              userId,
              { changedFields },
            )
          }
          return record
        })
      : await prisma.user.update({
          where: { id: userId },
          data: {
            ...(nextPreferences ? { preferences: nextPreferences as Prisma.InputJsonValue } : {}),
          },
          select: {
            firstName: true,
            lastName: true,
            title: true,
            name: true,
            preferences: true,
            institution: { select: { id: true, name: true, city: true } },
          },
        })
    if (body.preferences?.ui?.locale || changedFields.length) invalidateAccountState(userId)
    return NextResponse.json({
      ok: true,
      name: updated.name,
      firstName: updated.firstName,
      lastName: updated.lastName,
      title: updated.title,
      institution: updated.institution,
      preferences: updated.preferences,
      preferredLocale: preferredLocaleFromPreferences(updated.preferences),
    }, { headers: CORS(req) })
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: CORS(req) })
    console.error("[PATCH /api/user]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: CORS(req) })
  }
}
