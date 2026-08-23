import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import {
  ClinicalRuleServiceError,
  clearClinicalRulesetSelection,
  createClinicalRuleset,
  deleteClinicalRulesetRule,
  loadClinicalRulesWorkbench,
  publishClinicalRuleset,
  replacePediatricDrugProfiles,
  selectClinicalRuleset,
  upsertClinicalRulesetRule,
} from "@/lib/clinical-rules/service"
import { getAuthUser } from "@/lib/mobile-auth"

const modeSchema = z.enum(["ADULT", "PEDIATRIC"])
const scopeSchema = z.enum(["PLATFORM", "INSTITUTION", "USER"])
const sensitiveConfirmationSchema = z.object({
  password: z.string().min(1).max(1024),
  reason: z.string().trim().min(10).max(1000),
})

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create-ruleset"),
    scope: scopeSchema,
    clinicalMode: modeSchema,
    key: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1000).nullable().optional(),
    copyFromPresetId: z.string().min(1).nullable().optional(),
    institutionId: z.string().min(1).nullable().optional(),
  }),
  z.object({
    action: z.literal("upsert-rule"),
    presetId: z.string().min(1),
    existingRuleKey: z.string().min(1).nullable().optional(),
    payload: z.unknown(),
  }),
  z.object({
    action: z.literal("replace-pediatric-drug-profiles"),
    presetId: z.string().min(1),
    medicationKey: z.string().trim().min(1).max(160),
    profiles: z.array(z.unknown()).min(1).max(100),
  }),
  z.object({
    action: z.literal("delete-rule"),
    presetId: z.string().min(1),
    ruleKey: z.string().min(1),
  }),
  z.object({
    action: z.literal("publish-ruleset"),
    presetId: z.string().min(1),
    confirmation: sensitiveConfirmationSchema.optional(),
  }),
  z.object({
    action: z.literal("select-ruleset"),
    scope: scopeSchema,
    clinicalMode: modeSchema,
    presetId: z.string().min(1),
    institutionId: z.string().min(1).nullable().optional(),
    confirmation: sensitiveConfirmationSchema.optional(),
  }),
  z.object({
    action: z.literal("clear-selection"),
    scope: scopeSchema,
    clinicalMode: modeSchema,
    institutionId: z.string().min(1).nullable().optional(),
    confirmation: sensitiveConfirmationSchema.optional(),
  }),
])

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const url = new URL(req.url)
  const clinicalMode = modeSchema.safeParse(url.searchParams.get("mode") ?? "ADULT")
  if (!clinicalMode.success) {
    return NextResponse.json({ error: "Invalid clinical mode" }, { status: 400 })
  }
  const rawScope = url.searchParams.get("scope")
  const requestedScope = rawScope === null ? null : scopeSchema.safeParse(rawScope)
  if (requestedScope !== null && !requestedScope.success) {
    return NextResponse.json({ error: "Invalid management scope" }, { status: 400 })
  }
  try {
    return NextResponse.json(
      await loadClinicalRulesWorkbench(
        user,
        requestedScope === null ? null : requestedScope.data,
        clinicalMode.data,
      ),
    )
  } catch (error) {
    if (error instanceof ClinicalRuleServiceError) {
      return NextResponse.json(
        { error: error.message, issues: error.issues },
        { status: error.status },
      )
    }
    console.error("[clinical-rules] Workbench load failed", error)
    return NextResponse.json({ error: "Could not load clinical rules" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const parsed = actionSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", issues: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const body = parsed.data

  try {
    if (body.action === "create-ruleset") {
      const ruleset = await createClinicalRuleset({ actor: user, ...body })
      return NextResponse.json(ruleset, { status: 201 })
    }

    if (body.action === "upsert-rule") {
      const rule = await upsertClinicalRulesetRule({ actor: user, ...body })
      return NextResponse.json(rule)
    }

    if (body.action === "replace-pediatric-drug-profiles") {
      const rules = await replacePediatricDrugProfiles({ actor: user, ...body })
      return NextResponse.json({ rules })
    }

    if (body.action === "delete-rule") {
      await deleteClinicalRulesetRule({ actor: user, ...body })
      return NextResponse.json({ deleted: true })
    }

    if (body.action === "publish-ruleset") {
      const ruleset = await publishClinicalRuleset(user, body.presetId, body.confirmation)
      return NextResponse.json(ruleset)
    }

    if (body.action === "select-ruleset") {
      const selection = await selectClinicalRuleset({ actor: user, ...body })
      return NextResponse.json(selection)
    }

    return NextResponse.json(await clearClinicalRulesetSelection({ actor: user, ...body }))
  } catch (error) {
    if (error instanceof ClinicalRuleServiceError) {
      return NextResponse.json(
        { error: error.message, issues: error.issues },
        { status: error.status },
      )
    }
    console.error("[clinical-rules] Workbench action failed", error)
    return NextResponse.json({ error: "Clinical rule action failed" }, { status: 500 })
  }
}
