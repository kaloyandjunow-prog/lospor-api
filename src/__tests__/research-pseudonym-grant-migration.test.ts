import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const sql = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20260822130000_research_case_pseudonyms/migration.sql",
), "utf8")

describe("research pseudonym and grant migration", () => {
  it("backfills a unique immutable opaque case identifier", () => {
    expect(sql).toContain('ALTER TABLE "Case" ADD COLUMN "researchId" UUID')
    expect(sql).toContain('SET "researchId" = gen_random_uuid()')
    expect(sql).toContain('ALTER COLUMN "researchId" SET NOT NULL')
    expect(sql).toContain('CREATE UNIQUE INDEX "Case_researchId_key"')
    expect(sql).toContain('CREATE TRIGGER "Case_research_id_immutable"')
  })

  it("makes grants granular and bounded to 365 days", () => {
    expect(sql).toContain('ADD COLUMN "canQuery" BOOLEAN NOT NULL DEFAULT true')
    expect(sql).toContain('ADD COLUMN "canShareCohorts" BOOLEAN NOT NULL DEFAULT false')
    expect(sql).toContain('ALTER COLUMN "canInspectCases" SET DEFAULT false')
    expect(sql).toContain('"canExportOmop" OR "canExport"')
    expect(sql).toContain("INTERVAL '365 days'")
  })

  it("makes eight-hour self-authorization append-only with a 24-hour database gate", () => {
    expect(sql).toContain('CREATE TABLE "ResearchSelfAuthorization"')
    expect(sql).toContain("INTERVAL '8 hours'")
    expect(sql).toContain("INTERVAL '24 hours'")
    expect(sql).toContain('CREATE TRIGGER "ResearchSelfAuthorization_cooldown"')
    expect(sql).toContain('CREATE TRIGGER "ResearchSelfAuthorization_append_only"')
  })
})
