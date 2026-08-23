import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const migration = readFileSync(new URL(
  "../../prisma/migrations/20260822120000_identity_legal_case_creator/migration.sql",
  import.meta.url,
), "utf8")

describe("1.2 identity/legal/creator migration", () => {
  it("backfills legacy researchers into the orthogonal account kind", () => {
    expect(migration).toContain('CREATE TYPE "AccountKind"')
    expect(migration).toMatch(/WHERE "role" = 'RESEARCHER'/)
  })

  it("is safe after the Hospital provisioning overlay created AccountKind first", () => {
    expect(migration).toMatch(/IF NOT EXISTS[\s\S]*typname = 'AccountKind'[\s\S]*CREATE TYPE "AccountKind"/)
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "accountKind"')
    expect(migration).toContain('DROP COLUMN IF EXISTS "approvedAt"')
  })

  it("does not invent exact legal records from legacy timestamps", () => {
    expect(migration).not.toMatch(/INSERT INTO "LegalAcceptance"[\s\S]*acceptedTermsAt/)
    expect(migration).toContain("LegalAcceptance_append_only")
  })

  it("uses earliest accepted transfer evidence before current assignee fallback", () => {
    expect(migration).toMatch(/t\."status" = 'ACCEPTED'/)
    expect(migration).toMatch(/COALESCE\([\s\S]*t\."fromUserId"[\s\S]*c\."userId"/)
  })

  it("enforces creator immutability in the database", () => {
    expect(migration).toContain("CASE_CREATOR_IMMUTABLE")
    expect(migration).toContain('BEFORE UPDATE OF "createdById"')
  })

  it("keeps both cases when historical creator draft keys collide", () => {
    expect(migration).toContain("ranked_creator_drafts")
    expect(migration).toMatch(/ORDER BY "createdAt" ASC, "id" ASC/)
    expect(migration).toMatch(/SET "clientDraftId" = NULL/)
    expect(migration).not.toMatch(/DELETE FROM "Case"/)
  })
})
