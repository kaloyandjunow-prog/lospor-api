import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  findPreopMock, findIntraopMock, findPostopMock, updateMock,
  writeSnapshotAsyncMock, logAuditMock, syncCaseRelationalMock,
} = vi.hoisted(() => ({
  findPreopMock: vi.fn(),
  findIntraopMock: vi.fn(),
  findPostopMock: vi.fn(),
  updateMock: vi.fn(),
  writeSnapshotAsyncMock: vi.fn(),
  logAuditMock: vi.fn(),
  syncCaseRelationalMock: vi.fn(),
}))

vi.mock("@/lib/case-audit", () => ({ writeSnapshotAsync: writeSnapshotAsyncMock }))
vi.mock("@/lib/relational-sync", () => ({ syncCaseRelational: syncCaseRelationalMock }))
vi.mock("@/lib/audit", () => ({ logAuditInTransaction: logAuditMock }))

import { AUTO_CLOSE_SYSTEM_ACTOR_ID, finalizeCaseWithinTransaction } from "./case-finalization"

const COMPLETE_RECORD = {
  preop: {
    id: "preop-1", ageYears: 44, sex: "FEMALE", heightCm: 168, weightKg: 70,
    diagnoses: ["K80.2"], procedures: ["0FT44ZZ"], bpSystolic: 128, bpDiastolic: 76,
    heartRate: 72, respiratoryRate: 14, mallampati: "II", asaScore: 2,
  },
  intraop: {
    id: "intraop-1", startTime: new Date("2026-01-01T08:00:00Z"), endTime: new Date("2026-01-01T10:00:00Z"),
    techniques: ["GA"],
  },
  postop: {
    aldreteActivity: 2, aldreteRespiration: 2, aldreteCirculation: 2,
    aldreteConsciousness: 2, aldreteSpO2: 2, disposition: "WARD",
  },
}

function fakeTx() {
  return {
    preoperativeAssessment: { findUnique: findPreopMock },
    intraoperativeRecord: { findUnique: findIntraopMock },
    postoperativeRecord: { findUnique: findPostopMock },
    case: { update: updateMock },
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  findPreopMock.mockResolvedValue(COMPLETE_RECORD.preop)
  findIntraopMock.mockResolvedValue(COMPLETE_RECORD.intraop)
  findPostopMock.mockResolvedValue(COMPLETE_RECORD.postop)
  updateMock.mockResolvedValue({})
})

describe("finalizeCaseWithinTransaction", () => {
  it("signs a manual finalization as the acting clinician", async () => {
    await finalizeCaseWithinTransaction(fakeTx(), "case-1", "dr-jones", { currentStatus: "IN_PROGRESS" })

    expect(writeSnapshotAsyncMock).toHaveBeenCalledWith(expect.anything(), "case-1", "dr-jones")
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.anything(), "dr-jones", "CASE_FINALIZED", "case-1",
      { from: "IN_PROGRESS", to: "COMPLETE" },
    )
  })

  /**
   * The finding this fixes: an automatic close used to sign with the case's
   * assignee, distinguished only by the audit action name -- so the actor
   * field read exactly as if that clinician had pressed Finalize themselves.
   */
  it("signs an automatic closure as the system, not the case's assignee", async () => {
    await finalizeCaseWithinTransaction(
      fakeTx(), "case-1", "dr-jones", { currentStatus: "AWAITING_REVIEW", automatic: true },
    )

    expect(writeSnapshotAsyncMock).toHaveBeenCalledWith(expect.anything(), "case-1", AUTO_CLOSE_SYSTEM_ACTOR_ID)
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.anything(), AUTO_CLOSE_SYSTEM_ACTOR_ID, "CASE_AUTO_FINALIZED", "case-1",
      { from: "AWAITING_REVIEW", to: "COMPLETE", assignedUserId: "dr-jones" },
    )
  })

  it("does not record an assignedUserId detail on a manual finalization", async () => {
    await finalizeCaseWithinTransaction(fakeTx(), "case-1", "dr-jones", { currentStatus: "IN_PROGRESS" })

    const detail = logAuditMock.mock.calls[0]?.[4]
    expect(detail).not.toHaveProperty("assignedUserId")
  })
})
