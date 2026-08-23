import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({ getAuthUser: vi.fn(), findMany: vi.fn() }))
vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: mocks.getAuthUser }))
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findMany: mocks.findMany } } }))
vi.mock("@/lib/legal-documents", () => ({
  activeLegalDocuments: () => [],
  mapLegalAcceptance: (value: unknown) => value,
}))

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    email: "doctor@example.com",
    username: null,
    name: "Dr Test",
    firstName: "Test",
    lastName: "Doctor",
    title: "Dr",
    role: "MEMBER",
    accountKind: "CLINICAL",
    activatedAt: new Date(),
    emailVerifiedAt: new Date(),
    suspendedAt: null,
    recoveryRequiredAt: null,
    deletedAt: null,
    anonymizedAt: null,
    createdAt: new Date(),
    lastLoginAt: null,
    passwordChangedAt: null,
    preferences: { ui: { locale: "bg" } },
    legalAcceptances: [],
    institution: { id: "inst-1", name: "Hospital", city: "Sofia" },
    ...overrides,
  }
}

describe("truthful administrator account list", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getAuthUser.mockResolvedValue({ id: "admin-1", role: "ADMIN" })
    mocks.findMany.mockResolvedValue([account()])
  })

  it("includes recoverable deleted accounts by default with derived lifecycle metadata", async () => {
    const deletedAt = new Date("2026-08-01T00:00:00Z")
    mocks.findMany.mockResolvedValue([account({ deletedAt })])
    const { GET } = await import("./route")
    const response = await GET(new NextRequest("https://api.lospor.org/v1/admin/users"))
    const [record] = await response.json()
    expect(record).toMatchObject({
      status: "DELETION_PENDING",
      deletionDeadline: "2026-08-31T00:00:00.000Z",
      preferredLocale: "bg",
      legalCurrent: true,
    })
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { anonymizedAt: null },
    }))
  })

  it("supports typed status filters and the one-release pending compatibility alias", async () => {
    const { GET } = await import("./route")
    await GET(new NextRequest("https://api.lospor.org/v1/admin/users?status=SUSPENDED"))
    expect(mocks.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ suspendedAt: { not: null }, deletedAt: null }),
    }))
    await GET(new NextRequest("https://api.lospor.org/v1/admin/users?pending=true"))
    expect(mocks.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ activatedAt: null, deletedAt: null }),
    }))
  })

  it("rejects unknown lifecycle filters without querying accounts", async () => {
    const { GET } = await import("./route")
    const response = await GET(new NextRequest("https://api.lospor.org/v1/admin/users?status=DELETED"))
    expect(response.status).toBe(400)
    expect(mocks.findMany).not.toHaveBeenCalled()
  })

  it("filters case-insensitively across username, optional contact email, and display name", async () => {
    const { GET } = await import("./route")
    const response = await GET(new NextRequest("https://api.lospor.org/v1/admin/users?q=Clinician.One"))
    expect(response.status).toBe(200)
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        AND: [
          { anonymizedAt: null },
          {
            OR: [
              { username: { contains: "Clinician.One", mode: "insensitive" } },
              { email: { contains: "Clinician.One", mode: "insensitive" } },
              { name: { contains: "Clinician.One", mode: "insensitive" } },
            ],
          },
        ],
      },
    }))
  })
})
