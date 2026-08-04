import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  assertDatabaseWritable,
  databaseRefFrom,
  isProtectedDatabase,
} from "../../scripts/lib/protected-database"

/**
 * The guard these cases cover replaced one that checked `VERCEL_ENV` and
 * `NODE_ENV`. That older check described the environment the process ran in,
 * not the database it was connected to, so running a maintenance script from a
 * laptop against production passed it without complaint — which is exactly what
 * happened during the v8 release.
 *
 * So the cases below are written around the connection string, and the most
 * important one is "a laptop pointed at production is refused".
 */
const PROD = "postgresql://postgres.yzqszvlvccyufrkbuhtv:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres"
const PROD_DIRECT = "postgresql://postgres:pw@db.yzqszvlvccyufrkbuhtv.supabase.co:5432/postgres"
const DEV = "postgresql://postgres.jaypozexwztkpkpmbggl:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres"
const LOCAL = "postgresql://postgres:rehearsal@127.0.0.1:55432/rehearsal"

const saved = { ...process.env }
beforeEach(() => {
  delete process.env.DATABASE_URL
  delete process.env.DIRECT_URL
  delete process.env.LOSPOR_ALLOW_PROTECTED_DB
  delete process.env.LOSPOR_PROTECTED_DB_REFS
})
afterEach(() => { process.env = { ...saved } })

describe("databaseRefFrom", () => {
  it("reads the project reference from the pooled host, where it rides in the username", () => {
    expect(databaseRefFrom(PROD)).toBe("yzqszvlvccyufrkbuhtv")
    expect(databaseRefFrom(DEV)).toBe("jaypozexwztkpkpmbggl")
  })

  it("reads it from the direct host too", () => {
    expect(databaseRefFrom(PROD_DIRECT)).toBe("yzqszvlvccyufrkbuhtv")
  })

  it("returns null for a local cluster and for nothing at all", () => {
    expect(databaseRefFrom(LOCAL)).toBeNull()
    expect(databaseRefFrom(undefined)).toBeNull()
    expect(databaseRefFrom("")).toBeNull()
  })
})

describe("isProtectedDatabase", () => {
  it("protects production, leaves dev and local alone", () => {
    expect(isProtectedDatabase(PROD)).toBe(true)
    expect(isProtectedDatabase(PROD_DIRECT)).toBe(true)
    expect(isProtectedDatabase(DEV)).toBe(false)
    expect(isProtectedDatabase(LOCAL)).toBe(false)
  })

  it("accepts extra protected references from the environment", () => {
    process.env.LOSPOR_PROTECTED_DB_REFS = "jaypozexwztkpkpmbggl"
    expect(isProtectedDatabase(DEV)).toBe(true)
  })
})

describe("assertDatabaseWritable", () => {
  it("refuses a laptop pointed at production — the case the old guard missed", () => {
    // No VERCEL_ENV, no NODE_ENV=production: the previous check passed here.
    process.env.DATABASE_URL = PROD
    expect(() => assertDatabaseWritable("publish")).toThrow(/protected database "yzqszvlvccyufrkbuhtv"/)
  })

  it("allows it only when the operator names that exact database", () => {
    process.env.DATABASE_URL = PROD
    process.env.LOSPOR_ALLOW_PROTECTED_DB = "yzqszvlvccyufrkbuhtv"
    expect(assertDatabaseWritable("publish")).toEqual({ ref: "yzqszvlvccyufrkbuhtv", protected: true })
  })

  it("rejects a generic override", () => {
    // "YES" is the shape of override people type without reading. It must not work.
    process.env.DATABASE_URL = PROD
    for (const value of ["YES", "true", "1", "yzqsz"]) {
      process.env.LOSPOR_ALLOW_PROTECTED_DB = value
      expect(() => assertDatabaseWritable("publish")).toThrow(/protected database/)
    }
  })

  it("does not let an override for one database unlock another", () => {
    process.env.DATABASE_URL = PROD
    process.env.LOSPOR_ALLOW_PROTECTED_DB = "jaypozexwztkpkpmbggl"
    expect(() => assertDatabaseWritable("publish")).toThrow(/protected database/)
  })

  it("prefers DIRECT_URL, since that is what the scripts connect through", () => {
    process.env.DATABASE_URL = DEV
    process.env.DIRECT_URL = PROD
    expect(() => assertDatabaseWritable("publish")).toThrow(/yzqszvlvccyufrkbuhtv/)
  })

  it("lets dev and local through untouched", () => {
    process.env.DATABASE_URL = DEV
    expect(assertDatabaseWritable("publish").protected).toBe(false)
    process.env.DATABASE_URL = LOCAL
    expect(assertDatabaseWritable("publish").protected).toBe(false)
  })

  it("still requires a connection string at all", () => {
    expect(() => assertDatabaseWritable("publish")).toThrow(/DATABASE_URL is required/)
  })
})
