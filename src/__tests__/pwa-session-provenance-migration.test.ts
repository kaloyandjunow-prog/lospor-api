import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

const sql = readFileSync(resolve(
  process.cwd(),
  "prisma/migrations/20260823100000_pwa_session_provenance/migration.sql",
), "utf8")

describe("PWA session provenance migration", () => {
  it("adds a distinct PWA session type without rewriting existing sessions", () => {
    expect(sql).toContain('ALTER TYPE "AuthSessionClientType" ADD VALUE \'PWA\'')
    expect(sql).not.toMatch(/\bUPDATE\s+"AuthSession"/i)
    expect(sql).not.toMatch(/\bDELETE\b/i)
  })
})
