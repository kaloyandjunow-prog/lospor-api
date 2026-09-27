import { NextResponse } from "next/server"
import type { IntraopTimelineIssue } from "@lospor/core/intraop-commands"

/**
 * A timeline write the Core rules refuse (1.4.9), as the response every event
 * route returns: 400, which the clients' outbox records and drops rather than
 * retrying for ever, with the rule and the entry named.
 */
/**
 * A change to an entry made before the entry's latest change, made elsewhere
 * (9.13.0): the last change made wins, not the last to arrive. Permanent for
 * this change -- the device lists it as refused and never resends it -- and
 * the same answer from every event route.
 */
export function supersededRefusal(): NextResponse {
  return NextResponse.json({
    error: "A later change to this entry was made on another screen",
    code: "SUPERSEDED",
  }, { status: 412 })
}

export function timelineRefusal(issues: IntraopTimelineIssue[]): NextResponse | null {
  const [issue] = issues
  if (!issue) return null
  return NextResponse.json({
    error: "timeline_rule",
    code: issue.code,
    eventId: issue.eventId,
    relatedEventId: issue.relatedEventId,
  }, { status: 400 })
}
