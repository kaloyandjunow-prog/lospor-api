import { describe, expect, it } from "vitest"
import { preopSchema, postopSchema } from "@/lib/schemas/case"
import { parseLenient } from "@/lib/lenient-parse"

/**
 * A clinical question answered "not asked" must survive the API boundary.
 *
 * The request schema declared these as `z.boolean().optional()`, which accepts
 * `undefined` and rejects `null`. Once the clients started sending an explicit
 * null for an unasked question, the lenient parser dropped every one of them
 * and reported them as rejected fields — so the web form refused to advance
 * past preop with "correct the rejected fields", and any client that ignored
 * the rejection list silently lost the answer instead.
 *
 * Nothing failed loudly. The case was created, the response was a 201, and the
 * fields were simply not there.
 */
const TRI_STATE_PREOP = [
  "allergies", "latexAllergy", "familyAnesthesiaProblems", "dentalProsthetics",
  "looseTeeth", "smoking", "substanceAbuse", "heartArrhythmia",
  "retrognathia", "prominentIncisors", "facialHair", "difficultAirwayHistory",
  "povocSurgeryAtLeast30Minutes", "povocAgeAtLeast3Years",
  "povocStrabismusSurgery", "povocHistory",
] as const

describe("a not-asked clinical question crosses the API boundary", () => {
  it("accepts null for every tri-state preop field", () => {
    const payload = Object.fromEntries(TRI_STATE_PREOP.map(field => [field, null]))
    const { value, rejected } = parseLenient(preopSchema, payload)
    expect(rejected, "fields the API refused").toEqual([])
    for (const field of TRI_STATE_PREOP) {
      expect(value, field).toHaveProperty(field, null)
    }
  })

  it("accepts null for postoperative nausea", () => {
    const { value, rejected } = parseLenient(postopSchema, { ponv: null })
    expect(rejected).toEqual([])
    expect(value).toHaveProperty("ponv", null)
  })

  it("still accepts a real answer of either kind", () => {
    // The negative control: accepting null by widening everything to unknown
    // would pass the tests above while dropping the answers that were given.
    const { value, rejected } = parseLenient(preopSchema, { smoking: false, latexAllergy: true })
    expect(rejected).toEqual([])
    expect(value).toHaveProperty("smoking", false)
    expect(value).toHaveProperty("latexAllergy", true)
  })

  it("still refuses null where the field is genuinely binary", () => {
    // These are not questions put to a patient: a tick a clinician makes, or a
    // fact with only two states. A null here is a client bug, and the API
    // should keep saying so.
    const { rejected } = parseLenient(preopSchema, { emergencySurgery: null, bpUnobtainable: null })
    expect(rejected.map(r => r.path).sort()).toEqual(["bpUnobtainable", "emergencySurgery"])
  })
})
