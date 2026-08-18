import { beforeEach, describe, expect, it, vi } from "vitest"

const getAuthUserMock = vi.fn()
const findUniqueMock  = vi.fn()
const findPreopMock   = vi.fn()
const findIntraopMock = vi.fn()
const findPostopMock  = vi.fn()
const updateMock      = vi.fn()
const writeSnapshotAsyncMock = vi.fn()
const canAccessCaseMock = vi.fn()
const logAuditMock    = vi.fn()
const syncCaseRelationalMock = vi.fn()

vi.mock("next/server", async importOriginal => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: vi.fn() }
})
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: getAuthUserMock }))
vi.mock("@/lib/clinical-transaction", () => ({
  CaseWriteError: class CaseWriteError extends Error {
    constructor(readonly code: string, readonly status: number, message: string) {
      super(message)
    }
  },
  withLockedCaseTransaction: vi.fn((_caseId: string, operation: (tx: unknown) => Promise<unknown>) =>
    operation({
      case: { findUnique: findUniqueMock, update: updateMock },
      preoperativeAssessment: { findUnique: findPreopMock },
      intraoperativeRecord: { findUnique: findIntraopMock },
      postoperativeRecord: { findUnique: findPostopMock },
    })),
}))
vi.mock("@/lib/case-audit", () => ({ writeSnapshotAsync: writeSnapshotAsyncMock }))
vi.mock("@/lib/relational-sync", () => ({ syncCaseRelational: syncCaseRelationalMock }))
vi.mock("@/lib/access-control", () => ({ canAccessCaseWithOwnerFallback: canAccessCaseMock }))
vi.mock("@/lib/audit", () => ({ logAudit: logAuditMock, logAuditInTransaction: logAuditMock }))

const VALID_CASE = {
  userId: "user-1",
  status: "IN_PROGRESS",
  user: { institutionId: "inst-1" },
  // A complete assessment, not merely a row. Finalisation used to check only
  // that the preoperative record existed, so `{ id }` was enough to mark a case
  // COMPLETE through the API while the clients refused to.
  preop: {
    id: "preop-1",
    ageYears: 44,
    sex: "FEMALE",
    heightCm: 168,
    weightKg: 70,
    diagnoses: ["K80.2"],
    procedures: ["0FT44ZZ"],
    bpSystolic: 128,
    bpDiastolic: 76,
    heartRate: 72,
    respiratoryRate: 14,
    mallampati: "II",
    asaScore: 2,
  },
  intraop: {
    id: "intraop-1",
    startTime: new Date("2026-01-01T08:00:00Z"),
    endTime:   new Date("2026-01-01T10:00:00Z"),
    techniques: ["GA"],
  },
  // Every component. One subscore with the rest null used to be enough, and
  // the missing ones were then counted as zero — documenting a patient nobody
  // had assessed as unresponsive and apnoeic.
  postop: {
    aldreteActivity: 2,
    aldreteRespiration: 2,
    aldreteCirculation: 2,
    aldreteConsciousness: 2,
    aldreteSpO2: 2,
    disposition: "WARD",
  },
}

function makeRequest(caseId = "case-1") {
  return new Request(`http://localhost/api/cases/${caseId}/finalize`, { method: "POST" }) as Parameters<typeof POST>[0]
}

let POST: (req: never, ctx: { params: Promise<{ id: string }> }) => Promise<Response>

describe("POST /api/cases/:id/finalize", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    getAuthUserMock.mockResolvedValue({ id: "user-1", role: "MEMBER", institutionId: "inst-1" })
    canAccessCaseMock.mockResolvedValue(true)
    findUniqueMock.mockResolvedValue({
      userId: VALID_CASE.userId,
      status: VALID_CASE.status,
      institutionId: "inst-1",
    })
    findPreopMock.mockResolvedValue(VALID_CASE.preop)
    findIntraopMock.mockResolvedValue(VALID_CASE.intraop)
    findPostopMock.mockResolvedValue(VALID_CASE.postop)
    syncCaseRelationalMock.mockResolvedValue(undefined)
    writeSnapshotAsyncMock.mockResolvedValue(undefined)
    updateMock.mockResolvedValue({ id: "case-1", status: "COMPLETE" })
    const mod = await import("@/app/v1/cases/[id]/finalize/route")
    POST = mod.POST
  })

  it("succeeds with a fully populated case", async () => {
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(200)
    expect(writeSnapshotAsyncMock).toHaveBeenCalled()
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETE" }) }))
  })

  it("accepts the current startedAt and endedAt fields", async () => {
    findIntraopMock.mockResolvedValue({
      ...VALID_CASE.intraop,
      startedAt: new Date("2026-01-01T08:00:00Z"),
      endedAt: new Date("2026-01-01T10:00:00Z"),
      startTime: null,
      endTime: null,
    })
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(200)
    expect(findIntraopMock.mock.calls[0]?.[0]).toMatchObject({
      select: {
        startedAt: true,
        endedAt: true,
      },
    })
  })

  it("returns 403 when user does not own the case", async () => {
    canAccessCaseMock.mockResolvedValue(false)
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(403)
    expect(writeSnapshotAsyncMock).not.toHaveBeenCalled()
  })

  it("returns 422 when preop is missing", async () => {
    findPreopMock.mockResolvedValue(null)
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.reason).toBe("missing_preop")
  })

  it("returns 422 when intraop has no startTime", async () => {
    findIntraopMock.mockResolvedValue({ ...VALID_CASE.intraop, startTime: null })
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.reason).toBe("missing_start_time")
  })

  it("returns 422 when intraop has no technique", async () => {
    findIntraopMock.mockResolvedValue({ ...VALID_CASE.intraop, techniques: [] })
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.reason).toBe("missing_technique")
  })

  it("returns 422 when postop has no Aldrete subscore", async () => {
    findPostopMock.mockResolvedValue({ aldreteActivity: null, aldreteRespiration: null, aldreteCirculation: null, aldreteConsciousness: null, aldreteSpO2: null, disposition: "WARD" })

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.reason).toBe("missing_aldrete")
  })

  it("returns 422 when the Aldrete assessment is only partly done", async () => {
    // One subscore used to be enough, and core then counted the other four as
    // zero — a finalised record describing a patient nobody had assessed as
    // unresponsive and apnoeic.
    findPostopMock.mockResolvedValue({ ...VALID_CASE.postop, aldreteSpO2: null })

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.reason).toBe("missing_aldrete")
  })

  it("returns 422 when the preoperative assessment exists but is incomplete", async () => {
    // Existence was the only test, so a draft with nothing but an id could be
    // finalised through the API while every client refused to.
    findPreopMock.mockResolvedValue({ id: "preop-1" })

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.reason).toBe("incomplete_preop")
    // Every gap, not just the first: fixing them one at a time is a guessing game.
    expect(body.blockers.length).toBeGreaterThan(1)
    expect(body.blockers.flatMap((item: { path: string[] }) => item.path)).toContain("preop.demographics")
  })

  it("returns 422 when postop has no disposition", async () => {
    findPostopMock.mockResolvedValue({ ...VALID_CASE.postop, disposition: null })

    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.reason).toBe("missing_disposition")
  })

  it("writes the COMPLETE state before snapshotting inside one transaction", async () => {
    const order: string[] = []
    syncCaseRelationalMock.mockImplementation(() => { order.push("sync"); return Promise.resolve() })
    writeSnapshotAsyncMock.mockImplementation(() => { order.push("snapshot"); return Promise.resolve() })
    updateMock.mockImplementation(() => { order.push("update"); return Promise.resolve({ id: "case-1", status: "COMPLETE" }) })
    await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(order).toEqual(["sync", "update", "snapshot"])
  })

  it("blocks finalization when relational sync fails", async () => {
    syncCaseRelationalMock.mockRejectedValue(new Error("mirror failed"))
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toContain("relational clinical rows")
    expect(writeSnapshotAsyncMock).not.toHaveBeenCalled()
    expect(updateMock).not.toHaveBeenCalled()
  })

  it("returns 409 when case is already COMPLETE", async () => {
    findUniqueMock.mockResolvedValue({ userId: VALID_CASE.userId, status: "COMPLETE", institutionId: "inst-1" })
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(409)
    expect(writeSnapshotAsyncMock).not.toHaveBeenCalled()
  })
})
