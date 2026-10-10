import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { ensurePreopProfiles, preparePreopProfile, serializePreopProfiles } from "@/lib/preop/service"

/**
 * The appliance's preoperative profiles, adult and paediatric, in one shape:
 * which bundled questions are on for each, their order, and which are required. Read-only here. Hospital operators change it
 * from Status (through the internal control plane); the serverless demos run
 * the bundled defaults and offer no editor.
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    await preparePreopProfile(prisma, user.id)
    const profiles = await prisma.$transaction(tx => ensurePreopProfiles(tx, user.id))
    return NextResponse.json(serializePreopProfiles(profiles))
  } catch {
    return NextResponse.json({ error: "Preoperative profile unavailable" }, { status: 500 })
  }
}
