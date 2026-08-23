import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import {
  accountLifecycleStatus,
  activeClinicalAdminWhere,
  deletionDeadline,
} from "./account-lifecycle"

const base = {
  activatedAt: new Date(),
  suspendedAt: null,
  recoveryRequiredAt: null,
  deletedAt: null,
  anonymizedAt: null,
}

describe("account lifecycle policy", () => {
  it("derives mutually exclusive truthful statuses in safety precedence order", () => {
    expect(accountLifecycleStatus(base)).toBe("ACTIVE")
    expect(accountLifecycleStatus({ ...base, activatedAt: null })).toBe("INVITED")
    expect(accountLifecycleStatus({ ...base, suspendedAt: new Date() })).toBe("SUSPENDED")
    expect(accountLifecycleStatus({ ...base, recoveryRequiredAt: new Date() })).toBe("RECOVERY_REQUIRED")
    expect(accountLifecycleStatus({ ...base, deletedAt: new Date(), suspendedAt: new Date() })).toBe("DELETION_PENDING")
    expect(accountLifecycleStatus({ ...base, anonymizedAt: new Date(), deletedAt: new Date() })).toBe("ANONYMIZED")
  })

  it("sets the reversible-deletion deadline exactly 30 days after deletion", () => {
    const deletedAt = new Date("2026-08-01T12:34:56.000Z")
    expect(deletionDeadline(deletedAt).toISOString()).toBe("2026-08-31T12:34:56.000Z")
  })

  it("counts only activated, active clinical administrators for last-admin protection", () => {
    expect(activeClinicalAdminWhere).toEqual({
      role: "ADMIN",
      accountKind: "CLINICAL",
      activatedAt: { not: null },
      suspendedAt: null,
      recoveryRequiredAt: null,
      deletedAt: null,
      anonymizedAt: null,
    })
  })
})
