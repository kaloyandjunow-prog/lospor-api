import { NextRequest, NextResponse } from "next/server"
import { purgeDeletedAccounts, RETENTION_DAYS } from "@/lib/purge-deleted"
import { logAudit } from "@/lib/audit"

// Retention job. Invoked by Vercel Cron (see vercel.json), which sends
// `Authorization: Bearer $CRON_SECRET`. Also accepts the same secret header the
// snapshot endpoint uses, so it can be triggered by hand during an audit.
//
// Not exposed to clinicians and never reachable with a normal session — this is
// infrastructure, and it deletes identifying data.
export const maxDuration = 60

function authorised(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false // no secret configured = refuse, never run open
  const bearer = req.headers.get("authorization")
  return bearer === `Bearer ${secret}` || req.headers.get("x-cron-secret") === secret
}

export async function GET(req: NextRequest) {
  if (!authorised(req)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const result = await purgeDeletedAccounts()

  // Anonymising an account is itself an auditable act.
  for (const userId of result.userIds) {
    await logAudit(userId, "ACCOUNT_ANONYMISED", userId, { retentionDays: RETENTION_DAYS }).catch(() => {})
  }

  return NextResponse.json({
    ok: true,
    retentionDays: RETENTION_DAYS,
    scanned: result.scanned,
    anonymised: result.anonymised,
    rateLimitRowsRemoved: result.rateLimitRowsRemoved,
  })
}
