import { beforeEach, describe, expect, it, vi } from "vitest"

const getAuthUserMock = vi.fn()
const findUniqueMock  = vi.fn()
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
vi.mock("@/lib/prisma", () => ({
  prisma: {
    case: { findUnique: findUniqueMock, update: updateMock },
  },
}))
vi.mock("@/lib/case-audit", () => ({ writeSnapshotAsync: writeSnapshotAsyncMock }))
vi.mock("@/lib/relational-sync", () => ({ syncCaseRelational: syncCaseRelationalMock }))
vi.mock("@/lib/access-control", () => ({ canAccessCase: canAccessCaseMock }))
vi.mock("@/lib/audit", () => ({ logAudit: logAuditMock }))

const VALID_CASE = {
  userId: "user-1",
  status: "IN_PROGRESS",
  user: { institutionId: "inst-1" },
  preop: { id: "preop-1" },
  intraop: {
    id: "intraop-1",
    startTime: new Date("2026-01-01T08:00:00Z"),
    endTime:   new Date("2026-01-01T10:00:00Z"),
    techniques: ["GA"],
  },
  postop: {
    aldreteActivity: 2,
    aldreteRespiration: null,
    aldreteCirculation: null,
    aldreteConsciousness: null,
    aldreteSpO2: null,
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
    canAccessCaseMock.mockReturnValue(true)
    findUniqueMock.mockResolvedValue(VALID_CASE)
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

  it("returns 403 when user does not own the case", async () => {
    canAccessCaseMock.mockReturnValue(false)
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(403)
    expect(writeSnapshotAsyncMock).not.toHaveBeenCalled()
  })

  it("returns 422 when preop is missing", async () => {
    findUniqueMock.mockResolvedValue({ ...VALID_CASE, preop: null })
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.reason).toBe("missing_preop")
  })

  it("returns 422 when intraop has no startTime", async () => {
    findUniqueMock.mockResolvedValue({ ...VALID_CASE, intraop: { ...VALID_CASE.intraop, startTime: null } })
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.reason).toBe("missing_start_time")
  })

  it("returns 422 when intraop has no technique", async () => {
    findUniqueMock.mockResolvedValue({ ...VALID_CASE, intraop: { ...VALID_CASE.intraop, techniques: [] } })
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.reason).toBe("missing_technique")
  })

  it("returns 422 when postop has no Aldrete subscore", async () => {
    findUniqueMock.mockResolvedValue({
      ...VALID_CASE,
      postop: { aldreteActivity: null, aldreteRespiration: null, aldreteCirculation: null, aldreteConsciousness: null, aldreteSpO2: null, disposition: "WARD" },
    })
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.reason).toBe("missing_aldrete")
  })

  it("returns 422 when postop has no disposition", async () => {
    findUniqueMock.mockResolvedValue({
      ...VALID_CASE,
      postop: { ...VALID_CASE.postop, disposition: null },
    })
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.reason).toBe("missing_disposition")
  })

  it("writes snapshot before updating status", async () => {
    const order: string[] = []
    syncCaseRelationalMock.mockImplementation(() => { order.push("sync"); return Promise.resolve() })
    writeSnapshotAsyncMock.mockImplementation(() => { order.push("snapshot"); return Promise.resolve() })
    updateMock.mockImplementation(() => { order.push("update"); return Promise.resolve({ id: "case-1", status: "COMPLETE" }) })
    await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(order).toEqual(["sync", "snapshot", "update"])
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
    findUniqueMock.mockResolvedValue({ ...VALID_CASE, status: "COMPLETE" })
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(409)
    expect(writeSnapshotAsyncMock).not.toHaveBeenCalled()
  })
})
