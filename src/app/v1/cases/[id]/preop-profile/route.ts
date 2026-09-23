import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { getAuthUser } from "@/lib/mobile-auth"
import { canWriteCaseWithOwnerFallback } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"
import { pinPreopProfile, PreopContractError, serializePreopProfile } from "@/lib/preop/service"

const bodySchema = z.object({ profileVersion: z.number().int().positive(), adopt: z.boolean().default(false) })

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  try {
    const body = bodySchema.parse(await req.json())
    const result = await prisma.$transaction(async tx => {
      const record = await tx.case.findUnique({ where: { id }, select: { userId: true, createdById: true, institutionId: true } })
      if (!record) return null
      if (!await canWriteCaseWithOwnerFallback(tx, user, record)) return "FORBIDDEN" as const
      return pinPreopProfile(tx, id, user.id, body.profileVersion, body.adopt)
    })
    if (result === null) return NextResponse.json({ error: "Not found" }, { status: 404 })
    if (result === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    return NextResponse.json({ ...result.pin, profile: serializePreopProfile(result.profile) })
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid request", issues: error.issues }, { status: 400 })
    if (error instanceof PreopContractError) return NextResponse.json({ error: error.code, details: error.details }, { status: 409 })
    return NextResponse.json({ error: "Profile adoption failed" }, { status: 500 })
  }
}
