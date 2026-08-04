import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

const migration = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20260801090000_drug_selection_audit_fields/migration.sql",
), "utf8")

describe("drug selection audit migration", () => {
  it.each([
    "concentrationValue",
    "concentrationUnit",
    "formulation",
    "calculationBasis",
    "calculationWeightKg",
    "calculationMethod",
    "clinicalRuleKey",
    "clinicalRuleVersion",
    "clinicalRuleSourceIds",
    "clinicalPresetId",
    "clinicalPresetVersion",
    "clinicalPresetScope",
  ])("adds %s without rewriting legacy metadata", column => {
    expect(migration).toContain(`ADD COLUMN "${column}"`)
  })

  it("is additive and keeps historical rows intact", () => {
    expect(migration).not.toMatch(/\bDROP\b/i)
    expect(migration).not.toMatch(/\bDELETE\b/i)
    expect(migration).not.toMatch(/\bUPDATE\b/i)
    expect(migration).not.toContain('ALTER COLUMN "metadataJson"')
  })
})
