import { describe, expect, it } from "vitest"
import { institutionRequestScope } from "./institution-requests"

/**
 * Approving a request to change institution is the moment someone joins a
 * department and its head gains sight of their cases. So the scope keys on the
 * institution being *joined*, not the one being left.
 *
 * Getting that backwards would invert the guarantee: a head of department could
 * post clinicians *out* of their department into ones they have no authority
 * over, and would be unable to vet who joins their own.
 */
describe("who may resolve a request to change institution", () => {
  const member = { id: "u1", role: "MEMBER", institutionId: "inst-a" }
  const hod = { id: "u2", role: "HEAD_OF_DEPT", institutionId: "inst-a" }
  const admin = { id: "u3", role: "ADMIN", institutionId: "inst-b" }

  it("lets an administrator see every request", () => {
    expect(institutionRequestScope(admin)).toEqual({})
  })

  it("scopes a head of department to the institution being joined", () => {
    expect(institutionRequestScope(hod)).toEqual({ requestedInstitutionId: "inst-a" })
  })

  it("does not scope them by the institution being left", () => {
    // The distinction the whole feature rests on.
    const scope = institutionRequestScope(hod)
    expect(scope).not.toHaveProperty("previousInstitutionId")
    expect(scope).not.toHaveProperty("userId")
  })

  it("refuses a member, and anyone not signed in", () => {
    expect(institutionRequestScope(member)).toBeNull()
    expect(institutionRequestScope(null)).toBeNull()
    expect(institutionRequestScope(undefined)).toBeNull()
  })

  it("refuses a head of department with no institution of their own", () => {
    // Otherwise the scope would be empty, which reads as "everything".
    expect(institutionRequestScope({ id: "u4", role: "HEAD_OF_DEPT", institutionId: null })).toBeNull()
  })
})
