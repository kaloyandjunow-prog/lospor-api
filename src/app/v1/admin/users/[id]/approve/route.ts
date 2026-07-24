import { NextRequest, NextResponse, after } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"
import { corsHeaders } from "@/lib/cors"

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!requireRole(user, ["ADMIN"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id } = await params

  const updated = await prisma.user.update({
    where: { id },
    data:  { approvedAt: new Date() },
    select: { id: true, email: true, name: true },
  })

  after(() => logAudit(user.id, "USER_APPROVE", id))
  return NextResponse.json(updated)
}
