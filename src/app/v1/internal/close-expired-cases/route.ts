import { NextRequest, NextResponse } from "next/server"
import { closeExpiredPendingCases } from "@/lib/pending-close"
import { bearerToken, matchesSecret } from "@/lib/constant-time-secret"

/**
 * Closes cases whose thirty-minute review window elapsed.
 *
 * Scheduled two ways, and saying so matters -- the retention job's comment
 * records what happens when only one is documented. The serverless deployment
 * uses Vercel Cron (see vercel.json). A hospital appliance has no cron, and
 * runs it from the delivery worker's own loop, which already ticks every sixty
 * seconds: a thirty-minute window wants a cadence in minutes, not the daily
 * clock retention uses.
 *
 * Authenticates with `Authorization: Bearer $CRON_SECRET`, like every other
 * internal endpoint here, and also accepts the header form so it can be
 * triggered by hand.
 *
 * Never reachable with a normal session: it closes clinical records.
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

  const sweep = await closeExpiredPendingCases()

  return NextResponse.json({ ok: true, ...sweep })
}
