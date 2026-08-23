import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const sql = readFileSync(resolve(
  process.cwd(),
  "prisma/migrations/20260822150000_account_lifecycle_sessions/migration.sql",
), "utf8")

describe("account lifecycle/session migration", () => {
  it("adds separate suspension, recovery, deletion-terminal, and session state", () => {
    expect(sql).toContain('ADD COLUMN "suspendedAt"')
    expect(sql).toContain('ADD COLUMN "recoveryRequiredAt"')
    expect(sql).toContain('ADD COLUMN "anonymizedAt"')
    expect(sql).toContain('CREATE TABLE "AuthSession"')
    expect(sql).toContain('FOREIGN KEY ("userId") REFERENCES "User"("id")')
  })

  it("backfills the terminal marker for already-anonymized legacy rows", () => {
    expect(sql).toContain("WHERE \"email\" LIKE 'deleted-%@lospor.invalid'")
  })
})
