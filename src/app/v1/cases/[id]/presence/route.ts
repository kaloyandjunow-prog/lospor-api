import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { caseWriteWhereForUser } from "@/lib/access-control"
import { leaveCasePresence, touchCasePresence } from "@/lib/case-presence"
import { corsHeaders } from "@/lib/cors"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"

/**
 * Who has the case open (10.8.0). A screen on the case reports itself (POST, repeated by its heartbeat) and is
 * answered with the people in the case; closing the case leaves it (DELETE). Only people who may change the
 * case are counted and told -- a notice for those who share the work, nothing is locked by it.
 */
const bodySchema = z.object({ deviceId: z.string().trim().min(1).max(256) })

async function resolve(req: NextRequest, id: string): Promise<{ userId: string; deviceId: string } | NextResponse> {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const found = await prisma.case.findFirst({ where: caseWriteWhereForUser(user, id), select: { id: true } })
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const parsed = bodySchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: "A non-empty deviceId is required", code: "INVALID_DEVICE_ID" }, { status: 400 })
  return { userId: user.id, deviceId: parsed.data.deviceId }
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) })
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const resolved = await resolve(req, id)
  if (resolved instanceof NextResponse) return resolved
  return NextResponse.json(await touchCasePresence({ caseId: id, ...resolved }))
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const resolved = await resolve(req, id)
  if (resolved instanceof NextResponse) return resolved
  await leaveCasePresence({ caseId: id, ...resolved })
  return NextResponse.json({ left: true })
}
