import { NextResponse } from "next/server"
import type { IntraopTimelineIssue } from "@lospor/core/intraop-commands"

/**
 * A timeline write the Core rules refuse (1.4.9), as the response every event
 * route returns: 400, which the clients' outbox records and drops rather than
 * retrying for ever, with the rule and the entry named.
 */
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
