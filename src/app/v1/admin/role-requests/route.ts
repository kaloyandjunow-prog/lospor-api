import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!requireRole(user, ["ADMIN"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const requests = await prisma.roleRequest.findMany({
    where:   { status: "PENDING" },
    include: {
      user: {
        select: {
          id: true, email: true, name: true, firstName: true,
          lastName: true, title: true,
          institution: { select: { name: true, city: true } },
        },
      },
    },
    orderBy: { requestedAt: "asc" },
  })

  return NextResponse.json(requests)
}
