import { NextRequest, NextResponse } from "next/server"
import { purgeDeletedAccounts, RETENTION_DAYS } from "@/lib/purge-deleted"
import { bearerToken, matchesSecret } from "@/lib/constant-time-secret"

// Retention job: anonymises accounts deleted more than RETENTION_DAYS ago and
// prunes their rate-limit rows.
//
// Two deployments schedule it two different ways, and saying so matters. The
// serverless deployment uses Vercel Cron (see vercel.json). A hospital
// appliance has neither, and for every release up to now this comment named
// only the Vercel path — so on an appliance the job had no scheduler at all and
// had never run once, on a box holding encrypted patient linkage. The appliance
// runs it daily from its delivery worker.
//
// Either way it authenticates with `Authorization: Bearer $CRON_SECRET`. It
// also accepts the same secret in the header the snapshot endpoint uses, so it
// can be triggered by hand during an audit.
//
// Not exposed to clinicians and never reachable with a normal session — this is
// infrastructure, and it deletes identifying data.
export const maxDuration = 60

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false // no secret configured = refuse, never run open
  // Constant-time, as every other internal endpoint here already was. `===`
  // returns at the first differing byte, so the time it takes reports how long
  // a correct prefix the caller has, and the secret can be recovered a byte at
  // a time -- on the endpoint that anonymises accounts.
  return matchesSecret(bearerToken(req), secret)
    || matchesSecret(req.headers.get("x-cron-secret") ?? "", secret)
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const result = await purgeDeletedAccounts()

  return NextResponse.json({
    ok: true,
    retentionDays: RETENTION_DAYS,
    scanned: result.scanned,
    anonymised: result.anonymised,
    rateLimitRowsRemoved: result.rateLimitRowsRemoved,
  })
}
