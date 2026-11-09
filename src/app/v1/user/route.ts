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
      preferencesRevision: true,
      institutionId: true, institution: { select: { id: true, name: true, city: true } },
    },
  })
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404, headers: CORS(req) })
  return NextResponse.json({
    ...record,
    preferredLocale: preferredLocaleFromPreferences(record.preferences),
    clinicalPreferences: normalizeClinicalPreferences(record.preferences),
    preferencesRevision: record.preferencesRevision,
  }, { headers: CORS(req) })
}

const unitsPatchSchema = z.object({
  height: z.enum(["cm", "in"]).optional(),
  weight: z.enum(["kg", "lb"]).optional(),
  temperature: z.enum(["C", "F"]).optional(),
  etco2: z.enum(["mmHg", "kPa"]).optional(),
  // Core's ClinicalUnits carries a fifth unit. This schema is strict, so
  // omitting cvp did not ignore it -- it rejected the whole request, and a
  // client that sends its full preferences object always sends cvp. Every
  // preference sync from such a client failed with 400 until this line existed.
  cvp: z.enum(["cmH2O", "mmHg"]).optional(),
}).strict()

const autoFillPatchSchema = z.object({
  enabled: z.boolean().optional(),
  includeBloodPressure: z.boolean().optional(),
  backfillOnReopen: z.boolean().optional(),
}).strict()

const caseLayoutPatchSchema = z.object({
  sidebar: z.boolean().optional(),
  preop: z.enum(["tabs", "scroll"]).optional(),
  intraop: z.enum(["tabs", "scroll"]).optional(),
  postop: z.enum(["tabs", "scroll"]).optional(),
}).strict()

// Which catalogues show Bulgarian names (Settings → UI); display only.
const bulgarianNamesPatchSchema = z.object({
  premed: z.boolean().optional(),
  drugs: z.boolean().optional(),
  infusions: z.boolean().optional(),
  agents: z.boolean().optional(),
  fluids: z.boolean().optional(),
}).strict()

const preferencesPatchSchema = z.object({
  ui: z.object({ locale: z.enum(["bg", "en"]) }).partial().strict().optional(),
  clinicalPreferencesVersion: z.number().int().optional(),
  units: unitsPatchSchema.optional(),
  defaultMonitoring: z.enum(["standard", "advanced"]).optional(),
  autoFillVitals: z.union([z.boolean(), autoFillPatchSchema]).optional(),
  intraopFavouriteDrugs: z.array(z.string()).optional(),
  intraopFavouriteInfusions: z.array(z.string()).optional(),
  bulgarianNames: bulgarianNamesPatchSchema.optional(),
  heightUnit: z.enum(["cm", "in"]).optional(),
  weightUnit: z.enum(["kg", "lb"]).optional(),
  temperatureUnit: z.enum(["C", "F"]).optional(),
  etco2Unit: z.enum(["mmHg", "kPa"]).optional(),
  autoFillBP: z.boolean().optional(),
  autoFillBackground: z.boolean().optional(),
  autoFillBg: z.boolean().optional(),
  // 10.2.0: the suggestion groups a clinician has turned off for themselves
  // (only a group the hospital has on can be), and the energy knob's look.
  automationGroups: z.record(z.string(), z.boolean()).optional(),
  // 10.2.0: individual suggestion switches, including opt-in context links.
  automationLines: z.record(z.string().min(1).max(160), z.boolean()).optional(),
  energyKnobSkin: z.enum(["A", "B", "C"]).optional(),
  // 10.2.0: Smart selection or the legacy Airway tab.
  airwayScreen: z.enum(["smart", "legacy"]).optional(),
  vascularScreen: z.enum(["smart", "legacy"]).optional(),
  monitoringScreen: z.enum(["smart", "legacy"]).optional(),
  equipmentScreen: z.enum(["smart", "legacy"]).optional(),
  techniqueScreen: z.enum(["smart", "legacy"]).optional(),
  eventsScreen: z.enum(["smart", "legacy"]).optional(),
  fluidsScreen: z.enum(["smart", "legacy"]).optional(),
  eventLogScreen: z.enum(["smart", "legacy"]).optional(),
  // Account-wide case shell choices shared by web and mobile.
  caseLayout: caseLayoutPatchSchema.optional(),
  timetableLayout: z.enum(["expand", "scroll"]).optional(),
  vitalsChartExpanded: z.boolean().optional(),
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
  /** Revision returned by GET /api/user. Required by clients that want a
   * stale full-preferences write rejected instead of merged over newer data. */
  preferencesRevision: z.number().int().nonnegative().optional(),
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

const isPrismaRecordNotFound = (value: unknown): boolean =>
  value != null && typeof value === "object" && "code" in value && value.code === "P2025"

export async function PATCH(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = user.id
  let body: z.infer<typeof patchSchema> | null = null

  try {
    body = patchSchema.parse(await req.json())
    const identityChanged = body.firstName !== undefined
      || body.lastName !== undefined
      || body.title !== undefined
    const existing = (body.preferences || identityChanged) ? await prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true, preferencesRevision: true, firstName: true, lastName: true, title: true },
    }) : null
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404, headers: CORS(req) })
    const currentPreferences = asPreferenceObject(existing?.preferences)
    const currentPreferencesRevision = Number.isInteger(existing.preferencesRevision) ? existing.preferencesRevision : 0
    if (body.preferences !== undefined
      && body.preferencesRevision !== undefined
      && body.preferencesRevision !== currentPreferencesRevision) {
      return NextResponse.json({
        error: "Preferences changed on another device",
        code: "PREFERENCES_CONFLICT",
        preferences: existing.preferences,
        preferencesRevision: currentPreferencesRevision,
      }, { status: 409, headers: CORS(req) })
    }
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
            where: { id: userId, ...(nextPreferences ? { preferencesRevision: currentPreferencesRevision } : {}) },
            data: {
              // institutionId, email, and username remain governed separately.
              ...identity,
              name: buildDisplayName(identity),
              ...(nextPreferences ? {
                preferences: nextPreferences as Prisma.InputJsonValue,
                preferencesRevision: currentPreferencesRevision + 1,
              } : {}),
            },
            select: {
              firstName: true,
              lastName: true,
              title: true,
              name: true,
              preferences: true,
              preferencesRevision: true,
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
          where: { id: userId, ...(nextPreferences ? { preferencesRevision: currentPreferencesRevision } : {}) },
          data: {
            ...(nextPreferences ? {
              preferences: nextPreferences as Prisma.InputJsonValue,
              preferencesRevision: currentPreferencesRevision + 1,
            } : {}),
          },
          select: {
            firstName: true,
            lastName: true,
            title: true,
            name: true,
            preferences: true,
            preferencesRevision: true,
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
      preferencesRevision: updated.preferencesRevision,
      preferredLocale: preferredLocaleFromPreferences(updated.preferences),
    }, { headers: CORS(req) })
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: CORS(req) })
    if (body?.preferences !== undefined && isPrismaRecordNotFound(err)) {
      const latest = await prisma.user.findUnique({
        where: { id: userId },
        select: { preferences: true, preferencesRevision: true },
      })
      if (latest) return NextResponse.json({
        error: "Preferences changed on another device",
        code: "PREFERENCES_CONFLICT",
        preferences: latest.preferences,
        preferencesRevision: latest.preferencesRevision,
      }, { status: 409, headers: CORS(req) })
    }
    console.error("[PATCH /api/user]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: CORS(req) })
  }
}
