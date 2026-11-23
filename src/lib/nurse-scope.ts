import "server-only"
import { calendarDayKey } from "@lospor/core/dashboard-date-scope"
import { prisma } from "@/lib/prisma"
import type { NurseScope } from "@/lib/nurse-access"

export { isNurse, isSeniorNurse, nurseCaseWhere, nurseReachesCase, refuseIfNotAllowed, userMay, type NurseScope } from "@/lib/nurse-access"

/** A nurse's cases and theatres today, loaded once per request with the account (10.8.0). */
export async function loadNurseScope(userId: string, now: Date = new Date()): Promise<NurseScope> {
  const shiftDate = calendarDayKey(now)
  const [cases, shifts] = await Promise.all([
    prisma.caseNurse.findMany({ where: { userId, case: { finalizedAt: null } }, select: { caseId: true } }),
    prisma.theatreNurseShift.findMany({ where: { userId, shiftDate: new Date(`${shiftDate}T00:00:00.000Z`) }, select: { theatreId: true } }),
  ])
  return { caseIds: cases.map(row => row.caseId), theatreIds: shifts.map(row => row.theatreId), shiftDate }
}
