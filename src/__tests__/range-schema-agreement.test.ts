import { describe, it, expect } from "vitest"
import { CLINICAL_RANGES, type ClinicalRangeKey } from "@lospor/core"
import { preopSchema, postopSchema } from "@/lib/schemas/case"

/**
 * The pickers and the API must agree about what a valid number is.
 *
 * A picker that offers a value the API refuses is not cosmetic. The save is
 * rejected, and before the create path was made lenient one such value took the
 * entire preoperative assessment with it — the reported "height picker starts
 * at 0, and going back to the dashboard loses everything".
 *
 * That was not a single slip. When this test was first written it failed on
 * four ranges nobody had noticed: systolic offered from 1 against an API floor
 * of 40, diastolic from 1 against 20, heart rate from 1 against 10, and
 * temperature from 0 against 25. Reading the code had found only the height and
 * weight cases; feeding the real bounds through the real schema found the rest.
 *
 * Every range is checked at both ends, in the schema that actually stores it.
 */

type Case = { key: ClinicalRangeKey; field: string; schema: "preop" | "postop" }

// Which schema field each picker range feeds. Ranges without a bounded schema
// field (mouth opening, thyromental, Aldrete, pain) are covered by the
// no-silent-additions test at the bottom instead.
const MAPPED: Case[] = [
  { key: "AGE_RANGE",              field: "ageYears",           schema: "preop" },
  { key: "HEIGHT_RANGE",           field: "heightCm",           schema: "preop" },
  { key: "WEIGHT_RANGE",           field: "weightKg",           schema: "preop" },
  { key: "BP_SYSTOLIC_RANGE",      field: "bpSystolic",         schema: "preop" },
  { key: "BP_DIASTOLIC_RANGE",     field: "bpDiastolic",        schema: "preop" },
  { key: "HEART_RATE_RANGE",       field: "heartRate",          schema: "preop" },
  { key: "SPO2_RANGE",             field: "spO2",               schema: "preop" },
  { key: "TEMPERATURE_RANGE",      field: "temperature",        schema: "preop" },
  { key: "RESPIRATORY_RATE_RANGE", field: "respiratoryRate",    schema: "preop" },
  { key: "BP_SYSTOLIC_RANGE",      field: "recoveryBpSystolic", schema: "postop" },
  { key: "BP_DIASTOLIC_RANGE",     field: "recoveryBpDiastolic",schema: "postop" },
  { key: "HEART_RATE_RANGE",       field: "recoveryHeartRate",  schema: "postop" },
  { key: "SPO2_RANGE",             field: "recoverySpO2",       schema: "postop" },
  { key: "TEMPERATURE_RANGE",      field: "temperatureCelsius", schema: "postop" },
  { key: "PAIN_NRS_RANGE",         field: "painScoreNRS",       schema: "postop" },
]

const schemaFor = (s: "preop" | "postop") => (s === "preop" ? preopSchema : postopSchema)

function accepts(schema: "preop" | "postop", field: string, value: number): boolean {
  const result = schemaFor(schema).safeParse({ [field]: value })
  if (result.success) return true
  // Only care about failures on the field under test — other fields being
  // absent or invalid is irrelevant here.
  return !result.error.issues.some(i => i.path[0] === field)
}

describe("every picker range is accepted by the API", () => {
  for (const { key, field, schema } of MAPPED) {
    const range = CLINICAL_RANGES[key]

    it(`${schema}.${field} accepts ${key} minimum (${range.min})`, () => {
      expect(accepts(schema, field, range.min)).toBe(true)
    })

    it(`${schema}.${field} accepts ${key} maximum (${range.max})`, () => {
      expect(accepts(schema, field, range.max)).toBe(true)
    })
  }
})

describe("the specific values that were reported or found broken", () => {
  it("refuses a height of 12 cm — the reported case", () => {
    expect(accepts("preop", "heightCm", 12)).toBe(false)
  })

  it("no longer lets a picker reach that value", () => {
    // The point of the fix: 12 is below what any picker can now offer.
    expect(CLINICAL_RANGES.HEIGHT_RANGE.min).toBeGreaterThan(12)
  })

  it("does not offer a systolic, diastolic, heart rate or temperature the API refuses", () => {
    // The four this test caught that reading the code had not.
    expect(accepts("preop", "bpSystolic",  CLINICAL_RANGES.BP_SYSTOLIC_RANGE.min)).toBe(true)
    expect(accepts("preop", "bpDiastolic", CLINICAL_RANGES.BP_DIASTOLIC_RANGE.min)).toBe(true)
    expect(accepts("preop", "heartRate",   CLINICAL_RANGES.HEART_RATE_RANGE.min)).toBe(true)
    expect(accepts("preop", "temperature", CLINICAL_RANGES.TEMPERATURE_RANGE.min)).toBe(true)
  })
})

describe("a whole number is always on the picker grid", () => {
  // The gap that shipped in 5.4.1: raising weight's minimum to 0.5 while its
  // step stayed 1 put every valid value on a half-kilo (…104.5, 105.5), so a
  // clinician could not enter a whole number of kilograms — the commonest
  // input there is. The API accepted the min and max, so the earlier check
  // passed while the picker was unusable. A stepper's valid values are
  // min + n*step, so a whole number is reachable only when (wholeNumber - min)
  // is a whole multiple of step.
  const onGrid = (value: number, min: number, step: number) => {
    const steps = (value - min) / step
    return Math.abs(steps - Math.round(steps)) < 1e-9
  }

  for (const key of Object.keys(CLINICAL_RANGES) as ClinicalRangeKey[]) {
    const r = CLINICAL_RANGES[key]
    // A whole kilo/cm/mmHg near the middle of the range — a value a clinician
    // will actually type.
    const mid = Math.round((r.min + r.max) / 2)
    it(`${key} accepts the whole number ${mid}`, () => {
      expect(onGrid(mid, r.min, r.step)).toBe(true)
    })
  }
})

describe("ranges are internally coherent", () => {
  for (const key of Object.keys(CLINICAL_RANGES) as ClinicalRangeKey[]) {
    it(`${key} has min < max and a positive step`, () => {
      const r = CLINICAL_RANGES[key]
      expect(r.min).toBeLessThan(r.max)
      expect(r.step).toBeGreaterThan(0)
    })
  }

  it("has no unmapped range that silently escapes the schema check", () => {
    // Adding a range without deciding which schema field it feeds should be a
    // deliberate act, not an oversight — so the exceptions are listed here.
    const UNBOUNDED: ClinicalRangeKey[] = [
      "MOUTH_OPENING_RANGE",    // schema: coerceNum, no bounds
      "THYROMENTAL_RANGE",      // schema: coerceNum, no bounds
      "ALDRETE_SUBSCORE_RANGE", // stored as individual 0-2 subscores
    ]
    const mapped = new Set(MAPPED.map(m => m.key))
    const unaccounted = (Object.keys(CLINICAL_RANGES) as ClinicalRangeKey[])
      .filter(k => !mapped.has(k) && !UNBOUNDED.includes(k))
    expect(unaccounted).toEqual([])
  })
})
