import {
  PEDIATRIC_MIN_CLIENT_VERSION,
  PEDIATRIC_PRODUCTION_READY,
  PEDIATRIC_RULESET_VERSION,
  isPediatricAge,
  validatePediatricAge,
  type ClinicalMode,
  type PediatricAgeUnit,
} from "@lospor/core/pediatric"

export type PediatricWriteErrorCode =
  | "PEDIATRIC_MODE_DISABLED"
  | "PEDIATRIC_MODE_REQUIRED"
  | "ADULT_MODE_REQUIRED"
  | "PEDIATRIC_AGE_REQUIRED"
  | "INVALID_PEDIATRIC_AGE"
  | "PEDIATRIC_CLIENT_UPDATE_REQUIRED"

export type PediatricWriteDecision =
  | {
      allowed: true
      clinicalMode: ClinicalMode
      clinicalRulesVersion: string | null
      pediatricModeDecisionRequired: false
    }
  | {
      allowed: false
      status: 409 | 422 | 426 | 503
      code: PediatricWriteErrorCode
      minimumClientVersion?: string
      issues?: ReturnType<typeof validatePediatricAge>
    }

function versionParts(version: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim())
  return match ? match.slice(1).map(Number) : null
}

export function isVersionAtLeast(version: string | null | undefined, minimum: string): boolean {
  if (!version) return false
  const actual = versionParts(version)
  const required = versionParts(minimum)
  if (!actual || !required) return false
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > required[index]) return true
    if (actual[index] < required[index]) return false
  }
  return true
}

export function isPediatricModeEnabled(
  env: Partial<Pick<NodeJS.ProcessEnv, "NODE_ENV" | "PEDIATRIC_MODE_ENABLED">> = process.env,
  productionReady = PEDIATRIC_PRODUCTION_READY,
): boolean {
  if (env.NODE_ENV !== "production") return true
  return productionReady && env.PEDIATRIC_MODE_ENABLED === "true"
}

function preciseAge(preop: Record<string, unknown> | null | undefined): {
  value: number
  unit: PediatricAgeUnit
} | null {
  if (!preop) return null
  const value = preop.ageValue
  const unit = preop.ageUnit
  if (
    typeof value !== "number"
    || !["DAYS", "MONTHS", "YEARS"].includes(String(unit))
  ) {
    return null
  }
  return {
    value,
    unit: unit as PediatricAgeUnit,
  }
}

export type PediatricCaseMutationDecision =
  | {
      allowed: true
    }
  | {
      allowed: false
      status: 426 | 503
      code: "PEDIATRIC_MODE_DISABLED" | "PEDIATRIC_CLIENT_UPDATE_REQUIRED"
      minimumClientVersion?: string
    }

export function decidePediatricCaseMutation(input: {
  clinicalMode: ClinicalMode
  clientVersion?: string | null
  featureEnabled?: boolean
}): PediatricCaseMutationDecision {
  if (input.clinicalMode !== "PEDIATRIC") return { allowed: true }
  if (!(input.featureEnabled ?? isPediatricModeEnabled())) {
    return {
      allowed: false,
      status: 503,
      code: "PEDIATRIC_MODE_DISABLED",
    }
  }
  if (!isVersionAtLeast(input.clientVersion, PEDIATRIC_MIN_CLIENT_VERSION)) {
    return {
      allowed: false,
      status: 426,
      code: "PEDIATRIC_CLIENT_UPDATE_REQUIRED",
      minimumClientVersion: PEDIATRIC_MIN_CLIENT_VERSION,
    }
  }
  return { allowed: true }
}

export function decidePediatricWrite(input: {
  clinicalMode: ClinicalMode
  preop?: Record<string, unknown> | null
  currentPreop?: Record<string, unknown> | null
  clientVersion?: string | null
  featureEnabled?: boolean
  enforceAgeDecision: boolean
  allowIncompleteAge?: boolean
}): PediatricWriteDecision {
  const effectivePreop = { ...(input.currentPreop ?? {}), ...(input.preop ?? {}) }
  const age = preciseAge(effectivePreop)
  const legacyAgeYears = typeof effectivePreop.ageYears === "number"
    ? effectivePreop.ageYears
    : null
  const under18 = age
    ? isPediatricAge(age)
    : legacyAgeYears != null && legacyAgeYears < 18

  if (input.clinicalMode === "ADULT" && under18 && input.enforceAgeDecision) {
    return { allowed: false, status: 409, code: "PEDIATRIC_MODE_REQUIRED" }
  }
  if (input.clinicalMode === "PEDIATRIC") {
    const mutation = decidePediatricCaseMutation(input)
    if (!mutation.allowed) return mutation
    if (!age) {
      if (input.allowIncompleteAge) {
        return {
          allowed: true,
          clinicalMode: "PEDIATRIC",
          clinicalRulesVersion: PEDIATRIC_RULESET_VERSION,
          pediatricModeDecisionRequired: false,
        }
      }
      return { allowed: false, status: 422, code: "PEDIATRIC_AGE_REQUIRED" }
    }
    const issues = validatePediatricAge(age)
    if (issues.some(issue => issue.severity === "ERROR")) {
      return { allowed: false, status: 422, code: "INVALID_PEDIATRIC_AGE", issues }
    }
    if (!isPediatricAge(age)) {
      return { allowed: false, status: 409, code: "ADULT_MODE_REQUIRED" }
    }
    return {
      allowed: true,
      clinicalMode: "PEDIATRIC",
      clinicalRulesVersion: PEDIATRIC_RULESET_VERSION,
      pediatricModeDecisionRequired: false,
    }
  }
  return {
    allowed: true,
    clinicalMode: "ADULT",
    clinicalRulesVersion: null,
    pediatricModeDecisionRequired: false,
  }
}

export function pediatricCapabilities() {
  return {
    enabled: isPediatricModeEnabled(),
    productionReady: PEDIATRIC_PRODUCTION_READY,
    rulesetVersion: PEDIATRIC_RULESET_VERSION,
    minimumClientVersion: PEDIATRIC_MIN_CLIENT_VERSION,
    reviewedDoseProfilesRequired: true,
  }
}
