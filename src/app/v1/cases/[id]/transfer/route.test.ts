import { beforeEach, describe, expect, it, vi } from "vitest"

const getAuthUser = vi.fn()
const findCase = vi.fn()
const findUser = vi.fn()
const createTransfer = vi.fn()
const transferOwnership = vi.fn()
const findPendingTransfer = vi.fn()
const findCaseUnique = vi.fn()
const updateTransfer = vi.fn()
const logAuditInTransaction = vi.fn()

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser }))
vi.mock("@/lib/audit", () => ({ logAuditInTransaction }))
vi.mock("@/lib/case-transfer", () => ({
  transferCaseOwnershipInTransaction: transferOwnership,
}))
vi.mock("@/lib/case-code", () => ({ isPrismaUniqueError: () => false }))
vi.mock("@/lib/access-control", () => ({ caseWriteWhereForUser: (_u: unknown, id: string) => ({ id }) }))
vi.mock("@/lib/clinical-transaction", async () => {
  const actual = await vi.importActual<typeof import("@/lib/clinical-transaction")>(
    "@/lib/clinical-transaction",
  )
  return {
    ...actual,
    withLockedCaseTransaction: (_id: string, run: (tx: unknown) => unknown) => run({
      case: { findFirst: findCase, findUnique: findCaseUnique },
      user: { findUnique: findUser },
      caseTransfer: {
        create: createTransfer,
        findFirst: findPendingTransfer,
        update: updateTransfer,
        updateMany: vi.fn(),
      },
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
    findPendingTransfer.mockResolvedValue(null)
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

  // A member used to be refused outright here. That did not stop handovers, it
  // only stopped the register seeing them: the case still changed hands at the
  // end of the shift, with nothing recorded. A member now asks, and the case
  // moves when the recipient accepts.
  it("lets a member ask, without moving the case", async () => {
    getAuthUser.mockResolvedValue({ id: "member-1", role: "MEMBER", institutionId: "inst-1" })
    const response = await POST(request({ toUserId: "peer-1" }), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ instant: false })
    // The load-bearing assertion. Ownership, the case code and every access
    // rule must be untouched until someone accepts, because the sender is
    // usually still documenting the case they are handing on.
    expect(transferOwnership).not.toHaveBeenCalled()
    expect(createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PENDING", toUserId: "peer-1" }),
      }),
    )
  })

  it("records a member's request in the same transaction", async () => {
    getAuthUser.mockResolvedValue({ id: "member-1", role: "MEMBER", institutionId: "inst-1" })
    await POST(request({ toUserId: "peer-1" }), context)
    expect(logAuditInTransaction).toHaveBeenCalledWith(
      expect.anything(), "member-1", "CASE_TRANSFER_REQUEST", "case-1",
      expect.objectContaining({ fromUserId: "author-1", toUserId: "peer-1" }),
    )
  })

  it("refuses a second pending handover on the same case", async () => {
    // Two people cannot both be waiting to be told the case is theirs --
    // whoever accepted second would find it already renumbered into someone
    // else's sequence. A partial unique index enforces this in the database
    // too; this is the readable error in front of it.
    getAuthUser.mockResolvedValue({ id: "member-1", role: "MEMBER", institutionId: "inst-1" })
    findPendingTransfer.mockResolvedValue({ id: "transfer-0", toUserId: "someone-else" })
    const response = await POST(request({ toUserId: "peer-1" }), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: "TRANSFER_ALREADY_PENDING" })
    expect(createTransfer).not.toHaveBeenCalled()
  })

  it("still refuses a member the refusals that apply to everyone", async () => {
    // Relaxing who may hand over must not relax what may be handed over.
    getAuthUser.mockResolvedValue({ id: "member-1", role: "MEMBER", institutionId: "inst-1" })
    findCase.mockResolvedValue({
      id: "case-1", userId: "member-1", institutionId: "inst-1", status: "COMPLETE",
    })
    expect((await POST(request({ toUserId: "peer-1" }), context)).status).toBe(409)

    findCase.mockResolvedValue({
      id: "case-1", userId: "member-1", institutionId: "inst-1", status: "IN_PROGRESS",
    })
    findUser.mockResolvedValue({ id: "outsider-1", institutionId: "inst-2" })
    expect((await POST(request({ toUserId: "outsider-1" }), context)).status).toBe(403)

    expect(createTransfer).not.toHaveBeenCalled()
  })

  it("a head of department still assigns instantly", async () => {
    const response = await POST(request({ toUserId: "peer-1" }), context)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ instant: true })
    expect(transferOwnership).toHaveBeenCalled()
  })

  it("records the reassignment in the same transaction", async () => {
    await POST(request({ toUserId: "peer-1" }), context)
    expect(logAuditInTransaction).toHaveBeenCalledWith(
      expect.anything(), "hod-1", "CASE_TRANSFER_ASSIGN", "case-1",
      expect.objectContaining({ toUserId: "peer-1" }),
    )
  })
})


// Accepting, declining and withdrawing a handover.
//
// None of this had a single test, because none of it could run: every transfer
// was created ACCEPTED, so the pending row these act on never existed. Now that
// a member's handover creates one, this is the half of the feature that decides
// whether a case actually changes hands.
describe("resolving a pending handover", () => {
  let PATCH: typeof import("./route").PATCH

  const patch = (body: unknown) =>
    new Request("http://localhost/v1/cases/case-1/transfer", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as never

  beforeEach(async () => {
    vi.clearAllMocks()
    getAuthUser.mockResolvedValue({ id: "peer-1", role: "MEMBER", institutionId: "inst-1" })
    findPendingTransfer.mockResolvedValue({
      id: "transfer-1", caseId: "case-1", fromUserId: "author-1", toUserId: "peer-1",
    })
    findCaseUnique.mockResolvedValue({ status: "IN_PROGRESS" })
    transferOwnership.mockResolvedValue({ previousCaseCode: "2026-0004", caseCode: "2026-0011" })
    updateTransfer.mockResolvedValue({ id: "transfer-1" })
    ;({ PATCH } = await import("./route"))
  })

  it("accepting moves the case and reports the renumbering", async () => {
    const response = await PATCH(patch({ action: "accept" }), context)

    expect(response.status).toBe(200)
    // The recipient has to be told the code changed. Case codes are per-user
    // sequences, so a handover usually renumbers -- and a printed sheet
    // carrying the old code is how a chart stops matching its record.
    expect(await response.json()).toMatchObject({
      accepted: true, caseCode: "2026-0011", previousCaseCode: "2026-0004",
    })
    expect(transferOwnership).toHaveBeenCalledWith(
      expect.anything(), "case-1", "peer-1",
      expect.objectContaining({ acceptTransferId: "transfer-1" }),
    )
    expect(logAuditInTransaction).toHaveBeenCalledWith(
      expect.anything(), "peer-1", "CASE_TRANSFER_ACCEPT", "case-1",
      expect.objectContaining({ fromUserId: "author-1", toUserId: "peer-1" }),
    )
  })

  it("refuses to accept a case finalised while the handover waited", async () => {
    // POST has always refused to move a finalised case; this did not, so a case
    // finalised after the handover was offered could still change hands
    // underneath its own attestation.
    findCaseUnique.mockResolvedValue({ status: "COMPLETE" })
    const response = await PATCH(patch({ action: "accept" }), context)

    expect(response.status).toBe(409)
    expect(transferOwnership).not.toHaveBeenCalled()
  })

  it("declining leaves the case exactly where it was", async () => {
    const response = await PATCH(patch({ action: "decline" }), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ declined: true })
    expect(transferOwnership).not.toHaveBeenCalled()
    expect(updateTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "DECLINED" }) }),
    )
  })

  it("the sender can withdraw, and it is recorded as a withdrawal", async () => {
    // Distinct from DECLINED on purpose: "my colleague refused this case" and
    // "I thought better of it" are the two things anyone would ask of the
    // trail, and one status could not tell them apart.
    getAuthUser.mockResolvedValue({ id: "author-1", role: "MEMBER", institutionId: "inst-1" })
    const response = await PATCH(patch({ action: "cancel" }), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ cancelled: true })
    expect(updateTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "CANCELLED" }) }),
    )
    expect(logAuditInTransaction).toHaveBeenCalledWith(
      expect.anything(), "author-1", "CASE_TRANSFER_CANCEL", "case-1", expect.anything(),
    )
  })

  it("matches on who is acting, so a stranger learns nothing", async () => {
    // The row is looked up by the acting user, not checked afterwards, so
    // someone with no part in this handover gets the same 404 as someone whose
    // case has no pending transfer at all.
    findPendingTransfer.mockResolvedValue(null)
    const response = await PATCH(patch({ action: "accept" }), context)

    expect(response.status).toBe(404)
    expect(transferOwnership).not.toHaveBeenCalled()
  })

  it("rejects an action it does not know", async () => {
    const response = await PATCH(patch({ action: "steal" }), context)
    expect(response.status).toBe(400)
    expect(findPendingTransfer).not.toHaveBeenCalled()
  })
})
