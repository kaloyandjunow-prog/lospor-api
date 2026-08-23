import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { AUDIT_ACTION_REGISTRY } from "@/lib/audit-actions"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  count: vi.fn(),
  findMany: vi.fn(),
  users: vi.fn(),
  technicalPrincipals: vi.fn(),
}))

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser: mocks.auth }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    auditLog: { count: mocks.count, findMany: mocks.findMany },
    user: { findMany: mocks.users },
    technicalPrincipal: { findMany: mocks.technicalPrincipals },
  },
}))

describe("administrator audit history contract", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({ id: "admin-1", role: "ADMIN" })
    mocks.count.mockResolvedValue(1)
    mocks.findMany.mockResolvedValue([{
      id: "audit-1",
      userId: "admin-1",
      action: "ACCOUNT_ACTIVATE",
      entityId: "user-1",
      detail: { activationMethod: "EMAIL_VERIFICATION" },
      createdAt: new Date("2026-08-23T10:00:00.000Z"),
    }])
    mocks.users.mockResolvedValue([{ id: "admin-1", name: "Administrator" }])
    mocks.technicalPrincipals.mockResolvedValue([])
  })

  it("returns the complete bilingual action catalog with each page", async () => {
    const { GET } = await import("./route")
    const response = await GET(new NextRequest(
      "https://api.lospor.org/v1/admin/audit-logs?action=ACCOUNT_ACTIVATE",
    ))
    expect(response.status).toBe(200)
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { action: "ACCOUNT_ACTIVATE" },
    }))
    await expect(response.json()).resolves.toMatchObject({
      logs: [expect.objectContaining({ action: "ACCOUNT_ACTIVATE" })],
      actions: AUDIT_ACTION_REGISTRY,
      page: 0,
      pageSize: 50,
    })
  })

  it("rejects unknown filter codes before querying audit rows", async () => {
    const { GET } = await import("./route")
    const response = await GET(new NextRequest(
      "https://api.lospor.org/v1/admin/audit-logs?action=UNREGISTERED_ACTION",
    ))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ code: "UNKNOWN_AUDIT_ACTION" })
    expect(mocks.count).not.toHaveBeenCalled()
    expect(mocks.findMany).not.toHaveBeenCalled()
  })

  it("normalizes an invalid page rather than passing NaN to Prisma", async () => {
    const { GET } = await import("./route")
    const response = await GET(new NextRequest(
      "https://api.lospor.org/v1/admin/audit-logs?page=not-a-number",
    ))
    expect(response.status).toBe(200)
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 0 }))
  })

  it("shows a release audit under its friendly non-account identity", async () => {
    mocks.findMany.mockResolvedValue([{
      id: "audit-release",
      userId: "lospor-release:1.2.0",
      action: "CLINICAL_BUNDLED_BASELINE_PROVISION",
      entityId: "lospor-adults-v2",
      detail: {},
      createdAt: new Date("2026-08-23T10:00:00.000Z"),
    }])
    mocks.users.mockResolvedValue([])
    mocks.technicalPrincipals.mockResolvedValue([{
      id: "lospor-release:1.2.0",
      displayName: "LOSPOR 1.2.0",
    }])
    const { GET } = await import("./route")

    const response = await GET(new NextRequest("https://api.lospor.org/v1/admin/audit-logs"))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      logs: [{ user: { name: "LOSPOR 1.2.0" } }],
    })
  })
})
