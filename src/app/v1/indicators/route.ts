import { NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/cors"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { MAX_PERIOD_DAYS, wardIndicators } from "@/lib/indicators"
import { indicatorPeriod } from "@/lib/indicators-period"

// The unit indicators (10.0.0): aggregate figures over the department's cases,
// open to every user in it. ?from&to (YYYY-MM-DD in the department's calendar,
// the last 90 days by default), and the filters theatre, assignee, mode,
// procedure and asa.

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) })
}

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const params = new URL(req.url).searchParams
  const period = indicatorPeriod(params.get("from"), params.get("to"), MAX_PERIOD_DAYS)
  if (!period) {
    return NextResponse.json({ error: "Invalid period" }, { status: 400, headers: corsHeaders(req) })
  }
  const text = (name: string, max: number) => params.get(name)?.trim().slice(0, max) || null
  const mode = params.get("mode")
  const response = await wardIndicators(prisma, user, {
    from: period.from,
    to: period.to,
    theatreId: text("theatre", 64),
    assigneeId: text("assignee", 64),
    mode: mode === "ADULT" || mode === "PEDIATRIC" ? mode : null,
    procedure: text("procedure", 300),
    asa: text("asa", 8),
  })
  return NextResponse.json(response, { headers: { ...corsHeaders(req), "Cache-Control": "no-store" } })
}
