import { beforeEach, describe, expect, it, vi } from "vitest"

// vi.mock is hoisted above the file, so the spy has to be created in a hoisted
// block too. The module is mocked under the same specifier the source imports.
const { generateCaseCode, reserveCaseCode } = vi.hoisted(() => ({
  generateCaseCode: vi.fn(),
  reserveCaseCode: vi.fn(),
}))
vi.mock("@/lib/case-code", () => ({
  generateCaseCode,
  reserveCaseCode,
  isPrismaUniqueError: () => false,
}))

import { transferCaseOwnershipInTransaction } from "./case-transfer"

/**
 * A transaction handle with just the surface this function touches.
 * `clashingCode` is the code the recipient is pretended to already hold.
 */
function tx(currentCode: string | null, clashingCode: string | null) {
  const caseUpdate = vi.fn().mockResolvedValue({})
  return {
    handle: {
      case: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          caseCode: currentCode, institutionId: "inst-1",
        }),
        findFirst: vi.fn().mockImplementation(({ where }) =>
          Promise.resolve(where.caseCode === clashingCode ? { id: "other-case" } : null)),
        update: caseUpdate,
      },
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({ institutionId: "inst-1" }),
      },
      caseTransfer: { updateMany: vi.fn(), update: vi.fn() },
    },
    caseUpdate,
  }
}

describe("transferring case ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    generateCaseCode.mockResolvedValue("2026-0099")
    reserveCaseCode.mockResolvedValue(undefined)
  })

  it("keeps the code when the recipient does not already hold it", async () => {
    const { handle, caseUpdate } = tx("2026-0007", null)
    const outcome = await transferCaseOwnershipInTransaction(handle as never, "case-1", "peer-1")

    expect(outcome.previousCaseCode).toBeNull()
    expect(outcome.caseCode).toBe("2026-0007")
    expect(generateCaseCode).not.toHaveBeenCalled()
    expect(caseUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { userId: "peer-1", caseCode: "2026-0007" } }),
    )
  })

  // The case this exists for.
  //
  // Handovers routinely cross the New Year: a pre-assessment in December, the
  // list in January. Renumbering with the current year would move a 2026
  // operation into the recipient's 2027 sequence, and that number is printed on
  // the chart.
  it("renumbers within the case's own year, not the year of the handover", async () => {
    const { handle } = tx("2026-0007", "2026-0007")
    await transferCaseOwnershipInTransaction(handle as never, "case-1", "peer-1")

    expect(generateCaseCode).toHaveBeenCalledWith(expect.anything(), expect.anything(), 2026)
  })

  it("reports the code the case carried before it moved", async () => {
    const { handle } = tx("2026-0007", "2026-0007")
    const outcome = await transferCaseOwnershipInTransaction(handle as never, "case-1", "peer-1")

    // Without this the paper chart and the database disagree with nothing to
    // reconcile them by.
    expect(outcome.previousCaseCode).toBe("2026-0007")
    expect(outcome.caseCode).toBe("2026-0099")
  })

  it("falls back to the current year when a case has no code to preserve", async () => {
    const { handle } = tx(null, null)
    await transferCaseOwnershipInTransaction(handle as never, "case-1", "peer-1")
    expect(generateCaseCode).not.toHaveBeenCalled()
  })

  it("refuses to move a case to another institution", async () => {
    const { handle } = tx("2026-0007", null)
    handle.user.findUniqueOrThrow = vi.fn().mockResolvedValue({ institutionId: "inst-2" })
    await expect(transferCaseOwnershipInTransaction(handle as never, "case-1", "peer-1"))
      .rejects.toThrow("CROSS_INSTITUTION_TRANSFER")
  })

  // A handover that does not renumber still puts a number into the recipient's
  // sequence that their counter knows nothing about. Left alone the counter
  // walks up to it and issues the same number a second time.
  it("reserves the arriving number against the recipient's counter", async () => {
    const { handle } = tx("2026-0007", null)
    await transferCaseOwnershipInTransaction(handle as never, "case-1", "peer-1")
    expect(reserveCaseCode).toHaveBeenCalledWith("peer-1", expect.anything(), "2026-0007")
  })

  it("reserves the renumbered code, not the one it replaced", async () => {
    const { handle } = tx("2026-0007", "2026-0007")
    await transferCaseOwnershipInTransaction(handle as never, "case-1", "peer-1")
    expect(reserveCaseCode).toHaveBeenCalledWith("peer-1", expect.anything(), "2026-0099")
  })
})
