import { NextRequest, NextResponse, after } from "next/server"
import { AUTH_COOKIE_NAME, getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { revokeToken } from "@/lib/token-blocklist"
import { notePasswordChanged } from "@/lib/password-epoch"
import { logAudit } from "@/lib/audit"
import { corsHeaders } from "@/lib/cors"

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Bumping passwordChangedAt kills every token issued before now, not just the
  // one that made this request. Without it a deleted account kept full API
  // access from any other signed-in device until its token expired (up to 8 h).
  const now = new Date()
  await prisma.user.update({
    where: { id: user.id },
    data:  { deletedAt: now, passwordChangedAt: now },
  })
  notePasswordChanged(user.id, now)  // prime this instance's cache immediately

  after(() => logAudit(user.id, "ACCOUNT_DELETE_REQUEST", user.id))

  if (user.jti) {
    await revokeToken(user.jti, new Date(Date.now() + 8 * 60 * 60 * 1000))
  }

  // Clears the web cookie — no-op for mobile bearer token clients
  const response = NextResponse.json({ ok: true })
  response.cookies.set(AUTH_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  })
  return response
}
