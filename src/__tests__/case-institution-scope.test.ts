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
  it("matches on the case's own institution, and on the owner's only when unset", () => {
    expect(headOfDeptCaseScope(HOSPITAL_A)).toEqual({
      OR: [
        { institutionId: HOSPITAL_A },
        { institutionId: null, user: { institutionId: HOSPITAL_A } },
      ],
    })
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
    const scopeA = headOfDeptCaseScope(HOSPITAL_A)
    const matchesA = scopeA.OR?.some(clause =>
      ("institutionId" in clause && clause.institutionId === caseAtA.institutionId)
      || (clause.institutionId === null && caseAtA.institutionId === null))
    expect(matchesA).toBe(true)

    const scopeB = headOfDeptCaseScope(HOSPITAL_B)
    const matchesB = scopeB.OR?.some(clause =>
      ("institutionId" in clause && clause.institutionId === caseAtA.institutionId)
      || (clause.institutionId === null && caseAtA.institutionId === null))
    expect(matchesB).toBe(false)
  })
})

describe("historical cases recorded before the snapshot existed", () => {
  // institutionId is null: fall back to the owner's current institution, which
  // is the best available evidence for where the case was performed.
  const legacyCase = {
    id: "case-old",
    userId: "owner-1",
    institutionId: null,
    user: { institutionId: HOSPITAL_A },
  }

  it("is visible to the owner's institution", () => {
    expect(canAccessCase(hod(HOSPITAL_A), legacyCase)).toBe(true)
  })

  it("is not visible to an unrelated institution", () => {
    expect(canAccessCase(hod(HOSPITAL_B), legacyCase)).toBe(false)
  })
})
