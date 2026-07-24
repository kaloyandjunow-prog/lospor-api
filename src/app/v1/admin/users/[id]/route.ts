import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"
import { invalidateAccountState } from "@/lib/password-epoch"
import { z } from "zod"
import { corsHeaders } from "@/lib/cors"

const schema = z.object({
  role: z.enum(["MEMBER", "HEAD_OF_DEPT"]),
})

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
  const body   = await req.json()
  const data   = schema.parse(body)

  const updated = await prisma.user.update({
    where: { id },
    data:  { role: data.role },
    select: { id: true, role: true },
  })
  // Role is resolved live per request from a short-lived cache. Dropping the
  // entry makes a demotion effective on the target's very next request instead
  // of waiting out the cache TTL.
  invalidateAccountState(id)

  return NextResponse.json(updated)
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!requireRole(user, ["ADMIN"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const { id } = await params
  if (id === user.id) {
    return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 })
  }

  await prisma.user.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
