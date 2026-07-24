import { NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/cors"
import { getAuthUser } from "@/lib/mobile-auth"
import { revokeToken } from "@/lib/token-blocklist"

const CORS = (req: NextRequest) => corsHeaders(req, "POST, OPTIONS")

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

// POST /api/auth/logout — revokes the caller's bearer token server-side so a
// lost/stolen device's token stops working immediately instead of staying valid
// for the rest of its 8h lifetime. Idempotent: always returns ok.
export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (user?.jti) {
    // Token TTL is 8h; block the jti until at least then so it can't be replayed.
    await revokeToken(user.jti, new Date(Date.now() + 8 * 60 * 60 * 1000))
  }
  return NextResponse.json({ ok: true }, { headers: CORS(req) })
}
