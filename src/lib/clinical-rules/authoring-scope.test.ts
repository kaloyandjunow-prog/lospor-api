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

  it("blocks widening the slider beyond the reviewed platform envelope", () => {
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

  it("blocks inventing a concentration that is not canonical", () => {
    const madeUp = variant(draft => {
      const profile = draft.profile as { routeModes: Record<string, { concentrationOptions: string[] }> }
      profile.routeModes.IV!.concentrationOptions = ["1%", "2%", "7.3%"]
    })
    const issues = scopeGuardIssues({
      scope: "INSTITUTION",
      next: madeUp,
      baseline: platformPropofol,
    })
    expect(issues.map(issue => issue.field)).toContain("routeModes.IV.concentrationOptions")
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
})
