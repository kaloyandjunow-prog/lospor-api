import { describe, expect, it, vi } from "vitest"
import { canAccessCase, canAccessCaseWithOwnerFallback, caseWhereForUser, colleagueWhereForUser } from "@/lib/access-control"

describe("access control helpers", () => {
  it("falls back to own cases for a head of department without an institution", () => {
    const user = { id: "hod-1", role: "HEAD_OF_DEPT", institutionId: null }

    expect(caseWhereForUser(user)).toEqual({ userId: "hod-1" })
    expect(canAccessCase(user, { userId: "other", user: { institutionId: null } })).toBe(false)
    expect(canAccessCase(user, { userId: "hod-1", user: { institutionId: null } })).toBe(true)
  })

  it("scopes head of department access to their institution only when present", () => {
    const user = { id: "hod-1", role: "HEAD_OF_DEPT", institutionId: "inst-1" }

    // Scopes by the case's own institution snapshot and nothing else. It once
    // scoped by the owner's current institution, which let a case follow its
    // author to another hospital; the fallback for unstamped cases did the
    // same thing more quietly, so it is gone too.
    expect(caseWhereForUser(user)).toEqual({ institutionId: "inst-1" })
    expect(canAccessCase(user, { userId: "other", institutionId: "inst-1" })).toBe(true)
    expect(canAccessCase(user, { userId: "other", institutionId: "inst-2" })).toBe(false)
    // The owner's institution is not consulted, whichever it is.
    expect(canAccessCase(user, { userId: "other", user: { institutionId: "inst-1" } })).toBe(false)
    expect(canAccessCase(user, { userId: "other", user: { institutionId: "inst-2" } })).toBe(false)
  })

  it("no longer looks the owner up for an unstamped case", async () => {
    // The lookup answered "does this case belong to my department?" with
    // "where does its author work today?", so the same case changed hands
    // whenever its author moved.
    const findUnique = vi.fn().mockResolvedValue({ institutionId: "inst-1" })
    const db = { user: { findUnique } } as never
    const user = { id: "hod-1", role: "HEAD_OF_DEPT", institutionId: "inst-1" }

    await expect(canAccessCaseWithOwnerFallback(
      db,
      user,
      { userId: "other", institutionId: null },
    )).resolves.toBe(false)
    expect(findUnique).not.toHaveBeenCalled()
  })

  it("does not return colleagues for a head of department without an institution", () => {
    expect(colleagueWhereForUser({ id: "hod-1", role: "HEAD_OF_DEPT", institutionId: null })).toBeNull()
  })
})
