import { NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/cors"
import { validateCookieWriteOrigin } from "@/lib/csrf"

const CORS_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS"

const CSRF_EXEMPT = [
  "/v1/auth/token",
  "/v1/auth/session",
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

export default function proxy(req: NextRequest) {
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

  if (
    req.nextUrl.pathname.startsWith("/v1/") &&
    !CSRF_EXEMPT.includes(req.nextUrl.pathname)
  ) {
    const result = validateCookieWriteOrigin(req)
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
