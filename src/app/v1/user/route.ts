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
      id: true, firstName: true, lastName: true, title: true, role: true,
      preferences: true,
      institutionId: true, institution: { select: { id: true, name: true, city: true } },
    },
  })
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404, headers: CORS(req) })
  return NextResponse.json({
    ...record,
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

const patchSchema = z.object({
  institutionId: z.union([z.string().cuid(), z.literal(""), z.null()]).optional(),
  preferences: preferencesPatchSchema.optional(),
})

function asPreferenceObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export async function PATCH(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const userId = user.id

  try {
    const body = patchSchema.parse(await req.json())
    const existing = body.preferences ? await prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    }) : null
    const currentPreferences = asPreferenceObject(existing?.preferences)
    const nextPreferences = body.preferences
      ? {
          ...currentPreferences,
          ...applyClinicalPreferencesPatch(currentPreferences, body.preferences),
        }
      : undefined

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(body.institutionId !== undefined ? { institutionId: body.institutionId === "" ? null : body.institutionId } : {}),
        ...(nextPreferences ? { preferences: nextPreferences as Prisma.InputJsonValue } : {}),
      },
      select: {
        preferences: true,
        institution: { select: { id: true, name: true, city: true } },
      },
    })
    return NextResponse.json({ ok: true, institution: updated.institution, preferences: updated.preferences }, { headers: CORS(req) })
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: "Invalid request" }, { status: 400, headers: CORS(req) })
    console.error("[PATCH /api/user]", err)
    return NextResponse.json({ error: "Internal server error" }, { status: 500, headers: CORS(req) })
  }
}
