import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const migration = readFileSync(
  new URL(
    "../../prisma/migrations/20260730140000_clinical_rule_presets/migration.sql",
    import.meta.url,
  ),
  "utf8",
)

describe("clinical rule preset migration", () => {
  it("creates and assigns a published default preset without deleting institutions", () => {
    expect(migration).toContain("CREATE TABLE \"ClinicalPreset\"")
    expect(migration).toContain("CREATE TABLE \"ClinicalPresetRule\"")
    expect(migration).toContain("'lospor-standard-v1'")
    expect(migration).toContain("UPDATE \"Institution\"")
    expect(migration).toContain("\"clinicalPresetId\" SET NOT NULL")
    expect(migration).not.toContain("DELETE FROM \"Institution\"")
  })

  it("preserves historical overrides and adds proposal ownership", () => {
    expect(migration).toContain("UPDATE \"InstitutionClinicalRuleOverride\"")
    expect(migration).toContain("ADD COLUMN \"proposedById\" TEXT")
    expect(migration).not.toContain("DELETE FROM \"InstitutionClinicalRuleOverride\"")
  })
})
