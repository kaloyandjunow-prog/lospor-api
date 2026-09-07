import { prisma } from "@/lib/prisma"
import type { Prisma } from "@/generated/prisma/client"
import { calendarMonthKey, isSameCalendarDay, isSameCalendarMonth } from "@lospor/core/dashboard-date-scope"

/**
 * True dashboard tile counts over the whole accessible case set, not the
 * paginated slice a client happened to load.
 *
 * Mobile fetched `/api/cases` with no pagination params at all (the API
 * default is 50) and web capped at 200, then both computed "Today", "Active",
 * "Drafts" and the rest by filtering that one loaded array -- so a clinic
 * with more open work than the cap could show a stat tile that undercounts
 * its own dashboard, and an old case that had fallen off the loaded slice
 * would not just be hidden, it would be uncounted.
 *
 * Every scope here except "today" and "month" is a plain column filter and
 * is counted directly in the database. "today"/"month" need a calendar
 * boundary, which depends on a timezone the database does not know, so those
 * two are evaluated in JS against a minimal projection, using the same
 * calendar-day/month comparison the dashboards themselves use -- one
 * definition of "today", not a SQL day range that could disagree with it.
 */
export type DashboardCaseCounts = {
  all: number
  today: number
  month: number
  active: number
  drafts: number
  awaitingPostop: number
  complete: number
  icu: number
  handovers: number
}

export async function dashboardCaseCounts(
  where: Prisma.CaseWhereInput,
  userId: string,
  now: Date = new Date(),
): Promise<DashboardCaseCounts> {
  const [all, active, drafts, complete, awaitingPostop, icu, handovers, dateRows] = await Promise.all([
    prisma.case.count({ where }),
    prisma.case.count({ where: { ...where, status: { not: "COMPLETE" } } }),
    prisma.case.count({ where: { ...where, status: "DRAFT" } }),
    prisma.case.count({ where: { ...where, status: "COMPLETE" } }),
    // "Awaiting postop": the case has ended intraoperatively but is not yet
    // finalised -- the same predicate the web dashboard's own row status uses,
    // not merely "an intraop record exists" (which mobile's local filter used
    // to check, before this counted from the server).
    prisma.case.count({ where: { ...where, status: { not: "COMPLETE" }, intraop: { endTime: { not: null } } } }),
    prisma.case.count({ where: { ...where, postop: { disposition: "ICU" } } }),
    // "Handovers awaiting action by me" -- the one definition, matching
    // /v1/cases/transfers/pending's own default (incoming, toUserId = me).
    // Previously this counted any accessible case with any pending transfer
    // in either direction, which could include handovers this person sent
    // and is waiting on someone else to accept, or (for an admin/HOD) a
    // handover between two other people entirely -- neither of which is
    // "mine to act on". Deliberately not scoped by `where`: a transfer
    // addressed to this person is theirs to answer regardless of whether the
    // case would otherwise appear in their institution-scoped case list.
    prisma.caseTransfer.count({ where: { toUserId: userId, status: "PENDING" } }),
    prisma.case.findMany({
      where,
      select: { createdAt: true, intraop: { select: { monthYear: true } } },
    }),
  ])

  const today = dateRows.filter(c => isSameCalendarDay(c.createdAt, now)).length
  const month = dateRows.filter(c => isThisMonth(c, now)).length

  return { all, today, month, active, drafts, awaitingPostop, complete, icu, handovers }
}

function isThisMonth(c: { createdAt: Date; intraop: { monthYear: string | null } | null }, now: Date): boolean {
  const my = c.intraop?.monthYear
  if (my) {
    // monthYear ("YYYY-M") is a calendar label the client already assigned at
    // save time, not an instant -- compared against the same Europe/Sofia
    // calendar month every other "this month" check in this codebase reads,
    // never the server process's own local clock.
    const [y, m] = my.split("-").map(Number)
    return `${y}-${String(m).padStart(2, "0")}` === calendarMonthKey(now)
  }
  return isSameCalendarMonth(c.createdAt, now)
}
