import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const migration = readFileSync(
  new URL(
    "../../prisma/migrations/20260804000000_drop_placeholder_clinical_preset/migration.sql",
    import.meta.url,
  ),
  "utf8",
)

/**
 * `20260730140000_clinical_rule_presets` seeds `lospor-standard-v1` as a
 * PUBLISHED preset with no rules, purely to satisfy the NOT NULL foreign keys it
 * adds, and `20260731100000_clinical_ruleset_hierarchy` fans that out to one
 * selection row per institution.
 *
 * That is not inert. Preset resolution takes the first PUBLISHED preset from
 * [user, institution, platform] and never checks whether it has any rules, so
 * every institution would resolve pediatric dosing to an empty ruleset — and a
 * real ruleset published at PLATFORM scope afterwards would not override the
 * institution-level selections.
 *
 * This migration removes the placeholder. The cases below pin the parts that
 * make it safe rather than just present.
 */
describe("drop placeholder clinical preset migration", () => {
  it("clears the placeholder selection at every scope", () => {
    // Institution alone is not enough: platform and user selections pointing at
    // the placeholder would keep resolving to an empty ruleset.
    for (const table of [
      "InstitutionClinicalPresetSelection",
      "UserClinicalPresetSelection",
      "PlatformClinicalPresetSelection",
    ]) {
      expect(migration).toContain(`DELETE FROM "${table}"`)
    }
  })

  it("only ever targets the placeholder preset", () => {
    // Every DELETE must be scoped to lospor-standard-v1. An unqualified delete
    // here would silently unselect every institution's real ruleset.
    const deletes = migration.match(/DELETE FROM[\s\S]*?;/g) ?? []
    expect(deletes.length).toBeGreaterThan(0)
    for (const statement of deletes) {
      expect(statement).toContain("lospor-standard-v1")
    }
  })

  it("refuses to drop the preset if anything real depends on it", () => {
    // The preset is only removed when it is genuinely the empty placeholder:
    // no rules, no institution overrides, and no recorded dose citing it as
    // provenance. Deleting one that a CaseEvent references would break the
    // audit trail that makes an administration reproducible.
    expect(migration).toContain('DELETE FROM "ClinicalPreset"')
    for (const guard of [
      '"ClinicalPresetRule"',
      '"InstitutionClinicalRuleOverride"',
      '"CaseEvent"',
    ]) {
      expect(migration).toContain(guard)
    }
    expect(migration.match(/NOT EXISTS/g) ?? []).toHaveLength(3)
  })

  it("touches no clinical record tables", () => {
    for (const table of ["\"Case\"", "\"Institution\"", "\"User\"", "\"CaseEvent\" e WHERE"]) {
      expect(migration).not.toContain(`DELETE FROM ${table}`)
    }
    expect(migration).not.toContain("DROP TABLE")
    expect(migration).not.toContain("TRUNCATE")
  })
})
