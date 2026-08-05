import { describe, expect, it } from "vitest"
import { NO_INSTITUTION, NO_INSTITUTION_ID, canHaveHeadOfDepartment } from "./institutions"
import { headOfDeptCaseScope } from "./access-control"

describe("Без институция", () => {
  it("is a real institution with a fixed id, not a null", () => {
    // Null institutions were what let cases drift between departments.
    expect(NO_INSTITUTION.id).toBe(NO_INSTITUTION_ID)
    expect(NO_INSTITUTION.name).toBe("Без институция")
  })

  it("cannot have a head of department", () => {
    // Its members share no workplace, so a head there would see every
    // unaffiliated clinician's cases in the whole register.
    expect(canHaveHeadOfDepartment(NO_INSTITUTION_ID)).toBe(false)
  })

  it("lets a real institution have one", () => {
    expect(canHaveHeadOfDepartment("clx1234institution")).toBe(true)
  })

  it("treats a missing institution as ineligible rather than allowed", () => {
    expect(canHaveHeadOfDepartment(null)).toBe(false)
    expect(canHaveHeadOfDepartment(undefined)).toBe(false)
    expect(canHaveHeadOfDepartment("")).toBe(false)
  })
})

/**
 * A head of department sees the cases their department recorded, and nothing
 * else. The scope used to carry a second clause matching cases with **no**
 * institution owned by somebody currently in this one, which meant a clinician
 * who recorded cases while unaffiliated and then joined a department handed
 * that department's head every case they had ever recorded.
 */
describe("what a head of department can see", () => {
  it("is exactly the cases stamped with their institution", () => {
    expect(headOfDeptCaseScope("inst-a")).toEqual({ institutionId: "inst-a" })
  })

  it("no longer reaches unstamped cases through the owner's current institution", () => {
    const scope = headOfDeptCaseScope("inst-b") as Record<string, unknown>
    expect(scope.OR).toBeUndefined()
    expect(JSON.stringify(scope)).not.toContain("null")
    expect(JSON.stringify(scope)).not.toContain("user")
  })

  it("does not follow a clinician who moves — cases stay where they were recorded", () => {
    // Alice records at A, then joins B. Her A-stamped cases match A's scope and
    // not B's, whatever her current institution is.
    const atA = headOfDeptCaseScope("inst-a")
    const atB = headOfDeptCaseScope("inst-b")
    expect(atA).not.toEqual(atB)
    expect(atB).toEqual({ institutionId: "inst-b" })
  })
})
