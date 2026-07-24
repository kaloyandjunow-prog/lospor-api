import { beforeEach, describe, expect, it, vi } from "vitest"

// All mocks are set up at the top level so they apply to every module import
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { case: { findUnique: vi.fn() } } }))
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn() }))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))
vi.mock("@/lib/ai-advisor", () => ({
  SYSTEM_PROMPT: "system-prompt",
  buildPatientSummary: vi.fn().mockReturnValue("patient summary"),
}))
vi.mock("@/lib/pii-check", () => ({ redactText: (s: string) => s }))
vi.mock("@/lib/mistral", () => ({
  fetchMistralChatCompletions: vi.fn().mockResolvedValue({
    ok: true,
    body: { getReader: () => ({ read: vi.fn().mockResolvedValue({ done: true }) }) },
  }),
}))

const CASE_WITH_OPTIN = {
  id: "case-1",
  userId: "user-1",
  preop: { aiOptIn: true, ageYears: 40, sex: "MALE" },
}

function makeRequest(caseId = "case-1") {
  return new Request(`http://localhost/api/cases/${caseId}/ai/advise`, { method: "POST" }) as never
}

describe("POST /api/cases/:id/ai/advise", () => {
  let POST: (req: never, ctx: { params: Promise<{ id: string }> }) => Promise<Response>

  beforeEach(async () => {
    // Reset modules so the route's in-memory burst-throttle Map is cleared between tests
    vi.resetModules()
    process.env.MISTRAL_API_KEY = "test-key"

    // Re-resolve mocks after module reset
    const auth     = await import("@/lib/mobile-auth")
    const prismaM  = await import("@/lib/prisma")
    const rlM      = await import("@/lib/rate-limit")
    const auditM   = await import("@/lib/audit")
    const advisorM = await import("@/lib/ai-advisor")

    vi.mocked(auth.getAuthUser).mockResolvedValue({ id: "user-1", role: "MEMBER" } as never)
    vi.mocked(prismaM.prisma.case.findUnique).mockResolvedValue(CASE_WITH_OPTIN as never)
    vi.mocked(rlM.rateLimit).mockResolvedValue({ allowed: true } as never)
    vi.mocked(auditM.logAudit).mockResolvedValue(undefined)
    vi.mocked(advisorM.buildPatientSummary).mockReturnValue("patient summary")

    const mod = await import("@/app/v1/cases/[id]/ai/advise/route")
    POST = mod.POST as never
  })

  it("returns 403 when persisted preop.aiOptIn is false", async () => {
    const prismaM = await import("@/lib/prisma")
    vi.mocked(prismaM.prisma.case.findUnique).mockResolvedValue({ ...CASE_WITH_OPTIN, preop: { aiOptIn: false } } as never)
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error).toMatch(/not enabled/i)
  })

  it("returns 403 when preop record does not exist", async () => {
    const prismaM = await import("@/lib/prisma")
    vi.mocked(prismaM.prisma.case.findUnique).mockResolvedValue({ ...CASE_WITH_OPTIN, preop: null } as never)
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(403)
  })

  it("returns 403 when user does not own the case", async () => {
    const prismaM = await import("@/lib/prisma")
    vi.mocked(prismaM.prisma.case.findUnique).mockResolvedValue({ ...CASE_WITH_OPTIN, userId: "other-user" } as never)
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(res.status).toBe(403)
  })

  it("builds prompt only from server-loaded DB fields, not client body", async () => {
    const advisorM = await import("@/lib/ai-advisor")
    await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(advisorM.buildPatientSummary).toHaveBeenCalledWith(CASE_WITH_OPTIN.preop)
    expect(advisorM.buildPatientSummary).toHaveBeenCalledTimes(1)
  })

  it("logs audit against case ID, not user ID twice", async () => {
    const auditM = await import("@/lib/audit")
    await POST(makeRequest(), { params: Promise.resolve({ id: "case-1" }) })
    expect(auditM.logAudit).toHaveBeenCalledWith("user-1", "AI_ADVISE", "case-1", expect.anything())
  })

  it("returns 404 when case does not exist", async () => {
    const prismaM = await import("@/lib/prisma")
    vi.mocked(prismaM.prisma.case.findUnique).mockResolvedValue(null)
    const res = await POST(makeRequest(), { params: Promise.resolve({ id: "missing" }) })
    expect(res.status).toBe(404)
  })
})
