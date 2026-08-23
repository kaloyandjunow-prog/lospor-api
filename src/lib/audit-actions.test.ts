import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/prisma", () => ({
  prisma: { auditLog: { create: vi.fn() } },
}))

import { AUDIT_ACTION_REGISTRY, isAuditActionCode } from "./audit-actions"
import { assertSafeAuditDetail, logAuditInTransaction } from "./audit"

describe("stable audit action contract", () => {
  it("has unique, immutable-looking codes and complete Bulgarian/English labels", () => {
    const codes = AUDIT_ACTION_REGISTRY.map(action => action.code)
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes.length).toBeGreaterThan(60)
    for (const action of AUDIT_ACTION_REGISTRY) {
      expect(isAuditActionCode(action.code)).toBe(true)
      expect(action.labels.en.trim()).not.toBe("")
      expect(action.labels.bg).toMatch(/[\u0400-\u04ff]/)
    }
    expect(isAuditActionCode("NOT_REGISTERED")).toBe(false)
  })

  it("rejects obvious secrets, direct PII, patient numbers, and clinical payload keys", () => {
    for (const detail of [
      { password: "must-not-appear" },
      { nested: { accessToken: "must-not-appear" } },
      { patientNumber: "must-not-appear" },
      { caseCode: "must-not-appear" },
      { clinicalPayload: { diagnosis: "must-not-appear" } },
      { email: "must-not-appear@example.test" },
    ]) {
      expect(() => assertSafeAuditDetail(detail)).toThrow(/Unsafe audit detail field/)
    }
  })

  it("allows stable IDs, transitions, roles, reason text, hashes, and changed fields", () => {
    expect(() => assertSafeAuditDetail({
      targetUserId: "user-2",
      previousRole: "MEMBER",
      role: "HEAD_OF_DEPT",
      reason: "Approved institutional responsibility",
      contentSha256: "a".repeat(64),
      changedFields: ["role"],
    })).not.toThrow()
  })

  it("writes a registered action through the caller's transaction handle", async () => {
    const create = vi.fn().mockResolvedValue({})
    await logAuditInTransaction(
      { auditLog: { create } } as never,
      "actor-1",
      "ACCOUNT_ACTIVATE",
      "account-1",
      { activationMethod: "EMAIL_VERIFICATION" },
    )
    expect(create).toHaveBeenCalledWith({
      data: {
        userId: "actor-1",
        action: "ACCOUNT_ACTIVATE",
        entityId: "account-1",
        detail: { activationMethod: "EMAIL_VERIFICATION" },
      },
    })
  })
})
