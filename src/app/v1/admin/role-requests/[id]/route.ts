import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"
import { invalidateAccountState } from "@/lib/password-epoch"
import { z } from "zod"
import { corsHeaders } from "@/lib/cors"

const schema = z.object({ action: z.enum(["approve", "reject"]) })

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!requireRole(user, ["ADMIN"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id } = await params
  const { action } = schema.parse(await req.json())

  const roleRequest = await prisma.roleRequest.findUnique({ where: { id } })
  if (!roleRequest) return NextResponse.json({ error: "Not found" }, { status: 404 })

  if (action === "approve") {
    await prisma.user.update({
      where: { id: roleRequest.userId },
      data:  { role: "HEAD_OF_DEPT" },
    })
    // Role is read live per request from a short-lived cache — drop the entry
    // so the promotion is effective immediately rather than within the TTL.
    invalidateAccountState(roleRequest.userId)
  }

  const updated = await prisma.roleRequest.update({
    where: { id },
    data:  { status: action === "approve" ? "APPROVED" : "REJECTED", resolvedAt: new Date() },
  })

  return NextResponse.json(updated)
}
