import { NextRequest, NextResponse } from "next/server"
import { closeExpiredPendingCases } from "@/lib/pending-close"
import { bearerToken, matchesSecret } from "@/lib/constant-time-secret"

/**
 * Closes cases whose thirty-minute review window elapsed.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SCHEDULED ON THE APPLIANCE ONLY. DO NOT "RESTORE" THIS TO vercel.json.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * A thirty-minute window needs a sweep measured in minutes; once a day is not
 * a slower version of this feature, it is the absence of it. Vercel charges
 * for sub-daily cron schedules, and this deployment is on a plan without them:
 * an every-fifteen-minutes entry here does not run slowly, it makes the whole
 * deployment be **rejected**. It was added in 9.9.0 and froze the published API
 * at 9.8.0 for four releases before anyone noticed, because the failure lands
 * on a check nobody had made required.
 *
 * So the schedule lives where it can be honoured:
 *
 *   - **Appliance** — `infra/delivery/worker-loop.sh` calls this route every
 *     five minutes, on its own clock inside the delivery worker. That is the
 *     real deployment and this is fully automatic there. `worker-loop.test.sh`
 *     pins it, and the Status page shows a `case-close` component that reads as
 *     an outage if a sweep has not succeeded for an hour.
 *   - **Serverless** — nothing schedules it. A cloud case closes when a
 *     clinician still has it open as the countdown expires, and otherwise stays
 *     in AWAITING_REVIEW until someone acts on it or this route is called by
 *     hand. That is a real limitation of the hosted demo, stated rather than
 *     hidden; `vercel-crons.test.ts` keeps the entry out of vercel.json so the
 *     API can keep being published at all.
 *
 * Restoring the cron requires a Vercel plan with sub-daily schedules, and then
 * deleting that test along with this warning.
 *
 * Authenticates with `Authorization: Bearer $CRON_SECRET`, like every other
 * internal endpoint here, and also accepts the header form so it can be
 * triggered by hand -- which on the serverless deployment is the only way it
 * runs at all.
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
