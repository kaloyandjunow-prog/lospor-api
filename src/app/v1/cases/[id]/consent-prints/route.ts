import { NextRequest, NextResponse } from "next/server"
import { ZodError } from "zod"
import { caseReadWhereForUser } from "@/lib/access-control"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { ConsentPrintError, consentPrintSchema, recordConsentPrint } from "@/lib/preop/documents"

// POST /api/cases/:id/consent-prints
// Records that the written consent was printed for this case, and which text
// (version and fingerprint) was on the sheet. Printing is reading, so anyone
// who may read the case may record it. A finalised case takes no new record.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params

  const record = await prisma.case.findFirst({ where: caseReadWhereForUser(user, id), select: { id: true, status: true } })
  if (!record) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (record.status === "COMPLETE") return NextResponse.json({ error: "CASE_FINALIZED" }, { status: 409 })

  try {
    const print = consentPrintSchema.parse(await req.json())
    const saved = await prisma.$transaction(tx => recordConsentPrint(tx, { caseId: id, userId: user.id, print }))
    return NextResponse.json({ id: saved.id, printedAt: saved.printedAt.toISOString() }, { status: 201 })
  } catch (error) {
    if (error instanceof ZodError || error instanceof SyntaxError) return NextResponse.json({ error: "Invalid request" }, { status: 400 })
    if (error instanceof ConsentPrintError) return NextResponse.json({ error: error.code }, { status: 409 })
    if (error instanceof Error && error.message.includes("CASE_FINALIZED")) return NextResponse.json({ error: "CASE_FINALIZED" }, { status: 409 })
    console.error("[consent-prints] record failed:", error)
    return NextResponse.json({ error: "Could not record the print" }, { status: 500 })
  }
}

export const dynamic = "force-dynamic"
