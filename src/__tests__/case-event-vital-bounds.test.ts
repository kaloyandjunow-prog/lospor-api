import { describe, expect, it } from "vitest"

import { caseEventSchema } from "@/lib/case-event-schema"

/**
 * The events route accepted any number a client sent.
 *
 * Its schema bounds doses, rates and volumes, and then declared no vital at
 * all -- so every reading arrived through `.passthrough()` and was coerced with
 * a bare `Number()`. A BIS of -500 and a train-of-four of 20 were stored
 * without complaint, and the only thing between the database and either was a
 * control in a client the server does not run.
 */
describe("a charted vital has to be a possible reading", () => {
  const vital = (fields: Record<string, unknown>) =>
    caseEventSchema.safeParse({ type: "vital", ts: "2026-09-05T09:40:00Z", ...fields })

  it("refuses a value no patient could produce", () => {
    expect(vital({ bis: -500 }).success).toBe(false)
    expect(vital({ bis: 101 }).success).toBe(false)
    // A train-of-four is a fraction. 20 is somebody typing a count.
    expect(vital({ tofRatio: 20 }).success).toBe(false)
    expect(vital({ spO2: 5000 }).success).toBe(false)
    expect(vital({ heartRate: -40 }).success).toBe(false)
  })

  it("accepts the readings a clinician actually charts", () => {
    expect(vital({ bis: 38, tofRatio: 0.4, cvp: 7.4 }).success).toBe(true)
    expect(vital({ systolic: 118, diastolic: 70, heartRate: 76, spO2: 99 }).success).toBe(true)
    expect(vital({ etco2: 36, temp: 36.5 }).success).toBe(true)
  })

  /**
   * A BIS of 0 is an isoelectric EEG and a train-of-four of 0 is a fully
   * paralysed patient. Both are readings, and a bound that excluded them would
   * refuse exactly the two values that matter most.
   */
  it("accepts a charted zero", () => {
    expect(vital({ bis: 0 }).success).toBe(true)
    expect(vital({ tofRatio: 0 }).success).toBe(true)
  })

  it("treats a cleared field as not recorded rather than as a value", () => {
    expect(vital({ bis: "" }).success).toBe(true)
    expect(vital({ bis: null }).success).toBe(true)
  })

  it("refuses a fractional reading where only whole numbers exist", () => {
    // A BIS is read off the monitor as an integer.
    expect(vital({ bis: 38.5 }).success).toBe(false)
  })

  it("still accepts the legacy keys passthrough exists for", () => {
    expect(vital({ somethingOlder: "kept" }).success).toBe(true)
  })
})
