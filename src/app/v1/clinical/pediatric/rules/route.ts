import { NextRequest, NextResponse } from "next/server"
import {
  APAGBI_FASTING_POLICY_2023,
  PEDIATRIC_PRODUCTION_READY,
  PEDIATRIC_RULESET_VERSION,
  PEDIATRIC_SOURCE_REFERENCES,
} from "@lospor/core/pediatric"
import { createPediatricRuleManifest } from "@lospor/core/pediatric-dose"
import {
  pediatricDoseProfilesFromRules,
  pediatricDrugProfilesFromRules,
  pediatricFluidProfilesFromRules,
  pediatricInfusionProfilesFromRules,
} from "@lospor/core/clinical-rules"
import { getAuthUser } from "@/lib/mobile-auth"
import { pediatricCapabilities } from "@/lib/pediatric-mode"
import { effectiveClinicalRulesForUser } from "@/lib/clinical-rules/service"

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const effective = await effectiveClinicalRulesForUser(user, "PEDIATRIC")
  const doseProfiles = pediatricDoseProfilesFromRules(effective.rules)
  const pediatricDrugProfiles = pediatricDrugProfilesFromRules(effective.rules)
  const pediatricFluidProfiles = pediatricFluidProfilesFromRules(effective.rules)
  const pediatricInfusionProfiles = pediatricInfusionProfilesFromRules(effective.rules)

  return NextResponse.json({
    ...pediatricCapabilities(),
    rulesetVersion: PEDIATRIC_RULESET_VERSION,
    productionReady: PEDIATRIC_PRODUCTION_READY,
    sources: Object.values(PEDIATRIC_SOURCE_REFERENCES),
    fastingPolicies: [APAGBI_FASTING_POLICY_2023],
    preset: effective.presetId
      ? {
          id: effective.presetId,
          name: effective.presetName!,
          version: effective.presetVersion!,
          scope: effective.scope!,
        }
      : null,
    effectiveRules: effective.rules,
    pediatricDrugProfiles,
    pediatricInfusionProfiles,
    pediatricFluidProfiles,
    // Kept for clients that still understand the retired one-route rule shape.
    doseProfiles,
    manifest: createPediatricRuleManifest(doseProfiles),
    unavailableWithoutReviewedProfile: [
      "LOCAL_ANAESTHETIC_LIMIT",
      "ESTIMATED_BLOOD_VOLUME",
      "ALLOWABLE_BLOOD_LOSS",
      "VENTILATION_SETTING",
      ...(pediatricDrugProfiles.length || doseProfiles.length ? [] : ["PEDIATRIC_DOSE"]),
    ],
  })
}
