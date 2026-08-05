import { describe, expect, it } from "vitest"
import { canAccessCase, caseWhereForUser, headOfDeptCaseScope } from "../lib/access-control"
import type { AuthUser } from "../lib/mobile-auth"

/**
 * A case belongs to the institution it was performed at.
 *
 * `canAccessCase` already honoured the `Case.institutionId` snapshot, but
 * `caseWhereForUser` — which backs list, detail, version, print, PDF, lock and
 * transfer — scoped by the *owner's current* institution. The two disagreed, and
 * the disagreement was clinical: when a colleague moved hospitals, the cases
 * they had performed at the old one dropped out of that department's list and
 * appeared in the new department's. A head of department could see case metadata
 * for operations carried out somewhere else, and the department that did the
 * work lost sight of it.
 */
const hod = (institutionId: string): AuthUser => ({
  id: "hod-1", role: "HEAD_OF_DEPT", institutionId,
} as AuthUser)

const HOSPITAL_A = "inst-a"
const HOSPITAL_B = "inst-b"

describe("headOfDeptCaseScope", () => {
  it("matches on the case's own institution and nothing else", () => {
    // The owner fallback is gone. It matched unstamped cases through whoever
    // owned them, so a clinician who recorded cases while unaffiliated and
    // then joined a department handed that department's head everything they
    // had ever recorded. Registration now requires an institution and every
    // case is stamped at creation, so there is nothing left for it to catch.
    expect(headOfDeptCaseScope(HOSPITAL_A)).toEqual({ institutionId: HOSPITAL_A })
  })
})

describe("caseWhereForUser", () => {
  it("scopes a head of department by the case's institution, not the owner's", () => {
    const where = caseWhereForUser(hod(HOSPITAL_A))
    expect(where).toEqual(headOfDeptCaseScope(HOSPITAL_A))
    // The old behaviour, which let a case follow its author.
    expect(where).not.toEqual({ user: { institutionId: HOSPITAL_A } })
  })

  it("keeps the id constraint alongside the institution scope", () => {
    expect(caseWhereForUser(hod(HOSPITAL_A), "case-1")).toMatchObject({ id: "case-1" })
  })

  it("gives an admin everything", () => {
    expect(caseWhereForUser({ id: "a", role: "ADMIN" } as AuthUser)).toEqual({})
  })

  it("gives an ordinary member only their own cases", () => {
    expect(caseWhereForUser({ id: "u-1", role: "MEMBER" } as AuthUser))
      .toEqual({ userId: "u-1" })
  })

  it("falls back to own-cases for a head of department with no institution", () => {
    expect(caseWhereForUser({ id: "h", role: "HEAD_OF_DEPT" } as AuthUser))
      .toEqual({ userId: "h" })
  })
})

describe("a case does not follow its author to another hospital", () => {
  // The owner has moved from Hospital A to Hospital B. The case was performed
  // at A and carries that snapshot.
  const caseAtA = {
    id: "case-1",
    userId: "owner-1",
    institutionId: HOSPITAL_A,
    user: { institutionId: HOSPITAL_B },
  }

  it("stays visible to the hospital where it was performed", () => {
    expect(canAccessCase(hod(HOSPITAL_A), caseAtA)).toBe(true)
  })

  it("is not visible to the hospital the author moved to", () => {
    expect(canAccessCase(hod(HOSPITAL_B), caseAtA)).toBe(false)
  })

  it("the query predicate agrees with the in-memory check", () => {
    // Both must encode the same rule, or a list and a detail view disagree
    // about the same case — which is how the two drifted apart originally.
    expect(headOfDeptCaseScope(HOSPITAL_A).institutionId).toBe(caseAtA.institutionId)
    expect(canAccessCase(hod(HOSPITAL_A), caseAtA)).toBe(true)

    expect(headOfDeptCaseScope(HOSPITAL_B).institutionId).not.toBe(caseAtA.institutionId)
    expect(canAccessCase(hod(HOSPITAL_B), caseAtA)).toBe(false)
  })
})

/**
 * A case with no institution belongs to no department.
 *
 * It used to resolve through its owner's *current* institution, on the reasoning
 * that this was the best available evidence of where it was performed. It is
 * not evidence: it is wherever that clinician happens to work now. A clinician
 * who recorded cases while unaffiliated and then joined a department handed
 * that department's head everything they had ever recorded, and the same case
 * changed hands again on every subsequent move.
 *
 * Registration now requires an institution — anyone without a department picks
 * "Без институция" — and every case is stamped at creation, so no new case can
 * land here. The ones that already exist stay with the clinician who recorded
 * them, and with administrators.
 */
describe("historical cases recorded before the snapshot existed", () => {
  const legacyCase = {
    id: "case-old",
    userId: "owner-1",
    institutionId: null,
    user: { institutionId: HOSPITAL_A },
  }

  it("is not visible to the head of the institution its author now works in", () => {
    expect(canAccessCase(hod(HOSPITAL_A), legacyCase)).toBe(false)
  })

  it("is not visible to an unrelated institution either", () => {
    expect(canAccessCase(hod(HOSPITAL_B), legacyCase)).toBe(false)
  })

  it("stays visible to the clinician who recorded it", () => {
    expect(canAccessCase({ id: "owner-1", role: "MEMBER" }, legacyCase)).toBe(true)
  })

  it("stays visible to an administrator", () => {
    expect(canAccessCase({ id: "someone", role: "ADMIN" }, legacyCase)).toBe(true)
  })
})
