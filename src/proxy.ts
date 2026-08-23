import { NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/cors"
import { validateCookieWriteOrigin } from "@/lib/csrf"
import { getAuthUser } from "@/lib/mobile-auth"

const CORS_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS"

const CSRF_EXEMPT = [
  "/v1/auth/token",
  "/v1/auth/register",
  "/v1/auth/password-reset/request",
  "/v1/auth/password-reset/confirm",
  "/v1/auth/verify-email/resend",
]

function applyApiHeaders(
  response: NextResponse,
  req: NextRequest,
  requestId: string,
): NextResponse {
  for (const [name, value] of Object.entries(corsHeaders(req, CORS_METHODS))) {
    response.headers.set(name, value)
  }
  response.headers.set("X-LOSPOR-API-Version", "1")
  response.headers.set("X-Request-Id", requestId)
  return response
}

const RESEARCH_ONLY_ALLOWED = [
  "/v1/auth/",
  "/v1/legal/",
  "/v1/research/",
]

export function isResearchOnlyAllowedPath(pathname: string): boolean {
  if ([
    "/v1/user",
    "/v1/user/delete",
    "/v1/user/change-password",
    "/v1/user/sessions",
    "/v1/user/legal-acceptances",
    "/v1/user/accept-terms",
    "/v1/user/institution-request",
    "/v1/locale",
    "/v1/capabilities",
    "/v1/institutions",
  ].includes(pathname)) return true
  if (pathname.startsWith("/v1/user/sessions/")) return true
  return RESEARCH_ONLY_ALLOWED.some(prefix => pathname.startsWith(prefix))
}

export default async function proxy(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID()
  const requestHeaders = new Headers(req.headers)
  requestHeaders.set("x-request-id", requestId)

  if (req.method === "OPTIONS" && req.nextUrl.pathname.startsWith("/v1/")) {
    return applyApiHeaders(
      new NextResponse(null, { status: 204 }),
      req,
      requestId,
    )
  }

  if (!isResearchOnlyAllowedPath(req.nextUrl.pathname)) {
    const account = await getAuthUser(req)
    if (account?.accountKind === "RESEARCH_ONLY") {
      return applyApiHeaders(
        NextResponse.json({
          error: "Clinical application access is not available for this account",
          code: "CLINICAL_APP_FORBIDDEN",
          requestId,
        }, { status: 403 }),
        req,
        requestId,
      )
    }
  }

  if (
    req.nextUrl.pathname.startsWith("/v1/") &&
    !CSRF_EXEMPT.includes(req.nextUrl.pathname)
  ) {
    // /auth/session establishes or clears an HttpOnly browser cookie and its
    // handler ignores Authorization during login. A caller must not be able to
    // add a bogus Bearer header to bypass Origin checks and force session
    // swapping or logout. Native clients use /auth/token and /auth/logout.
    const result = validateCookieWriteOrigin(req, {
      allowBearerBypass: req.nextUrl.pathname !== "/v1/auth/session",
    })
    if (result === "fail") {
      return applyApiHeaders(
        NextResponse.json({ error: "Forbidden", requestId }, { status: 403 }),
        req,
        requestId,
      )
    }
  }

  return applyApiHeaders(
    NextResponse.next({ request: { headers: requestHeaders } }),
    req,
    requestId,
  )
}

export const config = {
  matcher: ["/v1/:path*"],
}
