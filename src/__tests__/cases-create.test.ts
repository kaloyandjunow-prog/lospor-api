import { beforeEach, describe, expect, it, vi } from "vitest"

const getAuthUserMock   = vi.fn()
const findFirstMock     = vi.fn()
const findUniqueMock    = vi.fn()
const createMock        = vi.fn()
const logAuditMock      = vi.fn()

const caseCodeSequenceUpsertMock = vi.fn()

vi.mock("next/server", async importOriginal => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: vi.fn() }
})
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: getAuthUserMock }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    case: { findFirst: findFirstMock, findUnique: findUniqueMock, create: createMock },
    // Case numbers come from a forward-only counter rather than from the
    // highest case a clinician currently owns, so that handing a case away
    // cannot lower the ceiling and reissue a number already on a chart.
    caseCodeSequence: { upsert: caseCodeSequenceUpsertMock },
  },
}))
vi.mock("@/lib/audit", () => ({ logAudit: logAuditMock, logAuditInTransaction: logAuditMock }))
vi.mock("@/lib/relational-sync", () => ({ syncCaseRelationalSafe: vi.fn() }))

const MINIMAL_PREOP = {
  ageYears: 40,
  sex: "MALE",
  heightCm: 175,
  weightKg: 75,
}

const COMPLETE_POSTOP = {
  aldreteActivity: 2, aldreteRespiration: 2, aldreteCirculation: 2,
  aldreteConsciousness: 2, aldreteSpO2: 2, disposition: "WARD",
}

// A case that could genuinely be closed: the five preoperative sections
// finalization requires, and an intraoperative record with both times and a
// technique. Creating a case directly in AWAITING_REVIEW is rare, but when it
// happens it has to clear the same bar every other route into that state does.
const COMPLETE_PREOP = {
  ...MINIMAL_PREOP,
  // The array form, not the plain strings: mapPreop derives the legacy
  // `diagnosis`/`plannedProcedure` columns from these and overwrites whatever
  // strings the payload carried, so a fixture using strings alone maps to an
  // empty case-details section.
  diagnoses: [{ label: "Cholelithiasis" }],
  procedures: [{ label: "Laparoscopic cholecystectomy" }],
  bpSystolic: 128, bpDiastolic: 76, heartRate: 72, respiratoryRate: 14,
  mallampati: "II", asaScore: "II",
}

const COMPLETE_INTRAOP = {
  startedAt: "2026-09-07T08:00:00.000Z",
  endedAt: "2026-09-07T09:30:00.000Z",
  techniques: ["GENERAL"],
}

function makeRequest(body: Record<string, unknown>, idempotencyKey?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey
  return new Request("http://localhost/api/cases", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }) as Parameters<typeof POST>[0]
}

let POST: (req: never, ctx?: unknown) => Promise<Response>

describe("POST /api/cases", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    getAuthUserMock.mockResolvedValue({ id: "user-1", role: "MEMBER", institutionId: "inst-1" })
    findFirstMock.mockResolvedValue(null) // no existing draft
    findUniqueMock.mockResolvedValue(null) // for caseCode uniqueness
    let nextCaseNumber = 2
    caseCodeSequenceUpsertMock.mockImplementation(() =>
      Promise.resolve({ next: nextCaseNumber++ }))
    createMock.mockResolvedValue({
      id: "new-case-1",
      caseCode: "2026-0001",
      status: "DRAFT",
      preop: { updatedAt: new Date() },
    })
    const mod = await import("@/app/v1/cases/route")
    POST = mod.POST
  })

  it("creates a case with status DRAFT (never COMPLETE)", async () => {
    const res = await POST(makeRequest({ preop: MINIMAL_PREOP }))
    expect(res.status).toBe(201)
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DRAFT" }),
      }),
    )
    const body = await res.json()
    expect(body.id).toBeDefined()
  })

  it("deduplicates when X-Idempotency-Key matches existing clientDraftId", async () => {
    const existing = { id: "existing-case", caseCode: "2026-0001", preop: { updatedAt: new Date() } }
    findFirstMock.mockResolvedValue(existing)

    const res = await POST(makeRequest({ preop: MINIMAL_PREOP }, "draft-abc-123"))
    expect(res.status).toBe(200)
    expect(createMock).not.toHaveBeenCalled()
    const body = await res.json()
    expect(body.id).toBe("existing-case")
  })

  it("returns the existing case when a concurrent create wins the same clientDraftId", async () => {
    const existing = { id: "race-winner", caseCode: "2026-0002", preop: { updatedAt: new Date() } }
    // Two lookups, not three: case codes now come from a counter, so generating
    // one no longer reads case.findFirst on the way past.
    findFirstMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existing)
    createMock.mockRejectedValueOnce({ code: "P2002", meta: { target: ["userId", "clientDraftId"] } })

    const res = await POST(makeRequest({ preop: MINIMAL_PREOP }, "draft-race-123"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe("race-winner")
  })

  it("creates normally when no X-Idempotency-Key is provided", async () => {
    const res = await POST(makeRequest({ preop: MINIMAL_PREOP }))
    expect(res.status).toBe(201)
    expect(createMock).toHaveBeenCalled()
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ clientDraftId: expect.anything() }),
      }),
    )
  })

  // A postop object being present is not the same as postop being complete --
  // see the same DO NOT comment in _patch-status.ts. Before this fix, sending
  // any postop object at all -- even one field -- promoted straight to
  // AWAITING_REVIEW and started the 30-minute closure countdown on a record
  // that would not pass finalize's own readiness gate.
  it("does not promote to AWAITING_REVIEW on an incomplete postop object", async () => {
    const res = await POST(makeRequest({
      preop: MINIMAL_PREOP,
      intraop: {},
      postop: { aldreteActivity: 2 }, // one of five Aldrete components, no disposition
    }))
    expect(res.status).toBe(201)
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "IN_PROGRESS", awaitingReviewAt: null }),
      }),
    )
  })

  // This test used to assert the opposite, and in doing so documented a defect
  // as intended behaviour: a complete recovery score beside a four-field preop
  // and no intraoperative record at all opened straight into AWAITING_REVIEW.
  // That started the thirty-minute closure countdown on a case finalization
  // would refuse for the preop and intraop it never had -- a promise of a
  // closure that could not happen, on a case nobody was still looking at.
  it("does not promote a complete postop when the rest of the case is not complete", async () => {
    const res = await POST(makeRequest({
      preop: MINIMAL_PREOP,
      postop: COMPLETE_POSTOP,
    }))
    expect(res.status).toBe(201)
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "DRAFT", awaitingReviewAt: null }),
      }),
    )
  })

  it("promotes to AWAITING_REVIEW only when the whole case could be closed", async () => {
    const res = await POST(makeRequest({
      preop: COMPLETE_PREOP,
      intraop: COMPLETE_INTRAOP,
      postop: COMPLETE_POSTOP,
    }))
    expect(res.status).toBe(201)
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "AWAITING_REVIEW" }),
      }),
    )
  })

  it("returns 400 when preop is missing", async () => {
    const res = await POST(makeRequest({ intraop: {} }))
    expect(res.status).toBe(400)
    expect(createMock).not.toHaveBeenCalled()
  })

  it("returns a structured permanent PII error for legacy free-text diagnosis", async () => {
    const res = await POST(makeRequest({
      preop: { ...MINIMAL_PREOP, diagnosis: "Ivan Petrov" },
    }))

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({
      code: "PII_BLOCKED",
      field: "diagnosis",
      reason: "likely_name",
      retryable: false,
      blockedKeys: ["diagnosis", "icdCode"],
    })
    expect(createMock).not.toHaveBeenCalled()
  })

  it("accepts an uppercase Bulgarian diagnosis selected from ICD-10", async () => {
    const res = await POST(makeRequest({
      preop: {
        ...MINIMAL_PREOP,
        diagnoses: [{ code: "K35", label: "ОСТЪР АПЕНДИСИТ", system: "ICD-10" }],
        diagnosis: "ОСТЪР АПЕНДИСИТ",
        icdCode: "K35",
      },
    }))

    expect(res.status).toBe(201)
    expect(createMock).toHaveBeenCalled()
  })
})
