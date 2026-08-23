export type CapabilityReason =
  | "ENABLED"
  | "DISABLED_BY_DEPLOYMENT"
  | "PROVIDER_NOT_CONFIGURED"

export type RuntimeCapability = {
  enabled: boolean
  reason: CapabilityReason
}

export type ClinicalAiCapabilities = {
  clinicalAdvice: RuntimeCapability
  labImageExtraction: RuntimeCapability
  monitorOcr: RuntimeCapability
}

export type DeploymentSupport = {
  configured: boolean
  contactUrl: string | null
}

export type LoginIdentifier = "EMAIL" | "USERNAME"
export type PasswordRecovery = "EMAIL" | "ADMINISTRATOR" | "UNAVAILABLE"
export type AuthenticationDeploymentMode = "PUBLIC" | "HOSPITAL" | "UNAVAILABLE"

export type AuthenticationCapabilities = {
  loginIdentifier: LoginIdentifier
  selfRegistration: boolean
  passwordRecovery: PasswordRecovery
  passwordChange: true
  sessionInventory: true
}

const SUPPORT_URL_MAX_LENGTH = 2_048
const SUPPORT_MAILBOX = /^[A-Za-z0-9.!#%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

function safeSupportMailbox(address: string): boolean {
  const local = address.slice(0, address.lastIndexOf("@"))
  return address.length <= 320
    && SUPPORT_MAILBOX.test(address)
    && !local.startsWith(".")
    && !local.endsWith(".")
    && !local.includes("..")
}

/**
 * A deployment may advertise one operator-controlled support destination.
 *
 * It is deliberately limited to HTTPS ticket/help systems and a bare mailto
 * address. Query strings on mailto values are discarded so a deployment
 * cannot silently pre-populate content that bypasses the client's diagnostic
 * preview. Invalid configuration fails closed and never reaches clients.
 */
export function deploymentSupport(): DeploymentSupport {
  const configured = process.env.LOSPOR_SUPPORT_URL?.trim()
  if (!configured || configured.length > SUPPORT_URL_MAX_LENGTH || /[\s\\$]/.test(configured)) {
    return { configured: false, contactUrl: null }
  }
  try {
    const parsed = new URL(configured)
    if (parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash) {
      return { configured: true, contactUrl: parsed.toString() }
    }
    if (parsed.protocol === "mailto:" && !parsed.hash) {
      const address = decodeURIComponent(parsed.pathname).trim()
      if (safeSupportMailbox(address)) {
        return { configured: true, contactUrl: `mailto:${address}` }
      }
    }
  } catch {
    // Invalid operator configuration is indistinguishable from no contact to
    // the client. Host readiness owns the actionable configuration warning.
  }
  return { configured: false, contactUrl: null }
}

/**
 * The public serverless demo deliberately does not expose the Hospital account
 * control plane. Both switches are required so an accidentally copied single
 * environment value cannot enable the new administrator lifecycle routes on
 * the online service. This uses the deployment-mode marker rather than the
 * legacy HOSPITAL_APPLIANCE switch, because that older switch deliberately
 * disables the public build's external-AI implementation.
 */
export function accountAdministrationCapability(): RuntimeCapability {
  const enabled = process.env.LOSPOR_DEPLOYMENT_MODE === "hospital"
    && process.env.LOSPOR_ACCOUNT_ADMINISTRATION_ENABLED === "true"
  return enabled
    ? { enabled: true, reason: "ENABLED" }
    : { enabled: false, reason: "DISABLED_BY_DEPLOYMENT" }
}

export function accountAdministrationRefusal(): {
  status: 404
  body: { error: string; code: string; capability: RuntimeCapability }
} | null {
  const capability = accountAdministrationCapability()
  if (capability.enabled) return null
  return {
    status: 404,
    body: {
      error: "Administrator account lifecycle is disabled for this deployment",
      code: "ACCOUNT_ADMINISTRATION_DISABLED_BY_DEPLOYMENT",
      capability,
    },
  }
}

/**
 * Authentication identity is a deployment boundary, not a runtime preference.
 *
 * An unset/public marker preserves the serverless email flow. A Hospital marker
 * is trusted only together with the existing account-administration capability;
 * partial or unknown configuration fails closed instead of falling back to the
 * public email identity.
 */
export function authenticationDeploymentMode(): AuthenticationDeploymentMode {
  const configured = process.env.LOSPOR_DEPLOYMENT_MODE?.trim().toLowerCase()
  if (!configured || configured === "public" || configured === "serverless") return "PUBLIC"
  if (configured === "hospital" && accountAdministrationCapability().enabled) return "HOSPITAL"
  return "UNAVAILABLE"
}

export function authenticationCapabilities(): AuthenticationCapabilities {
  const mode = authenticationDeploymentMode()
  if (mode === "PUBLIC") {
    return {
      loginIdentifier: "EMAIL",
      selfRegistration: process.env.LOSPOR_SELF_REGISTRATION_ENABLED !== "false",
      passwordRecovery: "EMAIL",
      passwordChange: true,
      sessionInventory: true,
    }
  }
  if (mode === "HOSPITAL") {
    return {
      loginIdentifier: "USERNAME",
      selfRegistration: false,
      passwordRecovery: "ADMINISTRATOR",
      passwordChange: true,
      sessionInventory: true,
    }
  }
  return {
    loginIdentifier: process.env.LOSPOR_DEPLOYMENT_MODE?.trim().toLowerCase() === "hospital"
      ? "USERNAME"
      : "EMAIL",
    selfRegistration: false,
    passwordRecovery: "UNAVAILABLE",
    passwordChange: true,
    sessionInventory: true,
  }
}

export function publicEmailAuthenticationRefusal(): {
  status: 404 | 503
  body: { error: string; code: string }
} | null {
  const mode = authenticationDeploymentMode()
  if (mode === "PUBLIC") return null
  if (mode === "HOSPITAL") {
    return {
      status: 404,
      body: {
        error: "Email account workflow is disabled for this deployment",
        code: "EMAIL_AUTH_DISABLED_BY_DEPLOYMENT",
      },
    }
  }
  return {
    status: 503,
    body: {
      error: "Authentication is unavailable for this deployment",
      code: "AUTHENTICATION_DEPLOYMENT_UNAVAILABLE",
    },
  }
}

function externalAiDisabled(): boolean {
  return process.env.LOSPOR_DISABLE_EXTERNAL_AI === "true"
    || process.env.HOSPITAL_APPLIANCE === "true"
}

function externalAiCapability(): RuntimeCapability {
  if (externalAiDisabled()) {
    return { enabled: false, reason: "DISABLED_BY_DEPLOYMENT" }
  }
  if (!process.env.MISTRAL_API_KEY?.trim()) {
    return { enabled: false, reason: "PROVIDER_NOT_CONFIGURED" }
  }
  return { enabled: true, reason: "ENABLED" }
}

export function clinicalAiCapabilities(): ClinicalAiCapabilities {
  const capability = externalAiCapability()
  return {
    clinicalAdvice: { ...capability },
    labImageExtraction: { ...capability },
    monitorOcr: { ...capability },
  }
}

export function clinicalAiRefusal(feature: keyof ClinicalAiCapabilities): {
  status: 503
  body: { error: string; code: string; capability: RuntimeCapability }
} | null {
  const capability = clinicalAiCapabilities()[feature]
  if (capability.enabled) return null
  return {
    status: 503,
    body: {
      error: capability.reason === "DISABLED_BY_DEPLOYMENT"
        ? "External AI is disabled for this deployment"
        : "External AI provider is not configured",
      code: capability.reason === "DISABLED_BY_DEPLOYMENT"
        ? "AI_DISABLED_BY_DEPLOYMENT"
        : "AI_PROVIDER_NOT_CONFIGURED",
      capability,
    },
  }
}
