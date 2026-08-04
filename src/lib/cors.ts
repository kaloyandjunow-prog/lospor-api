import { CORS_REQUEST_HEADERS_VALUE } from "@lospor/core/sync"

const API_REQUEST_HEADERS = `${CORS_REQUEST_HEADERS_VALUE}, X-Lospor-Client, X-Lospor-Client-Version`

function allowlist(): string[] {
  const list = process.env.CORS_ALLOW_ORIGINS?.split(",").map(origin => origin.trim()).filter(Boolean) ?? []
  const single = process.env.CORS_ALLOW_ORIGIN?.trim()
  if (single && !list.includes(single)) list.push(single)
  return list
}

/**
 * Whether this process is serving real traffic.
 *
 * Enforcement used to require `NODE_ENV=production` *and*
 * `VERCEL_ENV=production`. A hospital-hosted appliance sets the first and not
 * the second, so it matched neither branch and fell through to `Access-Control-
 * Allow-Origin: *` — every website on the internet permitted to call the
 * clinical API. Self-hosting is the intended deployment model, so the guard has
 * to hold there above all.
 *
 * Vercel preview builds also run with `NODE_ENV=production`, so keying on that
 * alone would break every preview deployment. Previews and Vercel's own dev
 * environment are excluded explicitly instead.
 */
export function isProductionDeployment(): boolean {
  if (process.env.NODE_ENV !== "production") return false
  const vercelEnv = process.env.VERCEL_ENV
  return vercelEnv !== "preview" && vercelEnv !== "development"
}

// Returns the Access-Control-Allow-Origin value for a request. When the
// request's Origin is on the allowlist it is reflected back (this is what
// makes a multi-origin CORS_ALLOW_ORIGINS actually work — the browser
// requires an exact match, so a static first-entry header would break every
// origin except the first).
//
// An unrecognised origin now yields no header at all. Returning the first
// configured entry was harmless in practice — the browser compares it to the
// actual origin and refuses — but it made the response look like an
// authorisation that had not been granted.
export function allowedCorsOrigin(requestOrigin?: string | null): string | null {
  const list = allowlist()
  if (requestOrigin && list.includes(requestOrigin)) return requestOrigin
  if (list.length > 0) return requestOrigin ? null : list[0]
  if (isProductionDeployment()) {
    throw new Error(
      "CORS_ALLOW_ORIGIN or CORS_ALLOW_ORIGINS must be set in production. "
      + "Refusing to fall back to '*' for a clinical API.",
    )
  }
  return "*"
}

// Pass the incoming request (or null for a static fallback) so the allowed
// origin can be reflected per request. `Vary: Origin` tells caches the
// response differs by requesting origin.
export function corsHeaders(req?: { headers: { get(name: string): string | null } } | null, methods = "GET, POST, PATCH, PUT, DELETE, OPTIONS", headers = API_REQUEST_HEADERS) {
  const allowOrigin = allowedCorsOrigin(req?.headers.get("origin"))
  return {
    // Omitted entirely for an unrecognised origin. Emitting the header with a
    // value the browser will reject anyway states an allowance that was never
    // made; absence is the honest answer.
    ...(allowOrigin === null ? {} : { "Access-Control-Allow-Origin": allowOrigin }),
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": headers,
    "Access-Control-Expose-Headers": "X-Request-Id, X-LOSPOR-API-Version, ETag, X-Case-Updated-At, X-Case-Revision, X-Section-Revision",
    "Access-Control-Max-Age":       "86400",
    "Vary":                         "Origin",
  }
}
