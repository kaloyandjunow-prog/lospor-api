import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

const { query, activeLegalManifest, administratorMfaKeyIsReady } = vi.hoisted(() => ({
  query: vi.fn(),
  activeLegalManifest: vi.fn(),
  administratorMfaKeyIsReady: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({ prisma: { $queryRaw: query } }))
vi.mock("@/lib/legal-documents", () => ({
  activeLegalManifest,
  LegalConfigurationError: class LegalConfigurationError extends Error {},
}))
vi.mock("@/lib/administrator-mfa", () => ({ administratorMfaKeyIsReady }))

import { LegalConfigurationError } from "@/lib/legal-documents"
import { GET } from "./route"

describe("GET /health/ready", () => {
  const originalMfaRequired = process.env.LOSPOR_ADMIN_MFA_REQUIRED

  beforeEach(() => {
    vi.clearAllMocks()
    query.mockResolvedValue([{ ok: 1 }])
    activeLegalManifest.mockReturnValue({ deployment: "public-demo-2026-09" })
    administratorMfaKeyIsReady.mockReturnValue(true)
    delete process.env.LOSPOR_ADMIN_MFA_REQUIRED
  })

  it("reports the active legal deployment when the service is ready", async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: "ready",
      database: "ok",
      legalDocuments: "configured",
      legalDeployment: "public-demo-2026-09",
      administratorMfa: "not-required",
    })
  })

  it("fails closed when a deployment requires administrator MFA without a usable key", async () => {
    process.env.LOSPOR_ADMIN_MFA_REQUIRED = "true"
    administratorMfaKeyIsReady.mockReturnValue(false)
    const response = await GET()
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      database: "ok",
      legalDocuments: "configured",
      administratorMfa: "unavailable",
    })
  })

  it("fails readiness when exact bilingual legal documents are unavailable", async () => {
    activeLegalManifest.mockImplementation(() => {
      throw new LegalConfigurationError("missing")
    })
    const response = await GET()
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      database: "ok",
      legalDocuments: "unavailable",
    })
  })

  it("does not claim legal validation after a database failure", async () => {
    query.mockRejectedValue(new Error("database down"))
    const response = await GET()
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      database: "error",
      legalDocuments: "unchecked",
    })
    expect(activeLegalManifest).not.toHaveBeenCalled()
  })

  afterAll(() => {
    if (originalMfaRequired === undefined) delete process.env.LOSPOR_ADMIN_MFA_REQUIRED
    else process.env.LOSPOR_ADMIN_MFA_REQUIRED = originalMfaRequired
  })
})
