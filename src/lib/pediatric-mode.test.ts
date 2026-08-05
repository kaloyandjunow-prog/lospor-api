import { describe, expect, it } from "vitest"
import { PEDIATRIC_PRODUCTION_READY } from "@lospor/core/pediatric"
import {
  decidePediatricCaseMutation,
  decidePediatricWrite,
  isPediatricModeEnabled,
  isVersionAtLeast,
} from "./pediatric-mode"

describe("pediatric API gate", () => {
  it("enables development but requires clinical readiness and an explicit production flag", () => {
    // Production needs BOTH: the reviewed clinical manifest (productionReady)
    // and the deployment flag. Each is passed explicitly here rather than
    // relying on the shipped PEDIATRIC_PRODUCTION_READY constant, so these cases
    // pin the gate's logic and do not have to be rewritten every time the
    // clinical sign-off changes.
    expect(isPediatricModeEnabled({ NODE_ENV: "development" })).toBe(true)
    expect(isPediatricModeEnabled({ NODE_ENV: "production" }, true)).toBe(false)

    // Clinically reviewed, but not switched on in this deployment.
    expect(isPediatricModeEnabled({
      NODE_ENV: "production",
      PEDIATRIC_MODE_ENABLED: "false",
    }, true)).toBe(false)

    // Switched on, but the manifest has not been signed off.
    expect(isPediatricModeEnabled({
      NODE_ENV: "production",
      PEDIATRIC_MODE_ENABLED: "true",
    }, false)).toBe(false)

    // Both.
    expect(isPediatricModeEnabled({
      NODE_ENV: "production",
      PEDIATRIC_MODE_ENABLED: "true",
    }, true)).toBe(true)
  })

  it("ships with the clinical manifest signed off", () => {
    // Separate from the logic above: this records the current clinical
    // decision, so flipping it back is a deliberate, visible change.
    expect(PEDIATRIC_PRODUCTION_READY).toBe(true)
  })

  it("rejects pediatric mutations from an old client", () => {
    expect(decidePediatricCaseMutation({
      clinicalMode: "PEDIATRIC",
      clientVersion: "7.9.9",
      featureEnabled: true,
    })).toMatchObject({
      allowed: false,
      code: "PEDIATRIC_CLIENT_UPDATE_REQUIRED",
      status: 426,
    })
  })

  it("compares semantic client versions", () => {
    expect(isVersionAtLeast("8.0.0", "8.0.0")).toBe(true)
    expect(isVersionAtLeast("8.1.0", "8.0.0")).toBe(true)
    expect(isVersionAtLeast("7.9.9", "8.0.0")).toBe(false)
    expect(isVersionAtLeast(null, "8.0.0")).toBe(false)
  })

  it("requires a mode decision for a new under-18 adult case", () => {
    expect(decidePediatricWrite({
      clinicalMode: "ADULT",
      preop: { ageYears: 10 },
      clientVersion: "8.0.0",
      enforceAgeDecision: true,
    })).toMatchObject({ allowed: false, code: "PEDIATRIC_MODE_REQUIRED", status: 409 })
  })

  it("requires precise age and a v8 client for pediatric writes", () => {
    expect(decidePediatricWrite({
      clinicalMode: "PEDIATRIC",
      preop: { ageValue: 6, ageUnit: "MONTHS" },
      clientVersion: "7.3.0",
      featureEnabled: true,
      enforceAgeDecision: true,
    })).toMatchObject({ allowed: false, code: "PEDIATRIC_CLIENT_UPDATE_REQUIRED", status: 426 })
    expect(decidePediatricWrite({
      clinicalMode: "PEDIATRIC",
      preop: { ageYears: 1 },
      clientVersion: "8.0.0",
      featureEnabled: true,
      enforceAgeDecision: true,
    })).toMatchObject({ allowed: false, code: "PEDIATRIC_AGE_REQUIRED", status: 422 })
  })

  it("allows an incomplete pediatric draft while age is being entered", () => {
    expect(decidePediatricWrite({
      clinicalMode: "PEDIATRIC",
      preop: {},
      clientVersion: "8.0.0",
      featureEnabled: true,
      enforceAgeDecision: true,
      allowIncompleteAge: true,
    })).toMatchObject({
      allowed: true,
      clinicalMode: "PEDIATRIC",
      clinicalRulesVersion: "2026.08.04-release.1",
    })
  })

  it("allows reviewed-rule capture for a precise pediatric age", () => {
    expect(decidePediatricWrite({
      clinicalMode: "PEDIATRIC",
      preop: { ageValue: 6, ageUnit: "MONTHS" },
      clientVersion: "8.0.0",
      featureEnabled: true,
      enforceAgeDecision: true,
    })).toMatchObject({
      allowed: true,
      clinicalMode: "PEDIATRIC",
      clinicalRulesVersion: "2026.08.04-release.1",
    })
  })
})
