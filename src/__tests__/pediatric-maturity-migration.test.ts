import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const migration = readFileSync(
  new URL("../../prisma/migrations/20260730010000_remove_pediatric_maturity_context/migration.sql", import.meta.url),
  "utf8",
)

describe("pediatric maturity removal migration", () => {
  it("removes the abandoned maturity context without touching exact age", () => {
    for (const column of [
      "prematurityStatus",
      "gestationalAgeAtBirthDays",
      "postmenstrualAgeAtCaseDays",
      "maturityCalculationVersion",
      "gestationalAgeWeeks",
      "postmenstrualAgeWeeks",
    ]) {
      expect(migration).toContain(`DROP COLUMN IF EXISTS "${column}"`)
    }
    expect(migration).toContain('DROP TYPE IF EXISTS "PrematurityStatus"')
    expect(migration).not.toContain('DROP COLUMN IF EXISTS "ageValue"')
    expect(migration).not.toContain('DROP COLUMN IF EXISTS "ageUnit"')
    expect(migration).not.toContain('DROP COLUMN IF EXISTS "ageApproxDays"')
  })
})