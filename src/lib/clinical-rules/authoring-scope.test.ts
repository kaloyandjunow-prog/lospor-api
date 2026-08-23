import { describe, expect, it } from "vitest"
import type { ClinicalRulePayload } from "@lospor/core/clinical-rules"
import { scopeGuardIssues } from "./authoring-scope"

const platformPropofol = {
  kind: "ADULT_DRUG_PROFILE",
  itemKey: "PROPOFOL",
  labelEn: "Propofol",
  labelBg: "Пропофол",
  category: "Intravenous hypnotics",
  unit: "MG",
  routeUnits: { IV: "MG" },
  profile: {
    kind: "bolus",
    mode: "dose",
    rounding: "nearest_step",
    quickValues: [50, 100],
    routes: ["IV"],
    defaultRoute: "IV",
    weightBasis: "none",
    routeModes: {
      IV: {
        mode: "dose",
        min: 0,
        max: 500,
        step: 10,
        unit: "mg",
        quickValues: [50, 100],
        concentrationOptions: ["1%", "2%"],
      },
    },
  },
} as unknown as ClinicalRulePayload

/** Deep clone so a test mutation cannot leak into the shared baseline. */
function variant(change: (draft: Record<string, unknown>) => void): ClinicalRulePayload {
  const draft = JSON.parse(JSON.stringify(platformPropofol)) as Record<string, unknown>
  change(draft)
  return draft as unknown as ClinicalRulePayload
}

describe("scopeGuardIssues", () => {
  it("lets a platform administrator author anything, including a brand-new item", () => {
    const brandNew = variant(draft => { draft.itemKey = "NEW_INVESTIGATIONAL_DRUG" })
    expect(scopeGuardIssues({ scope: "PLATFORM", next: brandNew, baseline: null })).toEqual([])
  })

  it("blocks an institution or member from introducing a drug the platform does not define", () => {
    for (const scope of ["INSTITUTION", "USER"] as const) {
      const issues = scopeGuardIssues({ scope, next: platformPropofol, baseline: null })
      expect(issues).toHaveLength(1)
      expect(issues[0]!.message).toContain("platform administrator")
    }
  })

  it("blocks changing EN/BG display names below the platform layer", () => {
    const renamed = variant(draft => { draft.labelBg = "Друго име" })
    const issues = scopeGuardIssues({
      scope: "INSTITUTION",
      next: renamed,
      baseline: platformPropofol,
    })
    expect(issues.map(issue => issue.field)).toContain("labelBg")
    expect(issues[0]!.message).toContain("Display names")
  })

  it("blocks changing the canonical unit so recorded doses stay comparable", () => {
    const reunited = variant(draft => {
      draft.unit = "MCG"
      draft.routeUnits = { IV: "MCG" }
    })
    const issues = scopeGuardIssues({
      scope: "USER",
      next: reunited,
      baseline: platformPropofol,
    })
    expect(issues.map(issue => issue.field)).toContain("unit")
  })

  it("blocks inventing a route that the platform ruleset does not define", () => {
    const extraRoute = variant(draft => {
      const profile = draft.profile as { routes: string[] }
      profile.routes = ["IV", "INTRATHECAL"]
    })
    const issues = scopeGuardIssues({
      scope: "INSTITUTION",
      next: extraRoute,
      baseline: platformPropofol,
    })
    expect(issues.map(issue => issue.field)).toContain("routes")
  })

  it("blocks a personal ruleset widening the slider beyond the platform envelope", () => {
    const wider = variant(draft => {
      const profile = draft.profile as { routeModes: Record<string, { max: number }> }
      profile.routeModes.IV!.max = 900
    })
    const issues = scopeGuardIssues({
      scope: "USER",
      next: wider,
      baseline: platformPropofol,
    })
    expect(issues.map(issue => issue.field)).toContain("routeModes.IV.max")
  })

  it("allows a HOD to widen the institution slider for a reasoned publication", () => {
    const wider = variant(draft => {
      const profile = draft.profile as { routeModes: Record<string, { max: number }> }
      profile.routeModes.IV!.max = 900
    })
    expect(scopeGuardIssues({
      scope: "INSTITUTION",
      next: wider,
      baseline: platformPropofol,
    })).toEqual([])
  })

  it("blocks a personal ruleset inventing a concentration", () => {
    const madeUp = variant(draft => {
      const profile = draft.profile as { routeModes: Record<string, { concentrationOptions: string[] }> }
      profile.routeModes.IV!.concentrationOptions = ["1%", "2%", "7.3%"]
    })
    const issues = scopeGuardIssues({
      scope: "USER",
      next: madeUp,
      baseline: platformPropofol,
    })
    expect(issues.map(issue => issue.field)).toContain("routeModes.IV.concentrationOptions")
  })

  it("allows an institution to record a locally governed concentration", () => {
    const local = variant(draft => {
      const profile = draft.profile as { routeModes: Record<string, { concentrationOptions: string[] }> }
      profile.routeModes.IV!.concentrationOptions = ["1%", "2%", "0.5%"]
    })
    expect(scopeGuardIssues({
      scope: "INSTITUTION",
      next: local,
      baseline: platformPropofol,
    })).toEqual([])
  })

  it("allows narrowing: tighter bounds, fewer pills, a subset of concentrations", () => {
    const narrowed = variant(draft => {
      const profile = draft.profile as {
        routeModes: Record<string, {
          min: number
          max: number
          quickValues: number[]
          concentrationOptions: string[]
        }>
      }
      profile.routeModes.IV!.min = 10
      profile.routeModes.IV!.max = 300
      profile.routeModes.IV!.quickValues = [100]
      profile.routeModes.IV!.concentrationOptions = ["2%"]
    })
    expect(scopeGuardIssues({
      scope: "USER",
      next: narrowed,
      baseline: platformPropofol,
    })).toEqual([])
  })

  it("allows a personal layer to reorder quick-dose pills", () => {
    const reordered = variant(draft => {
      const profile = draft.profile as { routeModes: Record<string, { quickValues: number[] }> }
      profile.routeModes.IV!.quickValues = [100, 50]
    })
    expect(scopeGuardIssues({
      scope: "USER",
      next: reordered,
      baseline: platformPropofol,
    })).toEqual([])
  })

  /**
   * Real rules carry a unit as an object, not the "MG" string the fixtures
   * above use, and every save round-trips the payload through JSON and zod —
   * which rewrites object keys into schema order. The guard compared units by
   * reference and by raw JSON text, so an untouched unit came back looking
   * changed and *every* departmental edit was refused, narrowing included.
   * Found end to end; these pin it at the unit level.
   */
  const objectUnit = {
    amount: "ML", display: "mL", ucumCode: "mL", bodyBasis: "NONE", timeBasis: "NONE",
  }
  const reorderedUnit = {
    amount: "ML", bodyBasis: "NONE", timeBasis: "NONE", display: "mL", ucumCode: "mL",
  }
  const withUnit = (unit: unknown, routeUnits: unknown) => variant(draft => {
    draft.unit = unit
    draft.routeUnits = routeUnits
  })

  it("treats an object unit as unchanged when only its key order differs", () => {
    expect(scopeGuardIssues({
      scope: "INSTITUTION",
      next: withUnit(reorderedUnit, { IV: reorderedUnit }),
      baseline: withUnit(objectUnit, { IV: objectUnit }),
    })).toEqual([])
  })

  it("still catches an object unit whose meaning has changed", () => {
    const changed = { ...objectUnit, amount: "MG", display: "mg", ucumCode: "mg" }
    const issues = scopeGuardIssues({
      scope: "INSTITUTION",
      next: withUnit(changed, { IV: changed }),
      baseline: withUnit(objectUnit, { IV: objectUnit }),
    })
    expect(issues.map(issue => issue.field)).toContain("unit")
  })
})

/**
 * The dose calculation is the arithmetic that turns a patient's weight into the
 * milligrams the app suggests. The original guard checked drug identity, names,
 * units, routes, slider bounds and concentrations — but not this, so a head of
 * department could multiply a per-kilogram dose tenfold, delete a ceiling, or
 * stretch an age band onto children it was never reviewed for, and the server
 * accepted it. The rule is the same one the sliders already follow: a lower
 * layer may prescribe less, never more.
 */
const platformRocuronium = {
  kind: "PEDIATRIC_DRUG_PROFILE",
  medicationKey: "ROCURONIUM",
  labelEn: "Rocuronium",
  labelBg: "Рокурониум",
  category: "Neuromuscular blockers",
  unit: "MG",
  routeUnits: { IV: "MG" },
  availability: "AUTO",
  minimumAgeDays: 30,
  maximumAgeDaysExclusive: 365,
  profile: {
    kind: "bolus",
    mode: "dose",
    rounding: "nearest_step",
    quickValues: [1, 2, 5, 10],
    routes: ["IV"],
    defaultRoute: "IV",
    weightBasis: "TBW",
    doseCalc: { perKg: 0.6, basis: "TBW", cap: 100, roundTo: 0.1, capAtActualWeight: true },
    routeModes: {
      IV: { mode: "dose", min: 0, max: 100, step: 0.1, unit: "mg", quickValues: [1, 2, 5, 10] },
    },
  },
} as unknown as ClinicalRulePayload

function pedVariant(change: (draft: Record<string, unknown>) => void): ClinicalRulePayload {
  const draft = JSON.parse(JSON.stringify(platformRocuronium)) as Record<string, unknown>
  change(draft)
  return draft as unknown as ClinicalRulePayload
}

type Draft = Record<string, unknown>
const doseCalcOfDraft = (draft: Draft) =>
  (draft.profile as Draft).doseCalc as Record<string, unknown>

function guard(next: ClinicalRulePayload, scope: "INSTITUTION" | "USER" = "USER") {
  return scopeGuardIssues({ scope, next, baseline: platformRocuronium })
}

describe("scopeGuardIssues protects the dose calculation", () => {
  it("accepts the platform rule unchanged at every scope", () => {
    for (const scope of ["INSTITUTION", "USER"] as const) {
      expect(guard(platformRocuronium, scope)).toEqual([])
    }
  })

  it("blocks raising the per-kilogram dose", () => {
    const issues = guard(pedVariant(d => { doseCalcOfDraft(d).perKg = 6 }))
    expect(issues.map(i => i.field)).toContain("routeModes.IV.doseCalc.perKg")
    expect(issues[0]!.message).toContain("0.6")
  })

  it("allows a HOD to broaden an institution calculation", () => {
    expect(guard(pedVariant(d => {
      doseCalcOfDraft(d).perKg = 0.9
      doseCalcOfDraft(d).cap = 150
    }), "INSTITUTION")).toEqual([])
  })

  it("allows lowering the per-kilogram dose — a department may prescribe less", () => {
    expect(guard(pedVariant(d => { doseCalcOfDraft(d).perKg = 0.3 }))).toEqual([])
  })

  it("blocks removing the dose ceiling", () => {
    const issues = guard(pedVariant(d => { delete doseCalcOfDraft(d).cap }))
    expect(issues.map(i => i.field)).toContain("routeModes.IV.doseCalc.cap")
  })

  it("blocks raising the dose ceiling but allows lowering it", () => {
    expect(guard(pedVariant(d => { doseCalcOfDraft(d).cap = 500 }))).not.toEqual([])
    expect(guard(pedVariant(d => { doseCalcOfDraft(d).cap = 50 }))).toEqual([])
  })

  it("blocks switching the weight the dose is calculated from", () => {
    // Ideal and total body weight give different doses; this is not a narrowing
    // in either direction, so it belongs to the platform layer.
    const issues = guard(pedVariant(d => {
      doseCalcOfDraft(d).basis = "IBW"
      ;(d.profile as Draft).weightBasis = "IBW"
    }))
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.some(i => i.message.includes("every dose this profile produces"))).toBe(true)
  })

  it("blocks switching off the cap at the patient's actual weight", () => {
    const issues = guard(pedVariant(d => { doseCalcOfDraft(d).capAtActualWeight = false }))
    expect(issues.map(i => i.field)).toContain("routeModes.IV.doseCalc.capAtActualWeight")
  })

  it("blocks introducing an automatic dose where the platform left none", () => {
    const noCalc = JSON.parse(JSON.stringify(platformRocuronium)) as Draft
    delete (noCalc.profile as Draft).doseCalc
    const withCalc = pedVariant(() => {})
    const issues = scopeGuardIssues({
      scope: "INSTITUTION",
      next: withCalc,
      baseline: noCalc as unknown as ClinicalRulePayload,
    })
    expect(issues.length).toBeGreaterThan(0)
    expect(issues[0]!.message).toContain("cannot be introduced")
  })
})

describe("scopeGuardIssues protects quick doses and age bands", () => {
  it("blocks a quick dose that is not in the platform ruleset", () => {
    const issues = guard(pedVariant(d => {
      ;((d.profile as Draft).routeModes as Draft).IV = {
        mode: "dose", min: 0, max: 100, step: 0.1, unit: "mg", quickValues: [1, 2, 5, 999],
      }
    }))
    expect(issues.map(i => i.field)).toContain("routeModes.IV.quickValues")
    expect(issues[0]!.message).toContain("999")
  })

  it("allows removing and reordering quick doses", () => {
    expect(guard(pedVariant(d => {
      ;((d.profile as Draft).routeModes as Draft).IV = {
        mode: "dose", min: 0, max: 100, step: 0.1, unit: "mg", quickValues: [5, 2, 1],
      }
    }))).toEqual([])
  })

  it("blocks widening an age band in either direction", () => {
    expect(guard(pedVariant(d => { d.minimumAgeDays = 0 })).map(i => i.field))
      .toContain("minimumAgeDays")
    expect(guard(pedVariant(d => { d.maximumAgeDaysExclusive = 6570 })).map(i => i.field))
      .toContain("maximumAgeDaysExclusive")
  })

  it("allows narrowing an age band", () => {
    expect(guard(pedVariant(d => {
      d.minimumAgeDays = 60
      d.maximumAgeDaysExclusive = 300
    }))).toEqual([])
  })
})

describe("scopeGuardIssues protects automatic dosing, not visibility", () => {
  const withheld = pedVariant(d => { d.availability = "HIDDEN" })

  it("blocks giving an automatic dose to a drug the platform withheld", () => {
    const issues = scopeGuardIssues({
      scope: "INSTITUTION",
      next: pedVariant(d => { d.availability = "AUTO" }),
      baseline: withheld,
    })
    expect(issues.map(i => i.field)).toContain("availability")
  })

  it("still lets a department withdraw a drug, or show it for manual entry only", () => {
    // Hiding is the escape hatch institutions rely on; unhiding for manual entry
    // matters because a register has to record a drug that was actually given.
    expect(guard(withheld)).toEqual([])
    expect(scopeGuardIssues({
      scope: "INSTITUTION",
      next: pedVariant(d => { d.availability = "MANUAL" }),
      baseline: withheld,
    })).toEqual([])
  })
})
