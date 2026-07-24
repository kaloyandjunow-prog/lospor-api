import { describe, it, expect } from "vitest"
import { z } from "zod"
import { parseLenient } from "@/lib/lenient-parse"

const preop = z.object({
  ageYears: z.coerce.number().min(0).max(149).optional(),
  heightCm: z.coerce.number().min(30).max(280).optional(),
  weightKg: z.coerce.number().min(0.1).max(700).optional(),
  asaClass: z.string().optional(),
})
const body = z.object({
  notes: z.string().max(10).nullable().optional(),
  preop: preop.optional(),
})

describe("parseLenient", () => {
  it("returns the payload untouched when everything is valid", () => {
    const { value, rejected } = parseLenient(body, { preop: { heightCm: 175, weightKg: 80 } })
    expect(rejected).toEqual([])
    expect(value.preop).toEqual({ heightCm: 175, weightKg: 80 })
  })

  // The reported bug: a half-entered height (below the 30 cm floor) used to 400
  // the whole request, so every other edit in that autosave was discarded too.
  it("keeps the rest of the section when one field is out of range", () => {
    const { value, rejected } = parseLenient(body, {
      preop: { heightCm: 17, weightKg: 80, asaClass: "II", ageYears: 64 },
    })
    expect(value.preop).toEqual({ weightKg: 80, asaClass: "II", ageYears: 64 })
    expect(rejected).toHaveLength(1)
    expect(rejected[0].path).toBe("preop.heightCm")
  })

  it("reports every offending field, not just the first", () => {
    const { value, rejected } = parseLenient(body, {
      preop: { heightCm: 2, weightKg: 0, asaClass: "III" },
    })
    expect(value.preop).toEqual({ asaClass: "III" })
    expect(rejected.map(r => r.path).sort()).toEqual(["preop.heightCm", "preop.weightKg"])
  })

  it("drops an invalid top-level field but keeps a valid section", () => {
    const { value, rejected } = parseLenient(body, {
      notes: "far too long to be accepted",
      preop: { heightCm: 180 },
    })
    expect(value.preop).toEqual({ heightCm: 180 })
    expect(value.notes).toBeUndefined()
    expect(rejected.map(r => r.path)).toEqual(["notes"])
  })

  it("carries a human-readable reason for each rejection", () => {
    const { rejected } = parseLenient(body, { preop: { heightCm: 5 } })
    expect(rejected[0].message).toMatch(/30/)
  })

  it("leaves boundary values alone", () => {
    const { value, rejected } = parseLenient(body, {
      preop: { heightCm: 30, weightKg: 0.1, ageYears: 149 },
    })
    expect(rejected).toEqual([])
    expect(value.preop).toEqual({ heightCm: 30, weightKg: 0.1, ageYears: 149 })
  })

  it("still throws when the body itself is the wrong shape", () => {
    // Nothing to salvage — a non-object payload is a real client error.
    expect(() => parseLenient(body, "not an object")).toThrow()
  })

  it("does not invent fields that were never sent", () => {
    const { value } = parseLenient(body, { preop: { heightCm: 9 } })
    expect(value.preop).toEqual({})
    expect(Object.keys(value)).toEqual(["preop"])
  })
})
