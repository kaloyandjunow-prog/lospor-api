import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { caseReadWhereForUser } from "@/lib/access-control"
import { verifyPrintToken } from "@/lib/print-token"
import { preopDocuments } from "@/lib/preop/documents"
import { preopSummaryFindings } from "@/lib/preop/findings"

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const queryToken = req.nextUrl.searchParams.get("print_token")
  const tokenUserId = queryToken
    ? await verifyPrintToken(queryToken, id)
    : null

  let where
  if (tokenUserId) {
    where = { id }
  } else {
    const user = await getAuthUser(req)
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    where = caseReadWhereForUser(user, id)
  }

  const record = await prisma.case.findFirst({
    where,
    include: {
      preop: { include: { assessmentAnswers: { select: { state: true, optionKey: true, valueText: true, question: { select: { stableKey: true } } } } } },
      intraop: true,
      postop: true,
      institution: { select: { name: true, city: true } },
      // The preop summary names who consulted and who has the case now.
      createdBy: { select: { name: true, title: true } },
      user: { select: { name: true, title: true } },
    },
  })
  if (!record) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  // The preop summary sheet prints in headless Chrome with only a print
  // token, so the switches and consent texts travel with the case.
  const { assessmentAnswers, ...preop } = record.preop ?? { assessmentAnswers: [] }
  return NextResponse.json({
    ...record,
    preop: record.preop ? preop : null,
    preopDocuments: await preopDocuments(prisma),
    preopFindings: preopSummaryFindings(record.preop, assessmentAnswers),
  })
}
