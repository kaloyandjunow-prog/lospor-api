import { NextRequest, NextResponse } from "next/server"
import { autoEndStaleIntraopCases } from "@/lib/intraop-auto-end"
import { bearerToken, matchesSecret } from "@/lib/constant-time-secret"

/**
 * The 48-hour automatic end on the hosted deployment (1.4.9), daily.
 *
 * A day is late for a 48-hour rule, and that is acceptable here for the same
 * reason close-expired-cases explains: the hosted plan allows no sub-daily
 * cron. The appliance runs the same sweep every five minutes through
 * close-expired-cases, and every deployment also ends a qualifying case the
 * moment it is opened, so the daily run only catches cases nobody opens.
 *
 * Authenticates with `Authorization: Bearer $CRON_SECRET` (or x-cron-secret).
 * Never reachable with a normal session: it ends clinical records.
 */
export const maxDuration = 60

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false // no secret configured = refuse, never run open
  return matchesSecret(bearerToken(req), secret)
    || matchesSecret(req.headers.get("x-cron-secret") ?? "", secret)
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const sweep = await autoEndStaleIntraopCases()
  return NextResponse.json({ ok: true, ...sweep })
}
