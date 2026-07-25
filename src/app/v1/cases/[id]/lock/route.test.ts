import { beforeEach, describe, expect, it, vi } from "vitest"

const getAuthUser = vi.fn()
const findCase = vi.fn()
const findUser = vi.fn()
const deleteLocks = vi.fn()
const acquireAtomic = vi.fn()
const readLock = vi.fn()

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    case: { findUnique: findCase },
    user: { findUnique: findUser },
    caseLock: { deleteMany: deleteLocks },
  },
}))
vi.mock("@/lib/case-lock-repository", () => ({
  acquireCaseLockAtomic: acquireAtomic,
  readCaseLock: readLock,
}))

const context = { params: Promise.resolve({ id: "case-1" }) }

function request(method: string, body: unknown) {
  return new Request("http://localhost/v1/cases/case-1/lock", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never
}

describe("case lock route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAuthUser.mockResolvedValue({ id: "user-1", role: "MEMBER", institutionId: "inst-1" })
    findCase.mockResolvedValue({
      userId: "user-1",
      status: "IN_PROGRESS",
      user: { institutionId: "inst-1" },
    })
    acquireAtomic.mockResolvedValue({
      caseId: "case-1",
      userId: "user-1",
      deviceId: "device-1",
      expiresAt: new Date(Date.now() + 30_000),
    })
  })

  it("acquires through the atomic repository", async () => {
    const { POST } = await import("./route")
    const response = await POST(request("POST", { deviceId: "device-1" }), context)

    expect(response.status).toBe(200)
    expect(acquireAtomic).toHaveBeenCalledWith(expect.objectContaining({
      caseId: "case-1",
      userId: "user-1",
      deviceId: "device-1",
    }))
    await expect(response.json()).resolves.toMatchObject({ acquired: true, yours: true })
  })

  it("rejects an empty device identity", async () => {
    const { POST } = await import("./route")
    const response = await POST(request("POST", { deviceId: " " }), context)

    expect(response.status).toBe(400)
    expect(acquireAtomic).not.toHaveBeenCalled()
  })

  it("reports the actual holder after losing the compare-and-set", async () => {
    const expiresAt = new Date(Date.now() + 30_000)
    acquireAtomic.mockResolvedValue(null)
    readLock.mockResolvedValue({
      caseId: "case-1",
      userId: "user-2",
      deviceId: "device-2",
      expiresAt,
    })
    findUser.mockResolvedValue({ name: "Other clinician", email: "other@example.test" })
    const { POST } = await import("./route")

    const response = await POST(request("POST", { deviceId: "device-1" }), context)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      acquired: false,
      holderName: "Other clinician",
    })
  })

  it("does not let a heartbeat overwrite another active lease", async () => {
    acquireAtomic.mockResolvedValue(null)
    const { PATCH } = await import("./route")

    const response = await PATCH(request("PATCH", { deviceId: "device-1" }), context)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ extended: false })
  })

  it("force releases the current lease after case authorization", async () => {
    const { DELETE } = await import("./route")
    const response = await DELETE(request("DELETE", { force: true }), context)

    expect(response.status).toBe(200)
    expect(deleteLocks).toHaveBeenCalledWith({ where: { caseId: "case-1" } })
  })
})
