import "server-only"
import { SignJWT, jwtVerify } from "jose"
import { isRevokedAsync } from "@/lib/token-blocklist"
import { resolveAccount } from "@/lib/password-epoch"
import { validateTrackedSession } from "@/lib/auth-sessions"
import type { AuthSessionClient } from "@/lib/auth-sessions"
import type { AccountKind, PreferredLocale } from "@lospor/core/account"

export const AUTH_COOKIE_NAME = "lospor_session"
export const AUTH_TOKEN_TTL_SECONDS = 8 * 60 * 60

export type AuthUser = {
  id: string
  role: string
  accountKind: AccountKind
  preferredLocale: PreferredLocale
  institutionId: string | null
  institutionName: string | null
  firstName: string | null
  lastName: string | null
  title: string | null
  jti: string | null
  clientType: AuthSessionClient
}

function secret() {
  const value = process.env.LOSPOR_AUTH_SECRET ?? process.env.NEXTAUTH_SECRET
  if (!value) throw new Error("LOSPOR_AUTH_SECRET or NEXTAUTH_SECRET is required")
  return new TextEncoder().encode(value)
}

export async function signMobileToken(claims: {
  id: string
  jti: string
  role: string
  accountKind: AccountKind
  preferredLocale: PreferredLocale
  institutionId: string | null
  institutionName: string | null
  firstName: string | null
  lastName: string | null
  title: string | null
  lastLoginAt: string | null
  clientType: AuthSessionClient
  mfaVerified?: boolean
}): Promise<string> {
  return new SignJWT({ ...claims, sessionTracked: true, mfaVerified: claims.mfaVerified === true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setJti(claims.jti)
    .setExpirationTime(`${AUTH_TOKEN_TTL_SECONDS}s`)
    .sign(secret())
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const [key, ...rawValue] = part.trim().split("=")
    if (key !== name) continue
    try {
      return decodeURIComponent(rawValue.join("="))
    } catch {
      return rawValue.join("=")
    }
  }
  return null
}

export function authTokenFromRequest(req: Request): string | null {
  const authHeader = req.headers.get("authorization")
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7)
  return cookieValue(req.headers.get("cookie"), AUTH_COOKIE_NAME)
}

// Native clients send a bearer token. Browser requests carry the same
// API-owned token in an HttpOnly cookie through the web compatibility proxy.
export async function getAuthUser(req: Request): Promise<AuthUser | null> {
  const token = authTokenFromRequest(req)
  if (!token) return null

  try {
    const { payload } = await jwtVerify(token, secret())
    const jti = payload.jti as string | undefined
    if (jti && await isRevokedAsync(jti)) return null
    if (!payload.id) return null
    if (payload.sessionTracked === true && (!jti || !await validateTrackedSession(jti, payload.id as string))) {
      return null
    }

    const account = await resolveAccount(payload.id as string, payload.iat)
    if (!account) return null
    if (
      process.env.LOSPOR_ADMIN_MFA_REQUIRED === "true"
      && account.role === "ADMIN"
      && payload.mfaVerified !== true
    ) return null
    const claimedClientType = payload.clientType
    // Tokens issued before 1.2.0 did not carry a client type. They have an
    // eight-hour maximum lifetime; retain their historical transport-based
    // classification while every new session is bound to an explicit claim.
    const clientType: AuthSessionClient = claimedClientType === "WEB"
      || claimedClientType === "PWA"
      || claimedClientType === "NATIVE"
      ? claimedClientType
      : req.headers.get("authorization")?.startsWith("Bearer ")
        ? "NATIVE"
        : "WEB"
    return {
      id: payload.id as string,
      role: account.role ?? (payload.role as string),
      accountKind: account.accountKind,
      preferredLocale: account.preferredLocale,
      institutionId: account.institutionId,
      institutionName:
        account.institutionName ??
        (account.institutionId ? (payload.institutionName as string) : null) ??
        null,
      firstName: account.firstName,
      lastName: account.lastName,
      title: account.title,
      jti: jti ?? null,
      clientType,
    }
  } catch {
    return null
  }
}
