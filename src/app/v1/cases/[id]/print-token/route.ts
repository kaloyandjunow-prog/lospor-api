import { caseReadWhereForUser } from "@/lib/access-control"
import { NextRequest, NextResponse } from "next/server"
import { SignJWT } from "jose"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"

function secret() {
  const value = process.env.LOSPOR_AUTH_SECRET ?? process.env.NEXTAUTH_SECRET
  if (!value) throw new Error("LOSPOR_AUTH_SECRET or NEXTAUTH_SECRET is required")
  return new TextEncoder().encode(value)
}

// POST /api/cases/:id/print-token
// Issues a short-lived (5 min) signed token that lets the holder view and
// print the case protocol page without a full web session.  Used by the
// mobile app so "Print PDF" works without the user being logged in on the
// device browser.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params

  // Verify the user actually has access to this case. The role branching that
  // used to live here now lives in caseReadWhereForUser, so every route scopes the
  // same way rather than each keeping its own copy.
  const record  = await prisma.case.findFirst({
    // Shared predicate: a case belongs to the institution it was performed at,
    // not to wherever its author currently works.
    where: caseReadWhereForUser(user, id),
    select: { id: true },
  })
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // Sign a 5-minute print token
  // jti so the token can be revoked. Print tokens travel in a query string —
  // they end up in access logs, browser history and Referer headers — so the
  // 5-minute window is the main protection, and revocability is the backstop.
  const token = await new SignJWT({ caseId: id, userId: user.id, type: "print" })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secret())

  const base =
    process.env.LOSPOR_WEB_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXTAUTH_URL ??
    `https://${req.headers.get("host")}`
  const url    = `${base}/cases/${id}/print?print_token=${token}`
  // Server-generated real PDF — what the mobile app should prefer to open.
  const pdfUrl = `${base}/api/cases/${id}/pdf?print_token=${token}`

  return NextResponse.json({ token, url, pdfUrl })
}
