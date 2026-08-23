import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const migration = readFileSync(resolve(
  process.cwd(),
  "prisma/migrations/20260822140000_clinical_rules_publication_evidence/migration.sql",
), "utf8")

describe("clinical rules publication evidence migration", () => {
  it("creates hash-bound exact evidence and backfills old publications", () => {
    expect(migration).toContain('CREATE TABLE "ClinicalRulesetPublicationEvidence"')
    expect(migration).toContain('"contentSha256" ~ \'^[a-f0-9]{64}$\'')
    expect(migration).toContain("MIGRATION_BACKFILL")
    expect(migration).toContain("schemaVersion', 0")
    expect(migration).toContain("digest(convert_to(content::text")
  })

  it("makes evidence and published rule rows immutable", () => {
    expect(migration).toContain('"ClinicalRulesetPublicationEvidence_append_only"')
    expect(migration).toContain('"ClinicalPresetRule_published_immutable"')
    expect(migration).toContain("published clinical rules are immutable")
    expect(migration).toContain('"ClinicalPreset_published_immutable"')
    expect(migration).toContain("clinical ruleset publication evidence is required")
  })

  it("requires a baseline and meaningful reason for new institution publications", () => {
    expect(migration).toContain("institution publication requires a platform baseline")
    expect(migration).toContain("char_length(btrim(NEW.\"reason\")) < 10")
  })
})
