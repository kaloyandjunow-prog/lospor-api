import { beforeEach, describe, expect, it, vi } from "vitest"

const getAuthUser = vi.fn()
const findCase = vi.fn()
const touch = vi.fn()
const leave = vi.fn()

vi.mock("@/lib/mobile-auth", () => ({ getAuthUser }))
vi.mock("@/lib/prisma", () => ({ prisma: { case: { findFirst: findCase } } }))
vi.mock("@/lib/case-presence", () => ({ touchCasePresence: touch, leaveCasePresence: leave }))

const context = { params: Promise.resolve({ id: "case-1" }) }
const request = (method: string, body: unknown) => new Request("http://localhost/v1/cases/case-1/presence", {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}) as never

describe("case presence route", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAuthUser.mockResolvedValue({ id: "user-1", role: "MEMBER", institutionId: "inst-1" })
    findCase.mockResolvedValue({ id: "case-1" })
    touch.mockResolvedValue({ people: [{ name: "Мария", you: true }, { name: "Иван", you: false }], screens: 2 })
  })

  it("reports a screen and answers with the people in the case", async () => {
    const { POST } = await import("./route")
    const response = await POST(request("POST", { deviceId: "device-1" }), context)
    expect(response.status).toBe(200)
    expect(touch).toHaveBeenCalledWith({ caseId: "case-1", userId: "user-1", deviceId: "device-1" })
    await expect(response.json()).resolves.toEqual({ people: [{ name: "Мария", you: true }, { name: "Иван", you: false }], screens: 2 })
  })

  it("leaves the case when the screen closes", async () => {
    const { DELETE } = await import("./route")
    const response = await DELETE(request("DELETE", { deviceId: "device-1" }), context)
    expect(response.status).toBe(200)
    expect(leave).toHaveBeenCalledWith({ caseId: "case-1", userId: "user-1", deviceId: "device-1" })
  })

  it("refuses a screen that may not change the case, and a missing device", async () => {
    const { POST } = await import("./route")
    findCase.mockResolvedValueOnce(null)
    expect((await POST(request("POST", { deviceId: "device-1" }), context)).status).toBe(404)
    expect((await POST(request("POST", {}), context)).status).toBe(400)
    getAuthUser.mockResolvedValueOnce(null)
    expect((await POST(request("POST", { deviceId: "device-1" }), context)).status).toBe(401)
    expect(touch).not.toHaveBeenCalled()
  })
})
