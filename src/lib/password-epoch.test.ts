import { beforeEach, describe, expect, it, vi } from "vitest"

// The module eagerly touches prisma at import time — stub it so the pure
// epoch logic is testable without a database.
const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findMany: vi.fn(async () => []), findUnique: mocks.userFindUnique } },
}))

import { issuedBeforeEpoch, isIssuedBeforePasswordChange, notePasswordChanged, resolveAccount } from "./password-epoch"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("issuedBeforeEpoch", () => {
  it("accepts every token when the user never reset their password", () => {
    expect(issuedBeforeEpoch(1_700_000_000, undefined)).toBe(false)
    expect(issuedBeforeEpoch(1_700_000_000, 0)).toBe(false)
  })

  it("rejects tokens issued before the epoch and accepts ones issued after", () => {
    const epochMs = 1_700_000_000_000
    expect(issuedBeforeEpoch(epochMs / 1000 - 60, epochMs)).toBe(true)  // 1 min before reset
    expect(issuedBeforeEpoch(epochMs / 1000 + 60, epochMs)).toBe(false) // 1 min after reset
  })

  it("treats a missing iat as stale once an epoch exists", () => {
    expect(issuedBeforeEpoch(undefined, 1_700_000_000_000)).toBe(true)
  })
})

describe("isIssuedBeforePasswordChange (cache)", () => {
  it("reflects notePasswordChanged immediately on this instance", () => {
    const userId = "user-epoch-test"
    const changedAt = new Date("2026-07-13T10:00:00.000Z")
    expect(isIssuedBeforePasswordChange(userId, changedAt.getTime() / 1000 - 100)).toBe(false)

    notePasswordChanged(userId, changedAt)

    // Token minted 100s BEFORE the reset → dead.
    expect(isIssuedBeforePasswordChange(userId, changedAt.getTime() / 1000 - 100)).toBe(true)
    // Fresh token minted after the reset → fine.
    expect(isIssuedBeforePasswordChange(userId, changedAt.getTime() / 1000 + 100)).toBe(false)
  })

  it("fetches full live account state when the epoch cache was primed without role data", async () => {
    const userId = "user-partial-cache-test"
    const changedAt = new Date("2026-07-13T10:00:00.000Z")
    notePasswordChanged(userId, changedAt)
    mocks.userFindUnique.mockResolvedValue({
      activatedAt: new Date("2026-01-01T00:00:00.000Z"),
      passwordChangedAt: changedAt,
      deletedAt: null,
      role: "HEAD_OF_DEPT",
      accountKind: "CLINICAL",
      preferences: { ui: { locale: "en" } },
      institutionId: "inst-1",
      institution: { name: "Live Hospital" },
    })

    await expect(resolveAccount(userId, changedAt.getTime() / 1000 + 100)).resolves.toEqual({
      role: "HEAD_OF_DEPT",
      accountKind: "CLINICAL",
      preferredLocale: "en",
      institutionId: "inst-1",
      institutionName: "Live Hospital",
      firstName: null,
      lastName: null,
      title: null,
    })
    expect(mocks.userFindUnique).toHaveBeenCalledWith({
      where: { id: userId },
      select: {
        activatedAt: true,
        passwordChangedAt: true,
        deletedAt: true,
        suspendedAt: true,
        recoveryRequiredAt: true,
        anonymizedAt: true,
        role: true,
        accountKind: true,
        preferences: true,
        institutionId: true,
        institution: { select: { name: true } },
        firstName: true,
        lastName: true,
        title: true,
      },
    })
  })

  it("refuses inactive, suspended, recovery-required, deleted, and anonymized accounts", async () => {
    for (const [index, state] of [
      { activatedAt: null },
      { suspendedAt: new Date() },
      { recoveryRequiredAt: new Date() },
      { deletedAt: new Date() },
      { anonymizedAt: new Date() },
    ].entries()) {
      const userId = `closed-account-${index}`
      mocks.userFindUnique.mockResolvedValueOnce({
        activatedAt: new Date("2026-01-01T00:00:00.000Z"),
        passwordChangedAt: null,
        deletedAt: null,
        suspendedAt: null,
        recoveryRequiredAt: null,
        anonymizedAt: null,
        role: "MEMBER",
        accountKind: "CLINICAL",
        preferences: {},
        institutionId: null,
        institution: null,
        firstName: "Test",
        lastName: "User",
        title: "Dr",
        ...state,
      })
      await expect(resolveAccount(userId, 1_700_000_000)).resolves.toBeNull()
    }
  })
})
