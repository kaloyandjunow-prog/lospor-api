import { isProductionDeployment } from "./cors"

const STATE_CHANGING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"])

type HeaderSource = { headers: { get(name: string): string | null }; method: string }

function originFrom(raw: string | null): string | null {
  if (!raw) return null
  try { return new URL(raw).origin } catch { return null }
}

export function trustedAppOrigins(): string[] {
  const values = [
    process.env.LOSPOR_WEB_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXTAUTH_URL,
    process.env.LOSPOR_DATABASE_URL,
    process.env.CORS_ALLOW_ORIGIN,
    ...(process.env.CORS_ALLOW_ORIGINS?.split(",") ?? []),
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined,
  ]
  const origins = values
    .map(value => originFrom(value?.trim() ?? null))
    .filter((value): value is string => value !== null)

  if (process.env.NODE_ENV !== "production") {
    origins.push("http://localhost:3003", "http://127.0.0.1:3003")
  }
  return [...new Set(origins)]
}

export function appOrigin(): string | null {
  return trustedAppOrigins()[0] ?? null
}


const DEVELOPMENT_CLIENT_PORTS = new Set(["3000", "3001", "3003"])

function isDevelopmentClientOrigin(origin: string): boolean {
  if (process.env.NODE_ENV === "production") return false
  try {
    const url = new URL(origin)
    if (url.protocol !== "http:" || !DEVELOPMENT_CLIENT_PORTS.has(url.port)) return false
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true
    if (/^10\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname)) return true
    if (/^192\.168\.(?:\d{1,3}\.)\d{1,3}$/.test(url.hostname)) return true
    const match = url.hostname.match(/^172\.(\d{1,3})\.(?:\d{1,3})\.\d{1,3}$/)
    return !!match && Number(match[1]) >= 16 && Number(match[1]) <= 31
  } catch {
    return false
  }
}

export function usesBearerAuth(req: HeaderSource): boolean {
  return (req.headers.get("authorization") ?? "").startsWith("Bearer ")
}

export function isStateChangingMethod(method: string): boolean {
  return STATE_CHANGING_METHODS.has(method.toUpperCase())
}

export function validateCookieWriteOrigin(
  req: HeaderSource,
  options: { allowBearerBypass?: boolean } = {},
): "pass" | "skip" | "fail" {
  if (!isStateChangingMethod(req.method)) return "pass"
  if (options.allowBearerBypass !== false && usesBearerAuth(req)) return "pass"

  const expected = trustedAppOrigins()
  if (!expected.length) {
    // No trusted origin configured. In production that is a misconfiguration,
    // not a licence to accept any cookie-authenticated write: skipping here
    // would leave every state-changing request open to cross-site forgery on a
    // self-hosted install that forgot the variable. Fail closed and let the
    // deployment be fixed.
    return isProductionDeployment() ? "fail" : "skip"
  }

  const isAllowed = (value: string | null) =>
    value !== null && (
      expected.includes(value) ||
      isDevelopmentClientOrigin(value)
    )

  const origin = originFrom(req.headers.get("origin"))
  if (origin) return isAllowed(origin) ? "pass" : "fail"

  const referer = originFrom(req.headers.get("referer"))
  return isAllowed(referer) ? "pass" : "fail"
}
