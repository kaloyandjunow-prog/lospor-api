import { describe, it, expect } from "vitest"
import { z } from "zod"
import { intraopSchema } from "@/lib/schemas/case"
import { parseLenient } from "@/lib/lenient-parse"
import { mapIntraopUpdate } from "@/app/v1/cases/_mappers"

// bloodLossMl is the first intraoperative quantity a clinician types rather than
// one projected from the fluid events, so it inherits the whole class of bugs
// that numeric preop fields have already been through twice — most recently the
// pediatric-to-adult trap, where `undefined` was dropped from a patch instead of
// clearing a value and the server then refused every retry.
//
// The distinction these tests exist to protect: for blood loss, "not recorded"
// and "0 mL" are different clinical statements. A patient who did not bleed and
// a patient nobody measured must never collapse into the same stored value.
describe("bloodLossMl keeps not-recorded and zero distinct", () => {
  it("does not emit the key when the client never sent it", () => {
    const update = mapIntraopUpdate(intraopSchema.parse({ urineMl: 200 }) as Record<string, unknown>)

    expect(update.urineMl).toBe(200)
    expect("bloodLossMl" in update).toBe(false)
  })

  it("stores an explicit 0 as 0, not as absent", () => {
    const update = mapIntraopUpdate(intraopSchema.parse({ bloodLossMl: 0 }) as Record<string, unknown>)

    expect("bloodLossMl" in update).toBe(true)
    expect(update.bloodLossMl).toBe(0)
  })

  it("clears to null when the user empties the field", () => {
    // "" and null are both the clinician actively blanking it. Either must
    // persist as null, or a value could never be removed once entered.
    expect(mapIntraopUpdate(intraopSchema.parse({ bloodLossMl: "" }) as Record<string, unknown>).bloodLossMl).toBeNull()
    expect(mapIntraopUpdate(intraopSchema.parse({ bloodLossMl: null }) as Record<string, unknown>).bloodLossMl).toBeNull()
  })

  it("passes through and rounds a recorded volume", () => {
    expect(mapIntraopUpdate(intraopSchema.parse({ bloodLossMl: 450 }) as Record<string, unknown>).bloodLossMl).toBe(450)
    expect(mapIntraopUpdate(intraopSchema.parse({ bloodLossMl: 450.6 }) as Record<string, unknown>).bloodLossMl).toBe(451)
  })

  it("rejects a typo instead of silently clearing a real measurement", () => {
    const parsed = intraopSchema.safeParse({ bloodLossMl: "45O" })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some(i => i.path.join(".") === "bloodLossMl")).toBe(true)
    }
  })

  it("a typo does not reach the update mapper as a null", () => {
    const { value, rejected } = parseLenient(
      z.object({ intraop: intraopSchema.optional() }),
      { intraop: { bloodLossMl: "45O", urineMl: 200 } },
    )

    expect(rejected.map(r => r.path)).toContain("intraop.bloodLossMl")
    const update = mapIntraopUpdate(value.intraop as Record<string, unknown>)
    expect("bloodLossMl" in update).toBe(false)
    expect(update.urineMl).toBe(200)
  })

  it("rejects a physically impossible volume", () => {
    expect(intraopSchema.safeParse({ bloodLossMl: -1 }).success).toBe(false)
    expect(intraopSchema.safeParse({ bloodLossMl: 20_001 }).success).toBe(false)
    expect(intraopSchema.safeParse({ bloodLossMl: 20_000 }).success).toBe(true)
  })
})
