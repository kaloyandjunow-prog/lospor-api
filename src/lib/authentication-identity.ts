import { createHash } from "node:crypto"
import { z } from "zod"
import { emailSchema } from "@/lib/auth-email-tokens"
import { authenticationDeploymentMode } from "@/lib/deployment-capabilities"
import { validateAndNormalizeUsername } from "@/lib/username-identity"

const common = {
  password: z.string().min(1),
  locale: z.enum(["bg", "en"]).optional(),
  deviceLabel: z.string().max(120).optional(),
}

const publicLoginSchema = z.object({
  email: emailSchema,
  ...common,
}).strict()

const hospitalLoginSchema = z.object({
  username: z.unknown().transform((value, context) => {
    const normalized = validateAndNormalizeUsername(value)
    if (!normalized.success) {
      context.addIssue({ code: "custom", message: "Invalid username" })
      return z.NEVER
    }
    return normalized.value
  }),
  ...common,
}).strict()

export type AuthenticationIdentifier =
  | { kind: "EMAIL"; canonical: string }
  | { kind: "USERNAME"; canonical: string }

export type ParsedAuthenticationRequest = {
  identifier: AuthenticationIdentifier
  password: string
  locale?: "bg" | "en"
  deviceLabel?: string
}

/** Parse exactly one deployment-approved identifier; extra fallback fields fail. */
export function parseAuthenticationRequest(input: unknown): ParsedAuthenticationRequest | null {
  const mode = authenticationDeploymentMode()
  if (mode === "PUBLIC") {
    const parsed = publicLoginSchema.safeParse(input)
    if (!parsed.success) return null
    return {
      identifier: { kind: "EMAIL", canonical: parsed.data.email },
      password: parsed.data.password,
      locale: parsed.data.locale,
      deviceLabel: parsed.data.deviceLabel,
    }
  }
  if (mode === "HOSPITAL") {
    const parsed = hospitalLoginSchema.safeParse(input)
    if (!parsed.success) return null
    return {
      identifier: { kind: "USERNAME", canonical: parsed.data.username.usernameCanonical },
      password: parsed.data.password,
      locale: parsed.data.locale,
      deviceLabel: parsed.data.deviceLabel,
    }
  }
  return null
}

/**
 * Account-target throttling never places an email or username in the limiter
 * store. Deployment and identifier kind are inside the digest domain so keys
 * cannot be correlated or accidentally shared across identity modes.
 */
export function authenticationRateLimitKey(identifier: AuthenticationIdentifier): string {
  const mode = authenticationDeploymentMode()
  const digest = createHash("sha256")
    .update("lospor-login-rate-limit-v1\0")
    .update(mode)
    .update("\0")
    .update(identifier.kind)
    .update("\0")
    .update(identifier.canonical)
    .digest("hex")
  return `login-identity:v1:${digest}`
}
