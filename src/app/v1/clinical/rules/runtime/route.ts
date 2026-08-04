import { NextRequest, NextResponse } from "next/server"
import {
  adultDoseProfilesFromRules,
  pediatricDrugProfilesFromRules,
  pediatricDoseProfilesFromRules,
  pediatricFluidProfilesFromRules,
  pediatricInfusionProfilesFromRules,
} from "@lospor/core/clinical-rules"
import { getAuthUser } from "@/lib/mobile-auth"
import { effectiveClinicalRulesForUser } from "@/lib/clinical-rules/service"

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const mode = new URL(req.url).searchParams.get("mode") ?? "ADULT"
  if (mode !== "ADULT" && mode !== "PEDIATRIC") {
    return NextResponse.json({ error: "Invalid clinical mode" }, { status: 400 })
  }
  const effective = await effectiveClinicalRulesForUser(user, mode)
  const pediatricProfiles = mode === "PEDIATRIC"
    ? pediatricDoseProfilesFromRules(effective.rules)
    : []
  const pediatricDrugProfiles = mode === "PEDIATRIC"
    ? pediatricDrugProfilesFromRules(effective.rules)
    : []
  const pediatricFluidProfiles = mode === "PEDIATRIC"
    ? pediatricFluidProfilesFromRules(effective.rules)
    : []
  const pediatricInfusionProfiles = mode === "PEDIATRIC"
    ? pediatricInfusionProfilesFromRules(effective.rules)
    : []
  const adultProfiles = mode === "ADULT"
    ? adultDoseProfilesFromRules(effective.rules)
    : []

  return NextResponse.json({
    mode,
    preset: effective.presetId
      ? {
          id: effective.presetId,
          name: effective.presetName!,
          version: effective.presetVersion!,
          scope: effective.scope!,
        }
      : null,
    productionReady: mode === "ADULT"
      ? adultProfiles.length > 0
      : pediatricDrugProfiles.length > 0
        || pediatricInfusionProfiles.length > 0
        || pediatricFluidProfiles.length > 0
        || pediatricProfiles.length > 0,
    effectiveRules: effective.rules,
    pediatricDrugProfiles,
    pediatricInfusionProfiles,
    pediatricFluidProfiles,
    // Legacy indication/route rows remain available during the staged client
    // rollout. New clients use pediatricDrugProfiles exclusively.
    doseProfiles: pediatricProfiles,
    adultDoseProfiles: adultProfiles,
  })
}
