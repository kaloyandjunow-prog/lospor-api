import { NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/cors"
import {
  AUTH_COOKIE_NAME,
  AUTH_TOKEN_TTL_SECONDS,
  authTokenFromRequest,
  getAuthUser,
} from "@/lib/mobile-auth"
import { revokeToken } from "@/lib/token-blocklist"
import { revokeTrackedSession } from "@/lib/auth-sessions"

const CORS = (req: NextRequest) => corsHeaders(req, "POST, OPTIONS")

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

// POST /api/auth/logout — revokes the caller's bearer token server-side so a
// lost/stolen device's token stops working immediately instead of staying valid
// for the rest of its 8h lifetime. Cookie expiry happens even on a revocation
// failure, while the non-2xx response prevents clients claiming success.
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  const hadCredential = authTokenFromRequest(req) !== null
  let confirmed = !hadCredential
  if (user?.jti) {
    const now = new Date()
    try {
      const tracked = await revokeTrackedSession(user.jti, user.id, now, "LOGOUT")
      const blocklisted = await revokeToken(
        user.jti,
        new Date(now.getTime() + AUTH_TOKEN_TTL_SECONDS * 1000),
      )
      confirmed = tracked || blocklisted
    } catch {
      confirmed = false
    }
  }
  const response = confirmed
    ? NextResponse.json({ ok: true }, { headers: CORS(req) })
    : NextResponse.json(
        { error: "Logout revocation could not be confirmed; retry" },
        { status: 503, headers: CORS(req) },
      )
  response.cookies.set(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  })
  return response
}
