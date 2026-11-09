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

  it("rejects a stale account-preferences revision before writing", async () => {
    findUniqueMock.mockResolvedValue({
      firstName: "Ana",
      lastName: "User",
      title: "Dr",
      preferences: { theme: "dark" },
      preferencesRevision: 4,
    })

    const { PATCH } = await import("@/app/v1/user/route")
    const response = await PATCH(new Request("http://localhost/api/user", {
      method: "PATCH",
      body: JSON.stringify({
        preferences: { theme: "light" },
        preferencesRevision: 3,
      }),
    }) as Parameters<typeof PATCH>[0])

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      code: "PREFERENCES_CONFLICT",
      preferences: { theme: "dark" },
      preferencesRevision: 4,
    })
    expect(updateMock).not.toHaveBeenCalled()
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
      data: expect.objectContaining({
        preferences: expect.objectContaining({
          theme: "dark",
          intraopFavouriteInfusions: ["Propofol"],
          intraopFavouriteDrugs: ["Propofol", "Fentanyl"],
          clinicalPreferencesVersion: 1,
        }),
      }),
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
      data: expect.objectContaining({
        preferences: expect.objectContaining({
          theme: "dark",
          ui: { locale: "en", density: "compact" },
        }),
      }),
    }))
    await expect(response.json()).resolves.toMatchObject({ preferredLocale: "en" })
  })

  // The PWA pushes its whole preferences object, and core's ClinicalUnits has
  // carried a fifth unit -- cvp -- since central venous pressure gained its own
  // entry unit. unitsPatchSchema is strict and listed only four, so every
  // preference sync from a client that knows about cvp was rejected outright:
  // a 400 on each launch, the dirty flag never clearing, and nothing a
  // clinician set ever reaching the server.
  it("accepts the cvp entry unit that core's preferences carry", async () => {
    findUniqueMock.mockResolvedValue({
      firstName: "Ana",
      lastName: "User",
      title: "Dr",
      preferences: { units: { height: "cm", cvp: "cmH2O" } },
    })
    updateMock.mockResolvedValue({
      name: "Dr Ana User",
      firstName: "Ana",
      lastName: "User",
      title: "Dr",
      institution: null,
      preferences: { units: { height: "cm", cvp: "mmHg" } },
    })

    const { PATCH } = await import("@/app/v1/user/route")
    const response = await PATCH(new Request("http://localhost/api/user", {
      method: "PATCH",
      body: JSON.stringify({ preferences: { units: { cvp: "mmHg" } } }),
    }) as Parameters<typeof PATCH>[0])

    expect(response.status).toBe(200)
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        preferences: expect.objectContaining({
          units: expect.objectContaining({ cvp: "mmHg" }),
        }),
      }),
    }))
  })

  // Still strict: an unknown unit is a typo, or a client sending a field this
  // release does not understand, and storing it silently would make the next
  // reader believe the appliance honours it.
  it("still refuses a unit it does not know", async () => {
    const { PATCH } = await import("@/app/v1/user/route")
    const response = await PATCH(new Request("http://localhost/api/user", {
      method: "PATCH",
      body: JSON.stringify({ preferences: { units: { nonsense: "mmHg" } } }),
    }) as Parameters<typeof PATCH>[0])

    expect(response.status).toBe(400)
  })

  it("stores each Bulgarian-name switch and refuses one it does not know", async () => {
    findUniqueMock.mockResolvedValue({ firstName: "Ana", lastName: "User", title: "Dr", preferences: {} })
    updateMock.mockResolvedValue({ name: "Dr Ana User", firstName: "Ana", lastName: "User", title: "Dr", institution: null, preferences: {} })
    const { PATCH } = await import("@/app/v1/user/route")
    const patch = (bulgarianNames: unknown) => PATCH(new Request("http://localhost/api/user", {
      method: "PATCH",
      body: JSON.stringify({ preferences: { bulgarianNames } }),
    }) as Parameters<typeof PATCH>[0])

    expect((await patch({ drugs: true, fluids: true })).status).toBe(200)
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        preferences: expect.objectContaining({
          bulgarianNames: { premed: false, drugs: true, infusions: false, agents: false, fluids: true },
        }),
      }),
    }))
    expect((await patch({ labs: true })).status).toBe(400)
  })

  it("stores the suggestion groups a clinician turned off and the energy knob look (10.2.0)", async () => {
    findUniqueMock.mockResolvedValue({ firstName: "Ana", lastName: "User", title: "Dr", preferences: {} })
    updateMock.mockResolvedValue({ name: "Dr Ana User", firstName: "Ana", lastName: "User", title: "Dr", institution: null, preferences: {} })
    const { PATCH } = await import("@/app/v1/user/route")
    const patch = (preferences: unknown) => PATCH(new Request("http://localhost/api/user", {
      method: "PATCH",
      body: JSON.stringify({ preferences }),
    }) as Parameters<typeof PATCH>[0])

    expect((await patch({ automationGroups: { timers: false, reminders: true }, energyKnobSkin: "B" })).status).toBe(200)
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ preferences: expect.objectContaining({ automationGroups: { timers: false }, energyKnobSkin: "B" }) }),
    }))
    expect((await patch({ energyKnobSkin: "Z" })).status).toBe(400)
    expect((await patch({ airwayScreen: "legacy" })).status).toBe(200)
    expect(updateMock).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ preferences: expect.objectContaining({ airwayScreen: "legacy" }) }) }))
    expect((await patch({ airwayScreen: "fancy" })).status).toBe(400)
    expect((await patch({ vascularScreen: "legacy" })).status).toBe(200)
    expect(updateMock).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ preferences: expect.objectContaining({ vascularScreen: "legacy" }) }) }))
    expect((await patch({ vascularScreen: "fancy" })).status).toBe(400)
    expect((await patch({ monitoringScreen: "legacy" })).status).toBe(200)
    expect(updateMock).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ preferences: expect.objectContaining({ monitoringScreen: "legacy" }) }) }))
    expect((await patch({ monitoringScreen: "fancy" })).status).toBe(400)
    expect((await patch({ equipmentScreen: "legacy" })).status).toBe(200)
    expect(updateMock).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ preferences: expect.objectContaining({ equipmentScreen: "legacy" }) }) }))
    expect((await patch({ equipmentScreen: "fancy" })).status).toBe(400)
    expect((await patch({ techniqueScreen: "legacy" })).status).toBe(200)
    expect(updateMock).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ preferences: expect.objectContaining({ techniqueScreen: "legacy" }) }) }))
    expect((await patch({ techniqueScreen: "fancy" })).status).toBe(400)
    expect((await patch({ eventsScreen: "legacy" })).status).toBe(200)
    expect(updateMock).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ preferences: expect.objectContaining({ eventsScreen: "legacy" }) }) }))
    expect((await patch({ eventsScreen: "fancy" })).status).toBe(400)
    expect((await patch({ fluidsScreen: "legacy" })).status).toBe(200)
    expect(updateMock).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ preferences: expect.objectContaining({ fluidsScreen: "legacy" }) }) }))
    expect((await patch({ fluidsScreen: "fancy" })).status).toBe(400)
    expect((await patch({ eventLogScreen: "legacy" })).status).toBe(200)
    expect(updateMock).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ preferences: expect.objectContaining({ eventLogScreen: "legacy" }) }) }))
    expect((await patch({ eventLogScreen: "fancy" })).status).toBe(400)
    expect((await patch({ automationGroups: { timers: "off" } })).status).toBe(400)
  })

  it("stores per-suggestion account switches, including vital and opt-in context lines", async () => {
    findUniqueMock.mockResolvedValue({ firstName: "Ana", lastName: "User", title: "Dr", preferences: {} })
    updateMock.mockResolvedValue({ name: "Dr Ana User", firstName: "Ana", lastName: "User", title: "Dr", institution: null, preferences: {} })
    const { PATCH } = await import("@/app/v1/user/route")
    const response = await PATCH(new Request("http://localhost/api/user", {
      method: "PATCH",
      body: JSON.stringify({ preferences: { automationLines: { "vital:hypotension": false, "context:induction-agent-context": true, "reminder:ponv": false } } }),
    }) as Parameters<typeof PATCH>[0])

    expect(response.status).toBe(200)
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ preferences: expect.objectContaining({ automationLines: { "vital:hypotension": false, "context:induction-agent-context": true, "reminder:ponv": false } }) }),
    }))
  })

  it("stores shared case and timetable layout preferences without dropping siblings", async () => {
    findUniqueMock.mockResolvedValue({
      firstName: "Ana",
      lastName: "User",
      title: "Dr",
      preferences: { theme: "dark", caseLayout: { sidebar: false, preop: "tabs" } },
    })
    updateMock.mockResolvedValue({ name: "Dr Ana User", firstName: "Ana", lastName: "User", title: "Dr", institution: null, preferences: {} })
    const { PATCH } = await import("@/app/v1/user/route")
    const response = await PATCH(new Request("http://localhost/api/user", {
      method: "PATCH",
      body: JSON.stringify({ preferences: {
        caseLayout: { intraop: "tabs" },
        timetableLayout: "scroll",
        vitalsChartExpanded: false,
      } }),
    }) as Parameters<typeof PATCH>[0])

    expect(response.status).toBe(200)
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ preferences: expect.objectContaining({
        theme: "dark",
        caseLayout: { sidebar: false, preop: "tabs", intraop: "tabs", postop: "scroll" },
        timetableLayout: "scroll",
        vitalsChartExpanded: false,
      }) }),
    }))
    const invalid = await PATCH(new Request("http://localhost/api/user", {
      method: "PATCH",
      body: JSON.stringify({ preferences: { caseLayout: { preop: "sidebar" } } }),
    }) as Parameters<typeof PATCH>[0])
    expect(invalid.status).toBe(400)
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
