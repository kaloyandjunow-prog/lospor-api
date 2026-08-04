import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const migration = readFileSync(
  join(
    process.cwd(),
    "prisma/migrations/20260801100000_remove_editable_equipment_rules/migration.sql",
  ),
  "utf8",
)

describe("fixed equipment rules migration", () => {
  it("removes every legacy equipment kind from rules, overrides, and reviews", () => {
    expect(migration).toContain('DELETE FROM "ClinicalPresetRule"')
    expect(migration).toContain('DELETE FROM "InstitutionClinicalRuleOverride"')
    expect(migration).toContain('DELETE FROM "ClinicalRuleReview"')
    expect(migration.match(/'ADULT_EQUIPMENT_PROFILE'/g)).toHaveLength(5)
    expect(migration.match(/'PEDIATRIC_EQUIPMENT'/g)).toHaveLength(5)
    expect(migration.match(/'PEDIATRIC_EQUIPMENT_POLICY'/g)).toHaveLength(5)
  })

  it("is data-only and leaves presets, selections, and drug rules untouched", () => {
    expect(migration).not.toMatch(/\b(?:CREATE|ALTER|DROP|TRUNCATE)\b/)
    expect(migration).not.toContain('DELETE FROM "ClinicalPreset"')
    expect(migration).not.toContain('ClinicalPresetSelection')
    expect(migration).not.toContain("DRUG")
  })
})
