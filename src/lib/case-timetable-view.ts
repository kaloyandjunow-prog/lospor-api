import type { Prisma } from "@/generated/prisma/client"
import { deletedCaseLog } from "@/lib/case-events"

/**
 * The light read of a case for the timetable viewer (11.0): what it draws and nothing else.
 *
 * `GET /v1/cases/:id` returns the whole case, with the preop questionnaire's answers, their questions and
 * options, the suggestions, the calculations and every intraop column. The viewer needs the chart, when it
 * started and in which zone, the procedure's name and the entries deleted. This reads exactly those, in one
 * query (plus the deleted entries when asked for), through the same read rule as the full read.
 */
type Db = {
  case: { findFirst: (args: Prisma.CaseFindFirstArgs) => Promise<unknown> }
  caseEvent: Parameters<typeof deletedCaseLog>[0]["caseEvent"]
}

const TIMETABLE_SELECT = {
  id: true,
  caseCode: true,
  status: true,
  clinicalMode: true,
  preop: { select: { plannedProcedure: true, procedureUndetermined: true } },
  intraop: { select: { keyEvents: true, startedAt: true, endedAt: true, startTime: true, timezone: true } },
} satisfies Prisma.CaseSelect

export async function caseTimetableView(
  db: Db,
  where: Prisma.CaseWhereInput,
  options: { withDeleted: boolean },
): Promise<Record<string, unknown> | null> {
  const record = await db.case.findFirst({ where, select: TIMETABLE_SELECT }) as { id: string } | null
  if (!record) return null
  return {
    ...record,
    ...(options.withDeleted ? { deletedEvents: await deletedCaseLog(db as unknown as Parameters<typeof deletedCaseLog>[0], record.id) } : {}),
  }
}
