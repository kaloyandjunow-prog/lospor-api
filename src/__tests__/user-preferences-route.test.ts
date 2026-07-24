import { beforeEach, describe, expect, it, vi } from "vitest"

const getAuthUserMock = vi.fn()
const findUniqueMock = vi.fn()
const updateMock = vi.fn()

vi.mock("@/lib/mobile-auth", () => ({
  getAuthUser: getAuthUserMock,
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: findUniqueMock,
      update: updateMock,
    },
  },
}))

describe("/api/user preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getAuthUserMock.mockResolvedValue({ id: "user-1" })
  })

  it("returns stored user preferences", async () => {
    findUniqueMock.mockResolvedValue({
      id: "user-1",
      firstName: "Ana",
      lastName: "User",
      title: "Dr",
      role: "MEMBER",
      institutionId: null,
      institution: null,
      preferences: { intraopFavouriteDrugs: ["Propofol"] },
    })

    const { GET } = await import("@/app/v1/user/route")
    const response = await GET(new Request("http://localhost/api/user") as Parameters<typeof GET>[0])

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      preferences: { intraopFavouriteDrugs: ["Propofol"] },
    })
  })

  it("merges and de-duplicates favourite arrays on PATCH", async () => {
    findUniqueMock.mockResolvedValue({
      preferences: { theme: "dark", intraopFavouriteInfusions: ["Propofol"] },
    })
    updateMock.mockResolvedValue({
      institution: null,
      preferences: {
        theme: "dark",
        intraopFavouriteDrugs: ["Propofol", "Fentanyl"],
        intraopFavouriteInfusions: ["Propofol"],
      },
    })

    const { PATCH } = await import("@/app/v1/user/route")
    const response = await PATCH(new Request("http://localhost/api/user", {
      method: "PATCH",
      body: JSON.stringify({
        preferences: {
          intraopFavouriteDrugs: ["Propofol", "Fentanyl", "Propofol"],
        },
      }),
    }) as Parameters<typeof PATCH>[0])

    expect(response.status).toBe(200)
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        preferences: expect.objectContaining({
          theme: "dark",
          intraopFavouriteInfusions: ["Propofol"],
          intraopFavouriteDrugs: ["Propofol", "Fentanyl"],
          clinicalPreferencesVersion: 1,
        }),
      },
    }))
  })

  it("rejects invalid preference payloads", async () => {
    const { PATCH } = await import("@/app/v1/user/route")
    const response = await PATCH(new Request("http://localhost/api/user", {
      method: "PATCH",
      body: JSON.stringify({
        preferences: { intraopFavouriteDrugs: "Propofol" },
      }),
    }) as Parameters<typeof PATCH>[0])

    expect(response.status).toBe(400)
    expect(updateMock).not.toHaveBeenCalled()
  })
})
