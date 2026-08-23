import { afterEach, describe, expect, it } from "vitest"
import {
  accountAdministrationCapability,
  accountAdministrationRefusal,
  authenticationCapabilities,
  authenticationDeploymentMode,
  clinicalAiCapabilities,
  clinicalAiRefusal,
  deploymentSupport,
} from "./deployment-capabilities"

const original = {
  key: process.env.MISTRAL_API_KEY,
  disabled: process.env.LOSPOR_DISABLE_EXTERNAL_AI,
  appliance: process.env.HOSPITAL_APPLIANCE,
  deploymentMode: process.env.LOSPOR_DEPLOYMENT_MODE,
  accountAdministration: process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED,
  supportUrl: process.env.LOSPOR_SUPPORT_URL,
}

afterEach(() => {
  if (original.key === undefined) delete process.env.MISTRAL_API_KEY
  else process.env.MISTRAL_API_KEY = original.key
  if (original.disabled === undefined) delete process.env.LOSPOR_DISABLE_EXTERNAL_AI
  else process.env.LOSPOR_DISABLE_EXTERNAL_AI = original.disabled
  if (original.appliance === undefined) delete process.env.HOSPITAL_APPLIANCE
  else process.env.HOSPITAL_APPLIANCE = original.appliance
  if (original.deploymentMode === undefined) delete process.env.LOSPOR_DEPLOYMENT_MODE
  else process.env.LOSPOR_DEPLOYMENT_MODE = original.deploymentMode
  if (original.accountAdministration === undefined) delete process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED
  else process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED = original.accountAdministration
  if (original.supportUrl === undefined) delete process.env.LOSPOR_SUPPORT_URL
  else process.env.LOSPOR_SUPPORT_URL = original.supportUrl
})

describe("deployment support configuration", () => {
  it.each([
    ["https://help.hospital.example/tickets", "https://help.hospital.example/tickets"],
    ["mailto:support@hospital.example?subject=ignored", "mailto:support@hospital.example"],
  ])("publishes a safe operator-controlled destination", (configured, expected) => {
    process.env.LOSPOR_SUPPORT_URL = configured
    expect(deploymentSupport()).toEqual({ configured: true, contactUrl: expected })
  })

  it.each([
    "http://help.hospital.example",
    "https://username:password@help.hospital.example",
    "javascript:alert(1)",
    "mailto:not-an-address",
    "mailto:support@hospital.example#hidden",
    "mailto:support@hospital.example%23hidden",
    "mailto:.support@hospital.example",
    "mailto:support@-hospital.example",
    "not a URL",
  ])("fails closed for unsafe support destination %s", configured => {
    process.env.LOSPOR_SUPPORT_URL = configured
    expect(deploymentSupport()).toEqual({ configured: false, contactUrl: null })
  })
})

describe("administrator account deployment capability", () => {
  it("is disabled for the public demo even if the feature switch is copied", () => {
    delete process.env.LOSPOR_DEPLOYMENT_MODE
    process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED = "true"
    expect(accountAdministrationCapability()).toEqual({
      enabled: false,
      reason: "DISABLED_BY_DEPLOYMENT",
    })
    expect(accountAdministrationRefusal()).toMatchObject({
      status: 404,
      body: { code: "ACCOUNT_ADMINISTRATION_DISABLED_BY_DEPLOYMENT" },
    })
    expect(authenticationDeploymentMode()).toBe("PUBLIC")
    expect(authenticationCapabilities()).toMatchObject({
      loginIdentifier: "EMAIL",
      selfRegistration: true,
      passwordRecovery: "EMAIL",
    })
  })

  it("requires both explicit Hospital switches", () => {
    process.env.LOSPOR_DEPLOYMENT_MODE = "hospital"
    process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED = "true"
    expect(accountAdministrationCapability()).toEqual({ enabled: true, reason: "ENABLED" })
    expect(accountAdministrationRefusal()).toBeNull()
    expect(authenticationDeploymentMode()).toBe("HOSPITAL")
    expect(authenticationCapabilities()).toEqual({
      loginIdentifier: "USERNAME",
      selfRegistration: false,
      passwordRecovery: "ADMINISTRATOR",
      passwordChange: true,
      sessionInventory: true,
    })
  })

  it("fails authentication closed for a partially configured Hospital", () => {
    process.env.LOSPOR_DEPLOYMENT_MODE = "hospital"
    delete process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED
    expect(authenticationDeploymentMode()).toBe("UNAVAILABLE")
    expect(authenticationCapabilities()).toMatchObject({
      loginIdentifier: "USERNAME",
      selfRegistration: false,
      passwordRecovery: "UNAVAILABLE",
    })
  })
})

describe("clinical AI deployment capabilities", () => {
  it("reports all three controls enabled only when a provider is configured", () => {
    process.env.MISTRAL_API_KEY = "configured"
    delete process.env.LOSPOR_DISABLE_EXTERNAL_AI
    delete process.env.HOSPITAL_APPLIANCE
    expect(clinicalAiCapabilities()).toEqual({
      clinicalAdvice: { enabled: true, reason: "ENABLED" },
      labImageExtraction: { enabled: true, reason: "ENABLED" },
      monitorOcr: { enabled: true, reason: "ENABLED" },
    })
  })

  it("fails closed when the provider is absent", () => {
    delete process.env.MISTRAL_API_KEY
    expect(clinicalAiRefusal("labImageExtraction")).toMatchObject({
      status: 503,
      body: { code: "AI_PROVIDER_NOT_CONFIGURED" },
    })
  })

  it.each([
    ["LOSPOR_DISABLE_EXTERNAL_AI", "true"],
    ["HOSPITAL_APPLIANCE", "true"],
  ] as const)("deployment switch %s overrides an accidentally configured key", (name, value) => {
    process.env.MISTRAL_API_KEY = "configured"
    process.env[name] = value
    expect(clinicalAiRefusal("monitorOcr")).toMatchObject({
      status: 503,
      body: { code: "AI_DISABLED_BY_DEPLOYMENT" },
    })
  })
})
