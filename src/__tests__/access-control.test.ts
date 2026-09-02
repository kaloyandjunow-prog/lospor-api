import { describe, expect, it, vi } from "vitest"
import {
  canReadCase,
  canAccessCaseWithOwnerFallback,
  canWriteCase,
  caseCapabilitiesForUser,
  caseReadWhereForUser,
  caseWriteWhereForUser,
  colleagueWhereForUser,
} from "@/lib/access-control"

describe("access control helpers", () => {
  it("falls back to own cases for a head of department without an institution", () => {
    const user = { id: "hod-1", role: "HEAD_OF_DEPT", institutionId: null }

    expect(caseReadWhereForUser(user)).toEqual({ userId: "hod-1" })
    expect(canReadCase(user, { userId: "other", user: { institutionId: null } })).toBe(false)
    expect(canReadCase(user, { userId: "hod-1", user: { institutionId: null } })).toBe(true)
  })

  it("scopes head of department access to their institution, plus their own cases anywhere", () => {
    const user = { id: "hod-1", role: "HEAD_OF_DEPT", institutionId: "inst-1" }

    // Scopes by the case's own institution snapshot, or by being the
    // assignee. It once scoped by the owner's current institution, which let
    // a case follow its author to another hospital; the fallback for
    // unstamped cases did the same thing more quietly, so both are gone.
    //
    // The assignee branch is not optional: canReadCase permits the assignee
    // unconditionally, before it ever looks at institution, so promoting a
    // clinician to HOD must not silently drop the cases assigned to them at
    // a different institution — that was the bug this OR fixes.
    expect(caseReadWhereForUser(user)).toEqual({
      OR: [{ userId: "hod-1" }, { institutionId: "inst-1" }],
    })
    expect(caseWriteWhereForUser(user)).toEqual({
      OR: [{ userId: "hod-1" }, { institutionId: "inst-1" }],
    })
    expect(canReadCase(user, { userId: "other", institutionId: "inst-1" })).toBe(true)
    expect(canReadCase(user, { userId: "other", institutionId: "inst-2" })).toBe(false)
    // The owner's institution is not consulted, whichever it is.
    expect(canReadCase(user, { userId: "other", user: { institutionId: "inst-1" } })).toBe(false)
    expect(canReadCase(user, { userId: "other", user: { institutionId: "inst-2" } })).toBe(false)
    // canReadCase already said yes to this — the case reserving this
    // regression was that the list/detail scope disagreed with it.
    expect(canReadCase(user, { userId: "hod-1", institutionId: "inst-2" })).toBe(true)
    expect(canWriteCase(user, { userId: "hod-1", institutionId: "inst-2" })).toBe(true)
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

  it("gives a same-institution creator read-only access after handover", () => {
    const creator = { id: "creator", role: "MEMBER", institutionId: "inst-1" }
    const handedOver = {
      userId: "assignee",
      createdById: "creator",
      institutionId: "inst-1",
    }
    expect(canReadCase(creator, handedOver)).toBe(true)
    expect(canWriteCase(creator, handedOver)).toBe(false)
    expect(caseCapabilitiesForUser(creator, handedOver)).toEqual({
      canRead: true,
      canWrite: false,
      isCreator: true,
      isAssignee: false,
    })
    expect(caseReadWhereForUser(creator)).toEqual({
      OR: [
        { userId: "creator" },
        { createdById: "creator", institutionId: "inst-1" },
      ],
    })
    expect(caseWriteWhereForUser(creator)).toEqual({ userId: "creator" })
  })

  it("drops creator visibility after the creator leaves the case institution", () => {
    expect(canReadCase(
      { id: "creator", role: "MEMBER", institutionId: "inst-2" },
      { userId: "assignee", createdById: "creator", institutionId: "inst-1" },
    )).toBe(false)
  })
})
