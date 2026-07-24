import { describe, it, expect } from "vitest"
import { preopSchema, postopSchema } from "@/lib/schemas/case"

describe("preopSchema", () => {
  it("accepts a minimal mobile preop payload", () => {
    const result = preopSchema.safeParse({
      sex: "MALE",
      asaScore: "I",
      diagnoses: [],
      procedures: [],
      bpSystolic: 125,
      bpDiastolic: 78,
      heartRate: 72,
      spO2: 98,
      temperature: 36.6,
    })
    expect(result.success).toBe(true)
  })

  it("accepts an empty payload (all fields optional)", () => {
    expect(preopSchema.safeParse({}).success).toBe(true)
  })

  it("coerces string numbers to numbers", () => {
    const result = preopSchema.safeParse({ ageYears: "45", bpSystolic: "130" })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.ageYears).toBe(45)
      expect(result.data.bpSystolic).toBe(130)
    }
  })

  it("accepts persisted preop free-text fields", () => {
    const result = preopSchema.safeParse({
      physicalExamReport: "Normal heart sounds.",
      notes: "Patient prefers regional if possible.",
    })
    expect(result.success).toBe(true)
  })

  it("accepts UNKNOWN as a distinct sex value, and rejects nonsense", () => {
    // UNKNOWN is now a real value — it is how "not recorded" is represented,
    // instead of being silently folded into OTHER.
    expect(preopSchema.safeParse({ sex: "UNKNOWN" }).success).toBe(true)
    expect(preopSchema.safeParse({ sex: "NOT_A_SEX" }).success).toBe(false)
  })

  it("rejects invalid ASA class", () => {
    expect(preopSchema.safeParse({ asaScore: "VII" }).success).toBe(false)
  })

  it("passes unknown extra fields through (passthrough)", () => {
    const result = preopSchema.safeParse({ sex: "FEMALE", customField: true })
    expect(result.success).toBe(true)
    if (result.success) {
      expect((result.data as Record<string, unknown>).customField).toBe(true)
    }
  })
})

describe("postopSchema", () => {
  it("accepts minimal recovery vitals", () => {
    const result = postopSchema.safeParse({
      recoveryBpSystolic: 118,
      recoveryBpDiastolic: 76,
      recoveryHeartRate: 68,
      recoverySpO2: 97,
    })
    expect(result.success).toBe(true)
  })

  it("rejects Aldrete subscore outside 0-2", () => {
    expect(postopSchema.safeParse({ aldreteActivity: 3 }).success).toBe(false)
    expect(postopSchema.safeParse({ aldreteActivity: -1 }).success).toBe(false)
  })
})
