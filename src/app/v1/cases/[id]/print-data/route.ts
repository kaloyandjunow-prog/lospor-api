import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { caseWhereForUser } from "@/lib/access-control"
import { verifyPrintToken } from "@/lib/print-token"

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
    where = caseWhereForUser(user, id)
  }

  const record = await prisma.case.findFirst({
    where,
    include: {
      preop: true,
      intraop: true,
      postop: true,
      institution: { select: { name: true, city: true } },
    },
  })
  if (!record) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  return NextResponse.json(record)
}
