import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const migration = readFileSync(resolve(
  process.cwd(),
  "prisma/migrations/20260823120000_deployment_username_identity/migration.sql",
), "utf8")

describe("deployment username identity migration", () => {
  it("backfills activation from historical public email verification", () => {
    expect(migration).toMatch(/SET "activatedAt" = "emailVerifiedAt"/)
    expect(migration).toMatch(/"emailVerifiedAt" IS NOT NULL/)
  })

  it("allows optional Hospital contact email but always requires an account identity", () => {
    expect(migration).toContain('ALTER COLUMN "email" DROP NOT NULL')
    expect(migration).toContain('CONSTRAINT "User_login_identity_present"')
    expect(migration).toMatch(/"email" IS NOT NULL OR "usernameCanonical" IS NOT NULL/)
  })

  it("enforces paired, case-preserving and globally unique username columns", () => {
    expect(migration).toContain('CREATE UNIQUE INDEX "User_usernameCanonical_key"')
    expect(migration).toContain('CONSTRAINT "User_username_pair"')
    expect(migration).toContain('CONSTRAINT "User_username_format"')
    expect(migration).toContain('lower("username") = "usernameCanonical"')
    expect(migration).toContain("^[A-Za-z][A-Za-z0-9._-]{2,63}$")
  })
})
