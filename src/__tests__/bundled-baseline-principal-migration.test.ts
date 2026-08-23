import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const schema = readFileSync(resolve(process.cwd(), "prisma/schema.prisma"), "utf8")
const migration = readFileSync(resolve(
  process.cwd(),
  "prisma/migrations/20260823110000_bundled_clinical_baseline_principal/migration.sql",
), "utf8")

describe("bundled clinical baseline technical-principal migration", () => {
  it("creates one immutable non-login release identity per release version", () => {
    const principalModel = schema.match(/model TechnicalPrincipal \{([\s\S]*?)\n\}/)?.[1] ?? ""
    expect(principalModel).toContain("@@unique([kind, releaseVersion])")
    expect(principalModel).not.toMatch(/email|password|session|role|mfa|token/i)
    expect(migration).toContain('CREATE UNIQUE INDEX "TechnicalPrincipal_kind_releaseVersion_key"')
    expect(migration).toContain('CREATE TRIGGER "TechnicalPrincipal_immutable"')
    expect(migration).toContain("technical principals are immutable")
  })

  it("binds all release authorship through restrictive foreign keys and XOR checks", () => {
    for (const field of [
      "createdByTechnicalPrincipalId",
      "publishedByTechnicalPrincipalId",
      "confirmedByTechnicalPrincipalId",
      "selectedByTechnicalPrincipalId",
    ]) {
      expect(migration).toContain(`"${field}"`)
      expect(migration).toMatch(new RegExp(
        `FOREIGN KEY \\("${field}"\\)[\\s\\S]{0,160}ON DELETE RESTRICT`,
      ))
    }
    expect(migration).toContain('CONSTRAINT "ClinicalPreset_creator_principal_xor"')
    expect(migration).toContain('CONSTRAINT "ClinicalPreset_publisher_principal_xor"')
    expect(migration).toContain('CONSTRAINT "ClinicalRulesetPublicationEvidence_confirmer_principal_xor"')
    expect(migration).toContain('CONSTRAINT "PlatformClinicalPresetSelection_selector_principal_xor"')
  })

  it("extends published-preset immutability to technical authorship", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION protect_published_clinical_preset()")
    expect(migration).toContain('NEW."publishedByTechnicalPrincipalId" IS DISTINCT FROM OLD."publishedByTechnicalPrincipalId"')
    expect(migration).toContain('NEW."createdByTechnicalPrincipalId" IS DISTINCT FROM OLD."createdByTechnicalPrincipalId"')
    expect(migration).toContain("clinical rulesets must be created as drafts before publication")
    expect(migration).toContain("clinical ruleset publication evidence is required")
  })
})
