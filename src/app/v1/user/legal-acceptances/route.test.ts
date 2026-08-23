import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  transaction: vi.fn(),
  legalCreateMany: vi.fn(),
  userUpdate: vi.fn(),
  auditCreate: vi.fn(),
  findMany: vi.fn(),
}))

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: mocks.auth }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    legalAcceptance: { findMany: mocks.findMany },
    $transaction: mocks.transaction,
  },
}))

const manifest = {
  deployment: "test",
  documents: (["bg", "en"] as const).flatMap(locale => (
    ["TERMS", "PRIVACY"] as const
  ).map(kind => ({
    deployment: "test",
    kind,
    version: kind === "TERMS" ? "5" : "3",
    effectiveDate: "2026-09-01",
    locale,
    content: `${locale}:${kind}`,
  }))),
}

function references() {
  return manifest.documents.filter(document => document.locale === "bg").map(document => ({
    deployment: document.deployment,
    kind: document.kind,
    version: document.version,
    effectiveDate: document.effectiveDate,
    locale: document.locale,
    contentSha256: createHash("sha256").update(document.content).digest("hex"),
  }))
}

describe("legal acceptance audit", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    process.env.LOSPOR_LEGAL_DOCUMENTS_JSON = JSON.stringify(manifest)
    const { resetLegalManifestCacheForTests } = await import("@/lib/legal-documents")
    resetLegalManifestCacheForTests()
    mocks.auth.mockResolvedValue({ id: "user-1" })
    mocks.legalCreateMany.mockResolvedValue({ count: 2 })
    mocks.userUpdate.mockResolvedValue({})
    mocks.auditCreate.mockResolvedValue({})
    mocks.transaction.mockImplementation(async callback => callback({
      legalAcceptance: { createMany: mocks.legalCreateMany },
      user: { update: mocks.userUpdate },
      auditLog: { create: mocks.auditCreate },
    }))
  })

  it("records exact document descriptors in the legal transaction without account PII", async () => {
    const { POST } = await import("./route")
    const response = await POST(new Request("https://api.lospor.org/v1/user/legal-acceptances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acceptances: references() }),
    }) as never)

    expect(response.status).toBe(200)
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-1",
        action: "LEGAL_ACCEPTANCE_RECORD",
        entityId: "user-1",
        detail: expect.objectContaining({
          acceptedDocumentCount: 2,
          documents: expect.arrayContaining([
            expect.objectContaining({ kind: "TERMS", locale: "bg", contentSha256: expect.any(String) }),
            expect.objectContaining({ kind: "PRIVACY", locale: "bg", contentSha256: expect.any(String) }),
          ]),
        }),
      }),
    })
    expect(JSON.stringify(mocks.auditCreate.mock.calls)).not.toContain("email")
  })

  it("does not claim a new acceptance when both exact rows already exist", async () => {
    mocks.legalCreateMany.mockResolvedValue({ count: 0 })
    const { POST } = await import("./route")
    const response = await POST(new Request("https://api.lospor.org/v1/user/legal-acceptances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acceptances: references() }),
    }) as never)
    expect(response.status).toBe(200)
    expect(mocks.userUpdate).not.toHaveBeenCalled()
    expect(mocks.auditCreate).not.toHaveBeenCalled()
  })

  // HAUD_ROLLBACK:legal-acceptance-refresh
  it("does not report acceptance when the durable legal audit row fails", async () => {
    mocks.auditCreate.mockRejectedValueOnce(new Error("audit unavailable"))
    const { POST } = await import("./route")

    await expect(POST(new Request("https://api.lospor.org/v1/user/legal-acceptances", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acceptances: references() }),
    }) as never)).rejects.toThrow("audit unavailable")
  })
})
