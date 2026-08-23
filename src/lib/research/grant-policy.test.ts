import { describe, expect, it } from "vitest"
import {
  RESEARCH_GRANT_DEFAULT_DAYS,
  researchGrantExpiry,
} from "./grant-policy"

describe("research grant expiry policy", () => {
  const now = new Date("2026-08-22T00:00:00.000Z")

  it("defaults to 90 days", () => {
    expect(researchGrantExpiry(undefined, now).toISOString()).toBe(
      new Date(now.getTime() + RESEARCH_GRANT_DEFAULT_DAYS * 86_400_000).toISOString(),
    )
  })

  it("accepts the maximum 365-day lifetime", () => {
    const maximum = new Date(now.getTime() + 365 * 86_400_000).toISOString()
    expect(researchGrantExpiry(maximum, now).toISOString()).toBe(maximum)
  })

  it("rejects expired and overlong grants", () => {
    expect(() => researchGrantExpiry(now.toISOString(), now)).toThrow("future")
    expect(() => researchGrantExpiry(
      new Date(now.getTime() + 366 * 86_400_000).toISOString(),
      now,
    )).toThrow("365")
  })
})
