import { caseWhereForUser } from "@/lib/access-control"
import { NextRequest, NextResponse } from "next/server"
import { SignJWT } from "jose"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { renderRecordPdf } from "@/lib/record-pdf"
import { revokeToken } from "@/lib/token-blocklist"
import { verifyPrintToken } from "@/lib/print-token"

// Headless Chrome can take a few seconds to boot and render the record.
export const maxDuration = 60

function secret() {
  const value = process.env.LOSPOR_AUTH_SECRET ?? process.env.NEXTAUTH_SECRET
  if (!value) throw new Error("LOSPOR_AUTH_SECRET or NEXTAUTH_SECRET is required")
  return new TextEncoder().encode(value)
}

// GET /api/cases/:id/pdf[?print_token=…]
// Returns the finished-case record as a real A4-landscape PDF file, generated
// server-side by rendering /cases/[id]/print in headless Chrome. This is what
// the phone opens for "Print case" — a proper PDF instead of fighting the
// mobile browser's print dialog. Auth: print token (mobile flow) or the normal
// session/bearer auth (web "Download PDF" button).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const qToken      = req.nextUrl.searchParams.get("print_token")
  const tokenUserId = qToken ? await verifyPrintToken(qToken, id) : null

  let where
  if (tokenUserId) {
    // A valid print token is itself the authorization: it is signed, 5-minute
    // and case-scoped, and only issued after a role-aware ownership check —
    // so don't re-check ownership here (an admin/HOD printing someone else's
    // case would otherwise 404, since the token carries the REQUESTER's id).
    where = { id }
  } else {
    const user = await getAuthUser(req)
    if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    // Shared predicate: a case belongs to the institution it was performed at.
    // This route used to scope by the owner's current institution, so a case
    // followed its author to a new hospital.
    where = caseWhereForUser(user, id)
  }

  const record = await prisma.case.findFirst({ where, select: { id: true, caseCode: true, userId: true } })
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // Self-issued short-lived token so headless Chrome can open the print page
  // without a session. Scoped to the case owner, which always passes the print
  // page's member-scope check regardless of who requested the PDF.
  const navJti = crypto.randomUUID()
  const navToken = await new SignJWT({ caseId: id, userId: record.userId, type: "print" })
    .setProtectedHeader({ alg: "HS256" })
    .setJti(navJti)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secret())

  // Never derive this from the Host header: it is attacker-controlled and this
  // URL is handed to a headless browser together with a valid print token.
  const base =
    process.env.LOSPOR_WEB_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXTAUTH_URL
    ?? (process.env.NODE_ENV === "production"
        ? null
        : `http://${req.headers.get("host")}`)
  if (!base) {
    console.error("[pdf] LOSPOR_WEB_URL must be set in production")
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 })
  }
  const pageUrl = `${base}/cases/${id}/print?print_token=${navToken}&pdf=1`

  // Record language: explicit ?lang= (mobile app) beats the web locale cookie.
  const langParam = req.nextUrl.searchParams.get("lang")
  const lang = langParam === "bg" ? "bg" : langParam === "en" ? "en" : (req.cookies.get("locale")?.value === "bg" ? "bg" : undefined)

  try {
    const pdf = await renderRecordPdf(pageUrl, lang)
    // Single use: the headless browser has finished with it, so burn it rather
    // than leave a valid token sitting in this process's logs for five minutes.
    // Only on success — the failure path below still needs it to redirect.
    await revokeToken(navJti, new Date(Date.now() + 5 * 60_000)).catch(() => {})
    return new NextResponse(pdf as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${record.caseCode ?? "case"}-record.pdf"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (err) {
    console.error("record-pdf render failed:", err)
    // No Chrome available / render failed — fall back to the HTML print page
    // so the user still gets something printable.
    return NextResponse.redirect(`${base}/cases/${id}/print?print_token=${navToken}`)
  }
}
