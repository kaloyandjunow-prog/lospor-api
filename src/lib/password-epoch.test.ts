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
      passwordChangedAt: changedAt,
      deletedAt: null,
      role: "HEAD_OF_DEPT",
      institutionId: "inst-1",
      institution: { name: "Live Hospital" },
    })

    await expect(resolveAccount(userId, changedAt.getTime() / 1000 + 100)).resolves.toEqual({
      role: "HEAD_OF_DEPT",
      institutionId: "inst-1",
      institutionName: "Live Hospital",
    })
    expect(mocks.userFindUnique).toHaveBeenCalledWith({
      where: { id: userId },
      select: {
        passwordChangedAt: true,
        deletedAt: true,
        role: true,
        institutionId: true,
        institution: { select: { name: true } },
      },
    })
  })
})
