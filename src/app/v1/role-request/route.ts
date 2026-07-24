import { NextRequest, NextResponse, after } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"
import { corsHeaders } from "@/lib/cors"

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const request = await prisma.roleRequest.findFirst({
    where:   { userId: user.id },
    orderBy: { requestedAt: "desc" },
  })

  return NextResponse.json(request ?? null)
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  if (user.role !== "MEMBER" && user.role !== "CLINICIAN" && user.role !== "RESEARCHER") {
    return NextResponse.json({ error: "Only members can submit this request" }, { status: 403 })
  }

  const existing = await prisma.roleRequest.findFirst({
    where: { userId: user.id, status: "PENDING" },
  })
  if (existing) return NextResponse.json({ error: "Request already pending" }, { status: 409 })

  const request = await prisma.roleRequest.create({
    data: { userId: user.id },
  })

  after(() => logAudit(user.id, "ROLE_REQUEST_SUBMIT", user.id))
  return NextResponse.json(request, { status: 201 })
}
