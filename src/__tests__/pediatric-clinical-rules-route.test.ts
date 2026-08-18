import { beforeEach, describe, expect, it, vi } from "vitest"

const getAuthUserMock = vi.fn()
const loadWorkbenchMock = vi.fn()
const createRulesetMock = vi.fn()
const upsertRuleMock = vi.fn()
const deleteRuleMock = vi.fn()
const publishRulesetMock = vi.fn()
const selectRulesetMock = vi.fn()
const clearSelectionMock = vi.fn()
const logAuditMock = vi.fn()

class MockServiceError extends Error {
  constructor(readonly status: number, message: string, readonly issues?: unknown) {
    super(message)
  }
}

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: getAuthUserMock }))
vi.mock("@/lib/audit", () => ({ logAudit: logAuditMock, logAuditInTransaction: logAuditMock }))
vi.mock("@/lib/clinical-rules/service", () => ({
  ClinicalRuleServiceError: MockServiceError,
  loadClinicalRulesWorkbench: loadWorkbenchMock,
  createClinicalRuleset: createRulesetMock,
  upsertClinicalRulesetRule: upsertRuleMock,
  deleteClinicalRulesetRule: deleteRuleMock,
  publishClinicalRuleset: publishRulesetMock,
  selectClinicalRuleset: selectRulesetMock,
  clearClinicalRulesetSelection: clearSelectionMock,
}))

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/v1/clinical/rules/workbench", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("clinical rules workbench route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAuthUserMock.mockResolvedValue({
      id: "hod-1",
      role: "HEAD_OF_DEPT",
      institutionId: "inst-1",
      institutionName: "Hospital A",
    })
    loadWorkbenchMock.mockResolvedValue({
      clinicalMode: "ADULT",
      actor: {},
      management: {},
      presets: [],
      institutions: [],
      reviewers: [],
      overrides: [],
      effectiveRules: [],
      selections: [],
    })
    logAuditMock.mockResolvedValue(undefined)
  })

  it("loads the requested mode in the caller institution", async () => {
    const { GET } = await import("@/app/v1/clinical/rules/workbench/route")
    const response = await GET(new Request(
      "http://localhost/v1/clinical/rules/workbench?mode=PEDIATRIC",
    ) as Parameters<typeof GET>[0])
    expect(response.status).toBe(200)
    expect(loadWorkbenchMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "hod-1" }),
      null,
      "PEDIATRIC",
    )
  })

  it("passes an explicit personal management scope to the service", async () => {
    const { GET } = await import("@/app/v1/clinical/rules/workbench/route")
    const response = await GET(new Request(
      "http://localhost/v1/clinical/rules/workbench?scope=USER",
    ) as Parameters<typeof GET>[0])
    expect(response.status).toBe(200)
    expect(loadWorkbenchMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "hod-1" }),
      "USER",
      "ADULT",
    )
  })

  it("rejects an invalid management scope", async () => {
    const { GET } = await import("@/app/v1/clinical/rules/workbench/route")
    const response = await GET(new Request(
      "http://localhost/v1/clinical/rules/workbench?scope=ALL_INSTITUTIONS",
    ) as Parameters<typeof GET>[0])
    expect(response.status).toBe(400)
    expect(loadWorkbenchMock).not.toHaveBeenCalled()
  })

  it("lets a HOD create a full institution copy", async () => {
    createRulesetMock.mockResolvedValue({
      id: "ruleset-1",
      key: "HOSPITAL_A_ADULT",
      version: 1,
      scope: "INSTITUTION",
      clinicalMode: "ADULT",
    })
    const body = {
      action: "create-ruleset",
      scope: "INSTITUTION",
      clinicalMode: "ADULT",
      key: "HOSPITAL_A_ADULT",
      name: "Hospital A adult rules",
      copyFromPresetId: "lospor-adults-v1",
    }
    const { POST } = await import("@/app/v1/clinical/rules/workbench/route")
    const response = await POST(request(body) as Parameters<typeof POST>[0])
    expect(response.status).toBe(201)
    expect(createRulesetMock).toHaveBeenCalledWith({
      actor: expect.objectContaining({ id: "hod-1" }),
      ...body,
    })
  })

  it("supports personal selection and fallback clearing", async () => {
    selectRulesetMock.mockResolvedValue({ presetId: "personal-1" })
    clearSelectionMock.mockResolvedValue({ count: 1 })
    const { POST } = await import("@/app/v1/clinical/rules/workbench/route")
    const selected = await POST(request({
      action: "select-ruleset",
      scope: "USER",
      clinicalMode: "ADULT",
      presetId: "personal-1",
    }) as Parameters<typeof POST>[0])
    expect(selected.status).toBe(200)

    const cleared = await POST(request({
      action: "clear-selection",
      scope: "USER",
      clinicalMode: "ADULT",
    }) as Parameters<typeof POST>[0])
    expect(cleared.status).toBe(200)
  })

  it("returns specific service errors", async () => {
    publishRulesetMock.mockRejectedValue(new MockServiceError(
      409,
      "An empty ruleset cannot be published",
    ))
    const { POST } = await import("@/app/v1/clinical/rules/workbench/route")
    const response = await POST(request({
      action: "publish-ruleset",
      presetId: "empty-1",
    }) as Parameters<typeof POST>[0])
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: "An empty ruleset cannot be published",
    })
  })
})
