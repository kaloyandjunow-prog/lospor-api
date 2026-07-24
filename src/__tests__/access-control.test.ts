import { describe, expect, it } from "vitest"
import { canAccessCase, caseWhereForUser, colleagueWhereForUser } from "@/lib/access-control"

describe("access control helpers", () => {
  it("falls back to own cases for a head of department without an institution", () => {
    const user = { id: "hod-1", role: "HEAD_OF_DEPT", institutionId: null }

    expect(caseWhereForUser(user)).toEqual({ userId: "hod-1" })
    expect(canAccessCase(user, { userId: "other", user: { institutionId: null } })).toBe(false)
    expect(canAccessCase(user, { userId: "hod-1", user: { institutionId: null } })).toBe(true)
  })

  it("scopes head of department access to their institution only when present", () => {
    const user = { id: "hod-1", role: "HEAD_OF_DEPT", institutionId: "inst-1" }

    expect(caseWhereForUser(user)).toEqual({ user: { institutionId: "inst-1" } })
    expect(canAccessCase(user, { userId: "other", user: { institutionId: "inst-1" } })).toBe(true)
    expect(canAccessCase(user, { userId: "other", user: { institutionId: "inst-2" } })).toBe(false)
  })

  it("does not return colleagues for a head of department without an institution", () => {
    expect(colleagueWhereForUser({ id: "hod-1", role: "HEAD_OF_DEPT", institutionId: null })).toBeNull()
  })
})
