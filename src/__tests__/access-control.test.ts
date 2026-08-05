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

    // Scopes by the case's own institution snapshot, falling back to the
    // owner's only for historical rows that predate the snapshot. It used to
    // scope solely by the owner's current institution, which let a case follow
    // its author to a different hospital.
    expect(caseWhereForUser(user)).toEqual({
      OR: [
        { institutionId: "inst-1" },
        { institutionId: null, user: { institutionId: "inst-1" } },
      ],
    })
    expect(canAccessCase(user, { userId: "other", user: { institutionId: "inst-1" } })).toBe(true)
    expect(canAccessCase(user, { userId: "other", user: { institutionId: "inst-2" } })).toBe(false)
    expect(canAccessCase(user, { userId: "other", institutionId: "inst-1" })).toBe(true)
    expect(canAccessCase(user, { userId: "other", institutionId: "inst-2" })).toBe(false)
  })

  it("resolves legacy case institution ownership sequentially when the case field is empty", async () => {
    const findUnique = vi.fn().mockResolvedValue({ institutionId: "inst-1" })
    const db = { user: { findUnique } } as never
    const user = { id: "hod-1", role: "HEAD_OF_DEPT", institutionId: "inst-1" }

    await expect(canAccessCaseWithOwnerFallback(
      db,
      user,
      { userId: "other", institutionId: null },
    )).resolves.toBe(true)
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "other" },
      select: { institutionId: true },
    })
  })

  it("does not return colleagues for a head of department without an institution", () => {
    expect(colleagueWhereForUser({ id: "hod-1", role: "HEAD_OF_DEPT", institutionId: null })).toBeNull()
  })
})
