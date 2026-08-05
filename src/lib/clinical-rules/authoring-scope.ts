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

/**
 * Whether this rule makes the app *suggest* a dose.
 *
 * The property worth protecting is automatic dosing, not visibility. A lower
 * layer may always withdraw a drug or take away its automatic dose — the hiding
 * escape hatch institutions rely on — and may also unhide one for manual entry,
 * because a register has to be able to record a drug that was actually given.
 * What it may not do is switch on an automatic dose for something the platform
 * ruleset withheld or deliberately left to the clinician.
 */
function suggestsADose(payload: ClinicalRulePayload): boolean {
  const value = asRecord(payload).availability
  return (typeof value === "string" ? value : "AUTO") === "AUTO"
}

type LooseDoseCalc = {
  perKg?: number
  perM2?: number
  flat?: number
  cap?: number
  roundTo?: number
  basis?: string
  capAtActualWeight?: boolean
} | null | undefined

type LooseProfile = {
  routes?: string[]
  min?: number
  max?: number
  concentrationOptions?: string[]
  quickValues?: number[]
  weightBasis?: string
  doseCalc?: LooseDoseCalc
  doseCalcByRoute?: Record<string, LooseDoseCalc>
  routeModes?: Record<string, {
    min?: number
    max?: number
    unit?: string
    concentrationOptions?: string[]
    quickValues?: number[]
    weightBasis?: string
    doseCalc?: LooseDoseCalc
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

function quickValuesOf(payload: ClinicalRulePayload, route: string): number[] {
  const profile = profileOf(payload)
  return profile?.routeModes?.[route]?.quickValues ?? profile?.quickValues ?? []
}

/** The calculation actually used for a route, resolved the way the app resolves it. */
function doseCalcOf(payload: ClinicalRulePayload, route: string): LooseDoseCalc {
  const profile = profileOf(payload)
  return profile?.routeModes?.[route]?.doseCalc
    ?? profile?.doseCalcByRoute?.[route]
    ?? profile?.doseCalc
}

function weightBasisOf(payload: ClinicalRulePayload, route: string): string | null {
  const profile = profileOf(payload)
  return profile?.routeModes?.[route]?.weightBasis ?? profile?.weightBasis ?? null
}

/** Payload-level age band. Absent on rule kinds that are not age-banded. */
function ageBandOf(payload: ClinicalRulePayload) {
  const record = asRecord(payload)
  return {
    min: typeof record.minimumAgeDays === "number" ? record.minimumAgeDays : null,
    maxExclusive: typeof record.maximumAgeDaysExclusive === "number"
      ? record.maximumAgeDaysExclusive
      : null,
  }
}

/**
 * A comparison that survives a round trip through JSON and zod.
 *
 * A unit is an object — { amount, display, ucumCode, bodyBasis, timeBasis } —
 * not a string. Comparing those with !== compares references, so two units that
 * say exactly the same thing never matched; and comparing JSON.stringify output
 * compares key *order*, which zod rewrites to its schema order on the way in.
 *
 * The effect was that a department could not save any drug-profile edit at all.
 * Every save round-trips the whole payload, the untouched units came back in a
 * different key order, and the guard reported them as an attempt to redefine a
 * canonical unit — so a legitimate narrowing was refused along with everything
 * else. The unit tests missed it because they use a string for `unit`.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`
}

function unitsOf(payload: ClinicalRulePayload) {
  const record = asRecord(payload)
  return {
    unit: canonicalJson(record.unit ?? null),
    routeUnits: canonicalJson(record.routeUnits ?? {}),
    doseUnit: canonicalJson(record.doseUnit ?? null),
  }
}

/**
 * Narrow, never widen, applied to the dose calculation itself.
 *
 * This is the arithmetic that turns a patient's weight into the milligrams the
 * app suggests. Everything here either scales that number or bounds it, so the
 * safe direction is unambiguous: a department may prescribe *less* than the
 * platform ruleset, and may cap it *harder*, but may not do the reverse.
 *
 * `roundTo` is deliberately not guarded. It only snaps an already-computed dose
 * to a drawable increment, the change it can make is bounded by that increment,
 * and rounding to what a local pharmacy actually stocks is a reasonable thing
 * for a department to want.
 */
function doseCalcIssues(input: {
  route: string
  next: LooseDoseCalc
  baseline: LooseDoseCalc
}): ScopeGuardIssue[] {
  const { route, next, baseline } = input
  const issues: ScopeGuardIssue[] = []
  const field = (name: string) => `routeModes.${route}.doseCalc.${name}`

  // A calculation where the platform ruleset had none is an invented dose, not
  // a narrowed one — the platform left this to the clinician on purpose.
  if (!baseline && next) {
    return [{
      field: field("perKg"),
      message: `An automatic ${route} dose cannot be introduced here. The platform ruleset leaves this one `
        + "to the clinician, and only a platform administrator can add a calculation.",
    }]
  }
  if (!baseline || !next) return issues

  const scalars = [
    ["perKg", "per-kilogram dose"],
    ["perM2", "per-square-metre dose"],
    ["flat", "fixed dose"],
  ] as const
  for (const [key, label] of scalars) {
    const nextValue = next[key]
    const baseValue = baseline[key]
    if (typeof nextValue !== "number") continue
    if (typeof baseValue !== "number") {
      issues.push({
        field: field(key),
        message: `A ${label} cannot be introduced for ${route} here; it is set by the platform ruleset.`,
      })
    } else if (nextValue > baseValue) {
      issues.push({
        field: field(key),
        message: `The ${route} ${label} cannot be raised above the platform value of ${baseValue} `
          + `(requested ${nextValue}). It may be lowered.`,
      })
    }
  }

  // A ceiling is the last thing standing between a large weight and a large
  // dose. Raising it, or removing it entirely, widens the envelope.
  if (typeof baseline.cap === "number") {
    if (typeof next.cap !== "number") {
      issues.push({
        field: field("cap"),
        message: `The ${route} dose ceiling of ${baseline.cap} is set by the platform ruleset and cannot be removed here. `
          + "It may be lowered.",
      })
    } else if (next.cap > baseline.cap) {
      issues.push({
        field: field("cap"),
        message: `The ${route} dose ceiling cannot be raised above the platform value of ${baseline.cap} `
          + `(requested ${next.cap}). It may be lowered.`,
      })
    }
  }

  // Capping an ideal-body-weight dose at the child's actual weight stops an
  // underweight child receiving a dose computed for a heavier ideal.
  if ((baseline.capAtActualWeight ?? true) && next.capAtActualWeight === false) {
    issues.push({
      field: field("capAtActualWeight"),
      message: `Capping the ${route} dose at the patient's actual weight is set by the platform ruleset `
        + "and cannot be switched off here.",
    })
  }

  if ((next.basis ?? null) !== (baseline.basis ?? null)) {
    issues.push({
      field: field("basis"),
      message: `The weight a ${route} dose is calculated from is fixed by the platform ruleset `
        + `(${baseline.basis ?? "unset"} here). Changing it changes every dose this profile produces.`,
    })
  }

  return issues
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

  // An age band is the statement "this dose was reviewed for children of this
  // age". Narrowing it is a local judgement; widening it applies a dose to
  // children nobody reviewed it for — a neonate inheriting a toddler's profile.
  const nextBand = ageBandOf(next)
  const baseBand = ageBandOf(baseline)
  if (
    nextBand.min != null && baseBand.min != null
    && nextBand.min < baseBand.min
  ) {
    issues.push({
      field: "minimumAgeDays",
      message: `This band cannot be extended to younger children than the platform ruleset reviewed it for `
        + `(from ${baseBand.min} days down to ${nextBand.min}). It may be narrowed.`,
    })
  }
  if (
    nextBand.maxExclusive != null && baseBand.maxExclusive != null
    && nextBand.maxExclusive > baseBand.maxExclusive
  ) {
    issues.push({
      field: "maximumAgeDaysExclusive",
      message: `This band cannot be extended to older children than the platform ruleset reviewed it for `
        + `(from ${baseBand.maxExclusive} days up to ${nextBand.maxExclusive}). It may be narrowed.`,
    })
  }

  if (suggestsADose(next) && !suggestsADose(baseline)) {
    issues.push({
      field: "availability",
      message: "A drug the platform ruleset withheld or left to the clinician cannot be given an automatic dose "
        + "here. It may still be shown for manual entry, withdrawn, or recorded as given.",
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

    // Quick-dose pills are one tap away from being given, so a value that is not
    // in the platform ruleset is a dose nobody reviewed. Removing and reordering
    // stay open, which is what a department tailoring its own list actually does.
    const allowedQuick = new Set(quickValuesOf(baseline, route))
    const newQuick = quickValuesOf(next, route).filter(value => !allowedQuick.has(value))
    if (newQuick.length) {
      issues.push({
        field: `routeModes.${route}.quickValues`,
        message: `Quick doses ${newQuick.join(", ")} are not in the platform ruleset. `
          + "Quick doses may be removed or reordered, but new ones are added by platform administrators.",
      })
    }

    issues.push(...doseCalcIssues({
      route,
      next: doseCalcOf(next, route),
      baseline: doseCalcOf(baseline, route),
    }))

    // Which weight the dose is computed from is not a narrowing in either
    // direction: ideal and total body weight give different doses, and the
    // choice is the clinical review, not a local preference.
    const nextBasis = weightBasisOf(next, route)
    const baseBasis = weightBasisOf(baseline, route)
    if (nextBasis !== baseBasis) {
      issues.push({
        field: `routeModes.${route}.weightBasis`,
        message: `The weight a ${route} dose is calculated from is fixed by the platform ruleset `
          + `(${baseBasis ?? "unset"} here). Changing it changes every dose this profile produces.`,
      })
    }
  }

  return issues
}
