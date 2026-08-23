import { describe, expect, it } from "vitest"
import {
  researchSelfAuthorizationExpiry,
  researchSelfAuthorizationStatus,
} from "./self-authorization"

describe("research self-authorization policy", () => {
  const now = new Date("2026-08-22T12:00:00.000Z")

  it("grants exactly eight hours", () => {
    expect(researchSelfAuthorizationExpiry(now).toISOString()).toBe("2026-08-22T20:00:00.000Z")
  })

  it("allows first use and enforces a rolling 24-hour cooldown", () => {
    expect(researchSelfAuthorizationStatus(null, now)).toEqual({ eligible: true, nextEligibleAt: now })
    const issued = new Date("2026-08-22T11:59:59.000Z")
    expect(researchSelfAuthorizationStatus(issued, now)).toMatchObject({ eligible: false })
    expect(researchSelfAuthorizationStatus(issued, new Date("2026-08-23T11:59:59.000Z")))
      .toMatchObject({ eligible: true })
  })
})
