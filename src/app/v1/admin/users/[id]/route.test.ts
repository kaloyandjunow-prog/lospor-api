import { beforeEach, describe, expect, it, vi } from "vitest"

const getAuthUser = vi.fn()
const userUpdate = vi.fn()
const userDelete = vi.fn()
const logAuditInTransaction = vi.fn()
const notePasswordChanged = vi.fn()
const invalidateAccountState = vi.fn()

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser }))
vi.mock("@/lib/audit", () => ({ logAuditInTransaction }))
vi.mock("@/lib/password-epoch", () => ({ notePasswordChanged, invalidateAccountState }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { update: userUpdate, delete: userDelete, findUnique: vi.fn() },
    $transaction: (run: (tx: unknown) => unknown) =>
      run({ user: { update: userUpdate }, auditLog: { create: vi.fn() } }),
  },
}))

const context = { params: Promise.resolve({ id: "target-1" }) }
const request = () =>
  new Request("http://localhost/v1/admin/users/target-1", { method: "DELETE" }) as never

describe("deleting an account as an administrator", () => {
  let DELETE: typeof import("./route").DELETE

  beforeEach(async () => {
    vi.clearAllMocks()
    getAuthUser.mockResolvedValue({ id: "admin-1", role: "ADMIN" })
    userUpdate.mockResolvedValue({ id: "target-1", deletedAt: new Date("2026-08-18T12:00:00Z") })
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
    expect(userUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "target-1" },
      data: expect.objectContaining({ deletedAt: expect.any(Date) }),
    }))
  })

  it("revokes every existing session, not just the open one", async () => {
    // Without the epoch bump a deleted account keeps full API access from any
    // other signed-in device until its token expires.
    await DELETE(request(), context)
    const { data } = userUpdate.mock.calls[0][0]
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

  it("refuses a non-administrator", async () => {
    getAuthUser.mockResolvedValue({ id: "user-1", role: "MEMBER" })
    const response = await DELETE(request(), context)
    expect(response.status).toBe(403)
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it("refuses to delete the caller's own account", async () => {
    getAuthUser.mockResolvedValue({ id: "target-1", role: "ADMIN" })
    const response = await DELETE(request(), context)
    expect(response.status).toBe(400)
    expect(userUpdate).not.toHaveBeenCalled()
  })
})
