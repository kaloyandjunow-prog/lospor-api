import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const sql = readFileSync(join(
  process.cwd(),
  "prisma/migrations/20260822160000_administrator_totp_mfa/migration.sql",
), "utf8")

describe("administrator MFA migration", () => {
  it("persists encrypted seeds, one-use challenges, and hashed recovery codes", () => {
    expect(sql).toContain('"mfaTotpSecretCiphertext" TEXT')
    expect(sql).toContain('"mfaLastTotpStep" INTEGER')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "MfaLoginChallenge"')
    expect(sql).toContain('"tokenHash" TEXT NOT NULL')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "MfaRecoveryCode"')
    expect(sql).toContain('"codeHash" TEXT NOT NULL')
    expect(sql).not.toMatch(/\b(secret|recovery)Code\b/i)
  })

  it("cascades ephemeral MFA material when its account is erased", () => {
    expect(sql.match(/REFERENCES "User"\("id"\) ON DELETE CASCADE/g)).toHaveLength(2)
  })
})
