import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const migration = readFileSync(
  resolve(
    process.cwd(),
    "prisma/migrations/20260731100000_clinical_ruleset_hierarchy/migration.sql",
  ),
  "utf8",
)

describe("clinical ruleset hierarchy migration", () => {
  it("creates independent mode-specific selections", () => {
    expect(migration).toContain('CREATE TABLE "PlatformClinicalPresetSelection"')
    expect(migration).toContain('CREATE TABLE "InstitutionClinicalPresetSelection"')
    expect(migration).toContain('CREATE TABLE "UserClinicalPresetSelection"')
    expect(migration).toContain('"clinicalMode" "ClinicalMode"')
    expect(migration).toContain('"ClinicalPreset_platform_key_mode_version_key"')
    expect(migration).toContain('"ClinicalPreset_institution_key_mode_owner_version_key"')
    expect(migration).toContain('"ClinicalPreset_user_key_mode_owner_version_key"')
  })

  it("preserves legacy institution selections before removing the one-mode pointer", () => {
    const copyAt = migration.indexOf('INSERT INTO "InstitutionClinicalPresetSelection"')
    const dropAt = migration.indexOf('DROP COLUMN "clinicalPresetId"')
    expect(copyAt).toBeGreaterThan(-1)
    expect(dropAt).toBeGreaterThan(copyAt)
  })

  it("enforces ruleset scope ownership", () => {
    expect(migration).toContain('"ClinicalPreset_scope_owner_check"')
    expect(migration).toContain('"scope" = \'PLATFORM\'')
    expect(migration).toContain('"scope" = \'INSTITUTION\'')
    expect(migration).toContain('"scope" = \'USER\'')
  })
})
