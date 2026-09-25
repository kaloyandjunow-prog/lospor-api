import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { ensurePreopProfile, preparePreopProfile, serializePreopProfile } from "@/lib/preop/service"

/**
 * The appliance's preoperative profile: which bundled questions are on, their
 * order, and which are required. Read-only here. Hospital operators change it
 * from Status (through the internal control plane); the serverless demos run
 * the bundled defaults and offer no editor.
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    await preparePreopProfile(prisma, user.id)
    const profile = await prisma.$transaction(tx => ensurePreopProfile(tx, user.id))
    return NextResponse.json(serializePreopProfile(profile))
  } catch {
    return NextResponse.json({ error: "Preoperative profile unavailable" }, { status: 500 })
  }
}
