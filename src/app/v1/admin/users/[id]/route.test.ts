import { beforeEach, describe, expect, it, vi } from "vitest"

const getAuthUser = vi.fn()
const userUpdate = vi.fn()
const userUpdateMany = vi.fn()
const userFindUnique = vi.fn()
const userDelete = vi.fn()
const userCount = vi.fn()
const logAuditInTransaction = vi.fn()
const notePasswordChanged = vi.fn()
const invalidateAccountState = vi.fn()
const lockMembership = vi.fn()
const releaseUnrelatedHodLocks = vi.fn()
const passwordResetUpdateMany = vi.fn()
const revokeAllSessionsInTransaction = vi.fn()

vi.mock("server-only", () => ({}))
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser }))
vi.mock("@/lib/audit", () => ({ logAuditInTransaction }))
vi.mock("@/lib/password-epoch", () => ({ notePasswordChanged, invalidateAccountState }))
vi.mock("@/lib/membership-change", () => ({
  lockMembership,
  releaseUnrelatedHodLocks,
  isHodDemotion: (current: { role: string }, nextRole?: string) => (
    current.role === "HEAD_OF_DEPT" && nextRole === "MEMBER"
  ),
}))
vi.mock("@/lib/auth-sessions", () => ({ revokeAllSessionsInTransaction }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      update: userUpdate,
      updateMany: userUpdateMany,
      delete: userDelete,
      findUnique: userFindUnique,
    },
    $transaction: (run: (tx: unknown) => unknown) =>
      run({
        user: {
          update: userUpdate,
          updateMany: userUpdateMany,
          findUnique: userFindUnique,
          count: userCount,
        },
        passwordResetToken: { updateMany: passwordResetUpdateMany },
        auditLog: { create: vi.fn() },
      }),
  },
}))

const context = { params: Promise.resolve({ id: "target-1" }) }
const request = () =>
  new Request("http://localhost/v1/admin/users/target-1", { method: "DELETE" }) as never
const patchRequest = (body: object) =>
  new Request("http://localhost/v1/admin/users/target-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never

describe("deleting an account as an administrator", () => {
  let DELETE: typeof import("./route").DELETE

  beforeEach(async () => {
    vi.clearAllMocks()
    getAuthUser.mockResolvedValue({ id: "admin-1", role: "ADMIN" })
    userFindUnique.mockResolvedValue({
      role: "MEMBER",
      accountKind: "CLINICAL",
      activatedAt: new Date(),
      emailVerifiedAt: new Date(),
      suspendedAt: null,
      recoveryRequiredAt: null,
      deletedAt: null,
      anonymizedAt: null,
    })
    userUpdateMany.mockResolvedValue({ count: 1 })
    passwordResetUpdateMany.mockResolvedValue({ count: 0 })
    revokeAllSessionsInTransaction.mockResolvedValue(2)
    ;({ DELETE } = await import("./route"))
  })

  it("marks the account deleted rather than removing the row", async () => {
    // It was prisma.user.delete(). Case.user declares no onDelete, so Prisma
    // defaults to Restrict and deleting any clinician holding a case raised a
    // foreign-key error with no try/catch around it -- an unhandled 500. The
    // endpoint worked only for accounts with no clinical record.
    const response = await DELETE(request(), context)
    expect(response.status).toBe(200)
    expect(userDelete).not.toHaveBeenCalled()
    expect(userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "target-1" }),
      data: expect.objectContaining({ deletedAt: expect.any(Date) }),
    }))
  })

  it("revokes every existing session, not just the open one", async () => {
    // Without the epoch bump a deleted account keeps full API access from any
    // other signed-in device until its token expires.
    await DELETE(request(), context)
    const { data } = userUpdateMany.mock.calls[0][0]
    expect(data.passwordChangedAt).toBeInstanceOf(Date)
    expect(data.passwordChangedAt).toEqual(data.deletedAt)
    expect(notePasswordChanged).toHaveBeenCalledWith("target-1", expect.any(Date))
    expect(invalidateAccountState).toHaveBeenCalledWith("target-1")
  })

  it("records who did it, in the same transaction", async () => {
    await DELETE(request(), context)
    expect(logAuditInTransaction).toHaveBeenCalledWith(
      expect.anything(), "admin-1", "ADMIN_ACCOUNT_DELETE", "target-1",
      expect.objectContaining({ retentionDays: expect.any(Number) }),
    )
  })

  it("does not publish deletion state when its durable audit row fails", async () => {
    logAuditInTransaction.mockRejectedValueOnce(new Error("audit unavailable"))

    await expect(DELETE(request(), context)).rejects.toThrow("audit unavailable")
    expect(notePasswordChanged).not.toHaveBeenCalled()
    expect(invalidateAccountState).not.toHaveBeenCalled()
  })

  it("refuses a non-administrator", async () => {
    getAuthUser.mockResolvedValue({ id: "user-1", role: "MEMBER" })
    const response = await DELETE(request(), context)
    expect(response.status).toBe(403)
    expect(userUpdateMany).not.toHaveBeenCalled()
  })

  it("refuses to delete the caller's own account", async () => {
    getAuthUser.mockResolvedValue({ id: "target-1", role: "ADMIN" })
    const response = await DELETE(request(), context)
    expect(response.status).toBe(400)
    expect(userUpdateMany).not.toHaveBeenCalled()
  })
})

describe("changing account authority as an administrator", () => {
  let PATCH: typeof import("./route").PATCH

  beforeEach(async () => {
    vi.clearAllMocks()
    getAuthUser.mockResolvedValue({ id: "admin-1", role: "ADMIN" })
    lockMembership.mockResolvedValue({
      id: "target-1",
      role: "HEAD_OF_DEPT",
      accountKind: "CLINICAL",
      institutionId: "institution-1",
      activatedAt: new Date(),
      emailVerifiedAt: new Date(),
      suspendedAt: null,
      recoveryRequiredAt: null,
      deletedAt: null,
      anonymizedAt: null,
    })
    userCount.mockResolvedValue(2)
    userUpdateMany.mockResolvedValue({ count: 1 })
    revokeAllSessionsInTransaction.mockResolvedValue(2)
    ;({ PATCH } = await import("./route"))
  })

  it("keeps assigned cases and releases only former department-scope locks on HOD demotion", async () => {
    const response = await PATCH(patchRequest({ role: "MEMBER" }), context)

    expect(response.status).toBe(200)
    expect(releaseUnrelatedHodLocks).toHaveBeenCalledWith(expect.anything(), "target-1")
    expect(userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "target-1", role: "HEAD_OF_DEPT" }),
      data: expect.objectContaining({ role: "MEMBER", passwordChangedAt: expect.any(Date) }),
    }))
    expect(revokeAllSessionsInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      "target-1",
      expect.any(Date),
      "ADMIN_AUTHORITY_CHANGE",
    )
    expect(notePasswordChanged).toHaveBeenCalledWith("target-1", expect.any(Date))
    expect(logAuditInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      "admin-1",
      "ADMIN_ACCOUNT_AUTHORITY_CHANGE",
      "target-1",
      expect.objectContaining({ previousRole: "HEAD_OF_DEPT", role: "MEMBER" }),
    )
  })

  // HAUD_ROLLBACK:direct-member-hod-role-change
  it("does not publish a routine authority transition when its audit row fails", async () => {
    logAuditInTransaction.mockRejectedValueOnce(new Error("audit unavailable"))

    await expect(PATCH(patchRequest({ role: "MEMBER" }), context)).rejects.toThrow("audit unavailable")
    expect(notePasswordChanged).not.toHaveBeenCalled()
    expect(invalidateAccountState).not.toHaveBeenCalled()
  })

  it("does not allow the last clinical administrator to lose authority", async () => {
    lockMembership.mockResolvedValue({
      id: "target-1",
      role: "ADMIN",
      accountKind: "CLINICAL",
      institutionId: "institution-1",
    })
    userCount.mockResolvedValue(1)

    const response = await PATCH(patchRequest({ role: "MEMBER" }), context)

    expect(response.status).toBe(409)
    expect(userUpdate).not.toHaveBeenCalled()
    expect(logAuditInTransaction).not.toHaveBeenCalled()
  })

  it("routes clinical/research account-kind transitions through step-up authority", async () => {
    const response = await PATCH(patchRequest({ accountKind: "RESEARCH_ONLY" }), context)

    expect(response.status).toBe(409)
    expect(lockMembership).not.toHaveBeenCalled()
    expect(userUpdateMany).not.toHaveBeenCalled()
    expect(revokeAllSessionsInTransaction).not.toHaveBeenCalled()
  })

  it("will not change an inactive account's routine role", async () => {
    lockMembership.mockResolvedValue({
      id: "target-1",
      role: "MEMBER",
      accountKind: "CLINICAL",
      institutionId: "institution-1",
      activatedAt: new Date(),
      emailVerifiedAt: new Date(),
      suspendedAt: new Date(),
      recoveryRequiredAt: null,
      deletedAt: null,
      anonymizedAt: null,
    })

    const response = await PATCH(patchRequest({ role: "HEAD_OF_DEPT" }), context)

    expect(response.status).toBe(409)
    expect(userUpdateMany).not.toHaveBeenCalled()
    expect(revokeAllSessionsInTransaction).not.toHaveBeenCalled()
  })
})
