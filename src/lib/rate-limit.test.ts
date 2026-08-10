import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { rateLimitingDisabledForTests } from "./rate-limit"

/**
 * The switch that turns brute-force protection off for automated runs.
 *
 * It exists because the end-to-end suite exhausts a limit it imposed on itself.
 * That is a fine reason to have it and a terrible reason to let it reach a real
 * deployment, so the interesting assertions here are the refusals: the variable
 * being set is necessary and never sufficient.
 */

const PROD_REF = "yzqszvlvccyufrkbuhtv"

let original: NodeJS.ProcessEnv

/** NODE_ENV is typed read-only, so the whole environment is replaced instead. */
function setEnv(overrides: Record<string, string | undefined> = {}) {
  const next: Record<string, string | undefined> = { ...original, NODE_ENV: "test" }
  delete next.LOSPOR_DISABLE_RATE_LIMIT
  delete next.VERCEL_ENV
  delete next.DATABASE_URL
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete next[key]
    else next[key] = value
  }
  process.env = next as NodeJS.ProcessEnv
}

beforeEach(() => {
  original = process.env
  setEnv()
})

afterEach(() => {
  process.env = original
})

describe("rate limiting stays on unless a test run asks for it", () => {
  it("is on by default", () => {
    expect(rateLimitingDisabledForTests()).toBe(false)
  })

  it("ignores anything other than an explicit true", () => {
    for (const value of ["1", "yes", "TRUE", ""]) {
      setEnv({ LOSPOR_DISABLE_RATE_LIMIT: value })
      expect(rateLimitingDisabledForTests(), `value ${JSON.stringify(value)}`).toBe(false)
    }
  })

  it("can be switched off for a local test run", () => {
    setEnv({ LOSPOR_DISABLE_RATE_LIMIT: "true" })
    expect(rateLimitingDisabledForTests()).toBe(true)
  })
})

describe("the switch is refused where it would matter", () => {
  const enabled = { LOSPOR_DISABLE_RATE_LIMIT: "true" }

  it("refuses in a production build, which is what the appliance runs", () => {
    setEnv({ ...enabled, NODE_ENV: "production" })
    expect(rateLimitingDisabledForTests()).toBe(false)
  })

  it("refuses on any Vercel deployment, preview included", () => {
    for (const environment of ["production", "preview", "development"]) {
      setEnv({ ...enabled, VERCEL_ENV: environment })
      expect(rateLimitingDisabledForTests(), `VERCEL_ENV=${environment}`).toBe(false)
    }
  })

  it("refuses when the connection string points at the production project", () => {
    // The last line of defence: even a development build with the variable set
    // will not disable brute-force protection on real patient data.
    setEnv({ ...enabled, DATABASE_URL: `postgresql://user:pass@db.${PROD_REF}.supabase.co:5432/postgres` })
    expect(rateLimitingDisabledForTests()).toBe(false)
  })

  it("allows it against a local database", () => {
    setEnv({ ...enabled, DATABASE_URL: "postgresql://lospor:lospor-e2e@127.0.0.1:55433/lospor_e2e" })
    expect(rateLimitingDisabledForTests()).toBe(true)
  })
})
