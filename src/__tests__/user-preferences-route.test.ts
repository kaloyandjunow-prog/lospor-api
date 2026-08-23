import { beforeEach, describe, expect, it, vi } from "vitest"

const getAuthUserMock = vi.fn()
const findUniqueMock = vi.fn()
const updateMock = vi.fn()
const auditCreateMock = vi.fn()
const invalidateAccountStateMock = vi.fn()

vi.mock("@/lib/mobile-auth", () => ({
  getAuthUser: getAuthUserMock,
}))

vi.mock("@/lib/password-epoch", () => ({
  invalidateAccountState: invalidateAccountStateMock,
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: findUniqueMock,
      update: updateMock,
    },
    $transaction: (run: (transaction: unknown) => unknown) => run({
      user: { update: updateMock },
      auditLog: { create: auditCreateMock },
    }),
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
      firstName: "Ana",
      lastName: "User",
      title: "Dr",
      preferences: { theme: "dark", intraopFavouriteInfusions: ["Propofol"] },
    })
    updateMock.mockResolvedValue({
      name: "Dr Ana User",
      firstName: "Ana",
      lastName: "User",
      title: "Dr",
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

  it("persists ui.locale as the authority without losing other preference keys", async () => {
    findUniqueMock.mockResolvedValue({
      firstName: "Ana",
      lastName: "User",
      title: "Dr",
      preferences: { theme: "dark", ui: { locale: "bg", density: "compact" } },
    })
    updateMock.mockResolvedValue({
      name: "Dr Ana User",
      firstName: "Ana",
      lastName: "User",
      title: "Dr",
      institution: null,
      preferences: { theme: "dark", ui: { locale: "en", density: "compact" } },
    })

    const { PATCH } = await import("@/app/v1/user/route")
    const response = await PATCH(new Request("http://localhost/api/user", {
      method: "PATCH",
      body: JSON.stringify({ preferences: { ui: { locale: "en" } } }),
    }) as Parameters<typeof PATCH>[0])

    expect(response.status).toBe(200)
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        preferences: expect.objectContaining({
          theme: "dark",
          ui: { locale: "en", density: "compact" },
        }),
      },
    }))
    await expect(response.json()).resolves.toMatchObject({ preferredLocale: "en" })
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

  it("supports self-service name/title correction and rebuilds the display name", async () => {
    findUniqueMock.mockResolvedValue({
      firstName: "Ana",
      lastName: "User",
      title: "Dr",
      preferences: { ui: { locale: "bg" } },
    })
    updateMock.mockResolvedValue({
      name: "Prof Ana Petrova",
      firstName: "Ana",
      lastName: "Petrova",
      title: "Prof",
      institution: null,
      preferences: { ui: { locale: "bg" } },
    })

    const { PATCH } = await import("@/app/v1/user/route")
    const response = await PATCH(new Request("http://localhost/api/user", {
      method: "PATCH",
      body: JSON.stringify({ lastName: "  Petrova ", title: " Prof " }),
    }) as Parameters<typeof PATCH>[0])

    expect(response.status).toBe(200)
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: "Prof Ana Petrova",
        firstName: "Ana",
        lastName: "Petrova",
        title: "Prof",
      }),
    }))
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "PROFILE_CORRECTION",
        detail: { changedFields: ["lastName", "title"] },
      }),
    })
  })

  // HAUD_ROLLBACK:profile-identity-correction
  it("does not publish a profile correction when its audit row fails", async () => {
    findUniqueMock.mockResolvedValue({
      firstName: "Ana",
      lastName: "User",
      title: "Dr",
      preferences: { ui: { locale: "bg" } },
    })
    updateMock.mockResolvedValue({
      name: "Dr Ana Petrova",
      firstName: "Ana",
      lastName: "Petrova",
      title: "Dr",
      institution: null,
      preferences: { ui: { locale: "bg" } },
    })
    auditCreateMock.mockRejectedValueOnce(new Error("audit unavailable"))

    const { PATCH } = await import("@/app/v1/user/route")
    const response = await PATCH(new Request("http://localhost/api/user", {
      method: "PATCH",
      body: JSON.stringify({ lastName: "Petrova" }),
    }) as Parameters<typeof PATCH>[0])

    expect(response.status).toBe(500)
    expect(invalidateAccountStateMock).not.toHaveBeenCalled()
  })
})
