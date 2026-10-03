import { prisma } from "@/lib/prisma"
import type { Prisma } from "@/generated/prisma/client"
import { calendarDayKey, calendarMonthKey, DASHBOARD_TIMEZONE } from "@lospor/core/dashboard-date-scope"

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
 * Every scope is counted in the database. The two calendar scopes are turned
 * into UTC half-open ranges using the shared Europe/Sofia calendar definition,
 * so the query does not load the entire archive just to filter dates in JS.
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

export type DashboardDateRange = { gte: Date; lt: Date }

/** Convert a local calendar midnight in the dashboard timezone to an instant. */
function utcAtCalendarMidnight(dayKey: string): Date {
  const [year, month, day] = dayKey.split("-").map(Number)
  const nominalUtc = Date.UTC(year, month - 1, day)
  let guess = nominalUtc

  // The offset is the only circular part: the instant used to read the
  // timezone determines the offset, which is then subtracted from local
  // midnight. Three iterations cover DST transitions and keep this
  // independent of the appliance process timezone.
  for (let i = 0; i < 3; i += 1) {
    const offsetPart = new Intl.DateTimeFormat("en-US", {
      timeZone: DASHBOARD_TIMEZONE,
      timeZoneName: "longOffset",
    }).formatToParts(new Date(guess)).find(part => part.type === "timeZoneName")?.value ?? "GMT"
    const match = /^GMT(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/.exec(offsetPart)
    if (!match) throw new Error(`Unsupported dashboard timezone offset: ${offsetPart}`)
    const sign = match[1] === "-" ? -1 : 1
    const hours = Number(match[2] ?? 0)
    const minutes = Number(match[3] ?? 0)
    guess = nominalUtc - sign * (hours * 60 + minutes) * 60_000
  }
  return new Date(guess)
}

function nextDayKey(dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number)
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`
}

function nextMonthKey(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number)
  const next = new Date(Date.UTC(year, month, 1))
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`
}

export function dashboardDayRange(now: Date): DashboardDateRange {
  const startKey = calendarDayKey(now, DASHBOARD_TIMEZONE)
  return { gte: utcAtCalendarMidnight(startKey), lt: utcAtCalendarMidnight(nextDayKey(startKey)) }
}

export function dashboardMonthRange(now: Date): DashboardDateRange {
  const monthKey = calendarMonthKey(now, DASHBOARD_TIMEZONE)
  const startKey = `${monthKey}-01`
  const nextKey = `${nextMonthKey(monthKey)}-01`
  return { gte: utcAtCalendarMidnight(startKey), lt: utcAtCalendarMidnight(nextKey) }
}

export async function dashboardCaseCounts(
  where: Prisma.CaseWhereInput,
  userId: string,
  now: Date = new Date(),
): Promise<DashboardCaseCounts> {
  const todayRange = dashboardDayRange(now)
  const monthRange = dashboardMonthRange(now)
  const monthKey = calendarMonthKey(now, DASHBOARD_TIMEZONE)
  // Early records used YYYY-M while the current schema writes YYYY-MM. Keep
  // the legacy spelling in the indexed month label predicate during migration.
  const legacyMonthKey = `${monthKey.slice(0, 4)}-${Number(monthKey.slice(5, 7))}`
  const dateFallback = {
    createdAt: monthRange,
    // No label, or an empty one: the creation date decides, as it did before
    // the count moved into the database. An empty label is not a month.
    OR: [
      { intraop: { is: null } },
      { intraop: { is: { monthYear: null } } },
      { intraop: { is: { monthYear: "" } } },
    ],
  } satisfies Prisma.CaseWhereInput

  const [all, today, month, active, drafts, complete, awaitingPostop, icu, handovers] = await Promise.all([
    prisma.case.count({ where }),
    prisma.case.count({ where: { AND: [where, { createdAt: todayRange }] } }),
    prisma.case.count({
      where: {
        AND: [
          where,
          {
            OR: [
              { intraop: { monthYear: { in: [monthKey, legacyMonthKey] } } },
              dateFallback,
            ],
          },
        ],
      },
    }),
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
  ])

  return { all, today, month, active, drafts, awaitingPostop, complete, icu, handovers }
}
