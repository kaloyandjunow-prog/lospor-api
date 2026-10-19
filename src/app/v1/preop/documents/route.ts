import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { preopDocuments } from "@/lib/preop/documents"

/**
 * Whether this site shows the preop summary page and prints the written
 * consent, and the consent texts when it does. Read-only here: operators
 * change them in Status (appliance). The serverless demos have both off.
 */
export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    return NextResponse.json(await preopDocuments(prisma), { headers: { "Cache-Control": "no-store" } })
  } catch {
    return NextResponse.json({ error: "Preoperative documents unavailable" }, { status: 500 })
  }
}

export const dynamic = "force-dynamic"
