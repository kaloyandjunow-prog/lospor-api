import { beforeEach, describe, expect, it, vi } from "vitest"

const getAuthUser = vi.fn()
const findCase = vi.fn()
const findUser = vi.fn()
const createTransfer = vi.fn()
const transferOwnership = vi.fn()
const logAuditInTransaction = vi.fn()

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser }))
vi.mock("@/lib/audit", () => ({ logAuditInTransaction }))
vi.mock("@/lib/case-transfer", () => ({
  transferCaseOwnershipInTransaction: transferOwnership,
}))
vi.mock("@/lib/case-code", () => ({ isPrismaUniqueError: () => false }))
vi.mock("@/lib/access-control", () => ({ caseWhereForUser: (_u: unknown, id: string) => ({ id }) }))
vi.mock("@/lib/clinical-transaction", async () => {
  const actual = await vi.importActual<typeof import("@/lib/clinical-transaction")>(
    "@/lib/clinical-transaction",
  )
  return {
    ...actual,
    withLockedCaseTransaction: (_id: string, run: (tx: unknown) => unknown) => run({
      case: { findFirst: findCase },
      user: { findUnique: findUser },
      caseTransfer: { create: createTransfer, updateMany: vi.fn(), update: vi.fn() },
    }),
  }
})

const context = { params: Promise.resolve({ id: "case-1" }) }
const request = (body: unknown) =>
  new Request("http://localhost/v1/cases/case-1/transfer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never

describe("transferring a case", () => {
  let POST: typeof import("./route").POST

  beforeEach(async () => {
    vi.clearAllMocks()
    getAuthUser.mockResolvedValue({ id: "hod-1", role: "HEAD_OF_DEPT", institutionId: "inst-1" })
    findCase.mockResolvedValue({
      id: "case-1", userId: "author-1", institutionId: "inst-1", status: "IN_PROGRESS",
    })
    findUser.mockResolvedValue({ id: "peer-1", institutionId: "inst-1" })
    transferOwnership.mockResolvedValue({ previousCaseCode: null, caseCode: "2026-0007" })
    createTransfer.mockResolvedValue({ id: "transfer-1" })
    ;({ POST } = await import("./route"))
  })

  it("reassigns a case within the same hospital", async () => {
    const response = await POST(request({ toUserId: "peer-1" }), context)
    expect(response.status).toBe(200)
    expect(transferOwnership).toHaveBeenCalled()
  })

  it("refuses to move a case to another institution", async () => {
    findUser.mockResolvedValue({ id: "outsider-1", institutionId: "inst-2" })
    const response = await POST(request({ toUserId: "outsider-1" }), context)
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: "CROSS_INSTITUTION_TRANSFER" })
    expect(transferOwnership).not.toHaveBeenCalled()
  })

  it("refuses it for an administrator too", async () => {
    // An admin used to be exempt, and the transfer rewrote the case's
    // institution to the recipient's -- so the record, the printed protocol and
    // the OMOP care_site all said the operation had happened somewhere it had
    // not, and the export pseudonym stopped matching any patient link.
    getAuthUser.mockResolvedValue({ id: "admin-1", role: "ADMIN", institutionId: "inst-9" })
    findUser.mockResolvedValue({ id: "outsider-1", institutionId: "inst-2" })
    const response = await POST(request({ toUserId: "outsider-1" }), context)
    expect(response.status).toBe(403)
    expect(transferOwnership).not.toHaveBeenCalled()
  })

  it("compares against the case's institution, not the caller's", async () => {
    // An admin belongs to no particular department, so checking the actor's
    // institution would let a case move whenever the actor happened to differ.
    getAuthUser.mockResolvedValue({ id: "admin-1", role: "ADMIN", institutionId: "inst-9" })
    findUser.mockResolvedValue({ id: "peer-1", institutionId: "inst-1" })
    const response = await POST(request({ toUserId: "peer-1" }), context)
    expect(response.status).toBe(200)
  })

  it("refuses to reassign a finalised case", async () => {
    findCase.mockResolvedValue({
      id: "case-1", userId: "author-1", institutionId: "inst-1", status: "COMPLETE",
    })
    const response = await POST(request({ toUserId: "peer-1" }), context)
    expect(response.status).toBe(409)
    expect(transferOwnership).not.toHaveBeenCalled()
  })

  it("still refuses an ordinary member", async () => {
    getAuthUser.mockResolvedValue({ id: "member-1", role: "MEMBER", institutionId: "inst-1" })
    const response = await POST(request({ toUserId: "peer-1" }), context)
    expect(response.status).toBe(403)
  })

  it("records the reassignment in the same transaction", async () => {
    await POST(request({ toUserId: "peer-1" }), context)
    expect(logAuditInTransaction).toHaveBeenCalledWith(
      expect.anything(), "hod-1", "CASE_TRANSFER_ASSIGN", "case-1",
      expect.objectContaining({ toUserId: "peer-1" }),
    )
  })
})
