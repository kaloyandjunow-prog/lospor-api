import { describe, expect, it } from "vitest"
import packageMetadata from "../../package.json"
import { GET as getHealth } from "@/app/health/live/route"
import { GET as getCapabilities } from "@/app/v1/capabilities/route"
import { API_RELEASE_VERSION } from "@/lib/api-version"

describe("API release metadata", () => {
  it("uses package.json as the canonical release version", () => {
    expect(API_RELEASE_VERSION).toBe(packageMetadata.version)
  })

  it("reports the canonical version from health and capabilities", async () => {
    await expect(getHealth().json()).resolves.toMatchObject({
      service: "lospor-api",
      version: API_RELEASE_VERSION,
    })
    await expect(getCapabilities().json()).resolves.toMatchObject({
      apiVersion: "1",
      serviceVersion: API_RELEASE_VERSION,
      authentication: {
        loginIdentifier: expect.stringMatching(/^(EMAIL|USERNAME)$/),
        selfRegistration: expect.any(Boolean),
        passwordRecovery: expect.stringMatching(/^(EMAIL|ADMINISTRATOR|UNAVAILABLE)$/),
        passwordChange: true,
        sessionInventory: true,
      },
      features: {
        accountAdministration: {
          enabled: expect.any(Boolean),
          reason: expect.stringMatching(/^(ENABLED|DISABLED_BY_DEPLOYMENT)$/),
        },
      },
    })
  })
})
