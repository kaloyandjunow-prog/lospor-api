import type {
  ClinicalPresetScope,
  ClinicalRulePayload,
} from "@lospor/core/clinical-rules"

/**
 * Scope guard for clinical rule authoring.
 *
 * Only platform administrators may touch the *schema*: which drugs, fluids and
 * infusions exist, their canonical units and routes, and their EN/BG display
 * names. Institution (HOD) and personal (member) layers may only tune how the
 * dosing widget *presents* — slider bounds, quick-dose pills, autofill, default
 * concentration, ordering and visibility.
 *
 * The rule of thumb enforced here: lower layers may NARROW, never INVENT.
 * Anything else would let a personal preference introduce a value that is not
 * canonical, which would break research-grade data downstream.
 */

export type ScopeGuardIssue = { field: string; message: string }

/** Fields that define what a thing *is*. Platform administrators only. */
const SCHEMA_FIELDS = ["labelEn", "labelBg", "inn", "category"] as const

type LooseProfile = {
  routes?: string[]
  min?: number
  max?: number
  concentrationOptions?: string[]
  routeModes?: Record<string, {
    min?: number
    max?: number
    unit?: string
    concentrationOptions?: string[]
  }>
} | null | undefined

/** Structural reads only — the payload union is validated as canonical elsewhere. */
function asRecord(payload: ClinicalRulePayload): Record<string, unknown> {
  return payload as unknown as Record<string, unknown>
}

function profileOf(payload: ClinicalRulePayload): LooseProfile {
  const value = asRecord(payload).profile
  return (value ?? null) as LooseProfile
}

/** The catalog identity of the item this rule is about. */
export function ruleItemKey(payload: ClinicalRulePayload): string {
  const record = asRecord(payload)
  const key = record.medicationKey ?? record.itemKey
  return typeof key === "string" ? key.trim().toUpperCase() : ""
}

function routesOf(payload: ClinicalRulePayload): string[] {
  return profileOf(payload)?.routes ?? []
}

function boundsOf(payload: ClinicalRulePayload, route: string) {
  const profile = profileOf(payload)
  const routeMode = profile?.routeModes?.[route]
  return {
    min: routeMode?.min ?? profile?.min,
    max: routeMode?.max ?? profile?.max,
  }
}

function concentrationsOf(payload: ClinicalRulePayload, route: string): string[] {
  const profile = profileOf(payload)
  return profile?.routeModes?.[route]?.concentrationOptions
    ?? profile?.concentrationOptions
    ?? []
}

function unitsOf(payload: ClinicalRulePayload) {
  const record = asRecord(payload)
  return {
    unit: record.unit ?? null,
    routeUnits: JSON.stringify(record.routeUnits ?? {}),
    doseUnit: record.doseUnit ?? null,
  }
}

/**
 * Returns the reasons this payload may not be authored at this scope.
 * An empty array means the edit is allowed.
 *
 * `baseline` is the platform rule for the same rule key, or null when the
 * platform layer does not define this item at all.
 */
export function scopeGuardIssues(input: {
  scope: ClinicalPresetScope
  next: ClinicalRulePayload
  baseline: ClinicalRulePayload | null
}): ScopeGuardIssue[] {
  // Platform administrators own the schema and may author anything.
  if (input.scope === "PLATFORM") return []

  const { next, baseline } = input
  const layer = input.scope === "INSTITUTION" ? "institution" : "personal"

  if (!baseline) {
    return [{
      field: "itemKey",
      message: `New drugs, fluids and infusions can only be introduced by a platform administrator. `
        + `An ${layer} ruleset may only adjust items that already exist in the platform ruleset.`,
    }]
  }

  const issues: ScopeGuardIssue[] = []
  const nextRecord = asRecord(next)
  const baseRecord = asRecord(baseline)

  if (ruleItemKey(next) !== ruleItemKey(baseline)) {
    issues.push({
      field: "itemKey",
      message: "The catalog item of a rule cannot be changed outside the platform ruleset.",
    })
  }

  for (const field of SCHEMA_FIELDS) {
    if (field in nextRecord || field in baseRecord) {
      const nextValue = nextRecord[field] ?? null
      const baseValue = baseRecord[field] ?? null
      if (nextValue !== baseValue) {
        issues.push({
          field,
          message: field === "labelEn" || field === "labelBg"
            ? "Display names are maintained by platform administrators and cannot be changed here."
            : `"${field}" is part of the catalog schema and cannot be changed outside the platform ruleset.`,
        })
      }
    }
  }

  const nextUnits = unitsOf(next)
  const baseUnits = unitsOf(baseline)
  if (nextUnits.unit !== baseUnits.unit
    || nextUnits.routeUnits !== baseUnits.routeUnits
    || nextUnits.doseUnit !== baseUnits.doseUnit) {
    issues.push({
      field: "unit",
      message: "Canonical units are fixed by the platform ruleset so recorded doses stay comparable across the register.",
    })
  }

  const baseRoutes = new Set(routesOf(baseline))
  const invented = routesOf(next).filter(route => !baseRoutes.has(route))
  if (invented.length) {
    issues.push({
      field: "routes",
      message: `Routes ${invented.join(", ")} are not in the platform ruleset. `
        + "Existing routes may be removed or reordered, but new ones are added by platform administrators.",
    })
  }

  // Narrow, never widen: a lower layer may tighten a slider but not extend it
  // beyond the clinically reviewed platform envelope.
  for (const route of routesOf(next)) {
    if (!baseRoutes.has(route)) continue
    const nextBounds = boundsOf(next, route)
    const baseBounds = boundsOf(baseline, route)
    if (
      typeof nextBounds.min === "number" && typeof baseBounds.min === "number"
      && nextBounds.min < baseBounds.min
    ) {
      issues.push({
        field: `routeModes.${route}.min`,
        message: `The ${route} minimum cannot go below the platform minimum of ${baseBounds.min}.`,
      })
    }
    if (
      typeof nextBounds.max === "number" && typeof baseBounds.max === "number"
      && nextBounds.max > baseBounds.max
    ) {
      issues.push({
        field: `routeModes.${route}.max`,
        message: `The ${route} maximum cannot go above the platform maximum of ${baseBounds.max}.`,
      })
    }

    const allowed = new Set(concentrationsOf(baseline, route))
    const newConcentrations = concentrationsOf(next, route).filter(item => !allowed.has(item))
    if (newConcentrations.length) {
      issues.push({
        field: `routeModes.${route}.concentrationOptions`,
        message: `Concentrations ${newConcentrations.join(", ")} are not in the platform ruleset. `
          + "Concentrations may be removed or reordered, but new ones are added by platform administrators.",
      })
    }
  }

  return issues
}
