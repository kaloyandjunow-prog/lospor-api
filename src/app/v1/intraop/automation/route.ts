import { NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/cors"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { indicatorScope } from "@/lib/indicators"
import { intraopAutomationForClient } from "@/lib/intraop-automation"

// Intraoperative automation (10.1.0): what the hospital has switched on, and
// the reading counts per age band the vitals questions are measured against,
// over the same cases as the unit indicators. Off, no counts are sent.
export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) })
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: corsHeaders(req) })
  const body = await intraopAutomationForClient(prisma, indicatorScope(user))
  return NextResponse.json(body, { headers: { ...corsHeaders(req), "Cache-Control": "no-store" } })
}
