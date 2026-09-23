import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"
import { activePreopProfile, ensureInitialPreopProfile, publishPreopProfile, serializePreopProfile } from "@/lib/preop/service"

const profileBody = z.object({
  questions: z.array(z.object({
    stableKey: z.string().min(1),
    enabled: z.boolean(),
    required: z.boolean(),
    sortOrder: z.number().int().nonnegative(),
  })).optional(),
})

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    const profile = await prisma.$transaction(async tx => {
      await ensureInitialPreopProfile(tx, user.id)
      const value = await activePreopProfile(tx)
      if (!value) throw new Error("PREOP_PROFILE_NOT_PROVISIONED")
      return serializePreopProfile(value)
    })
    return NextResponse.json(profile)
  } catch {
    return NextResponse.json({ error: "Preoperative profile unavailable" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!requireRole(user, ["ADMIN"])) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const body = profileBody.parse(await req.json())
    const profile = await prisma.$transaction(tx => publishPreopProfile(tx, user.id, body.questions ?? []))
    return NextResponse.json(serializePreopProfile(profile), { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "Invalid profile", issues: error.issues }, { status: 400 })
    return NextResponse.json({ error: "Profile publish failed" }, { status: 400 })
  }
}
