import { NextResponse } from "next/server"
import { NURSE_ACCOUNT_ROLE, roleMay, type CaseAction } from "@lospor/core/clinical-roles"
import type { Prisma } from "@/generated/prisma/client"

/**
 * What an anaesthesia nurse can reach and do (10.8.0): the cases she is on,
 * and the unfinalised cases of the theatres she is on today that are planned
 * for today or have no planned date. Pure; the scope itself is loaded with the
 * account (nurse-scope.ts).
 */
export type NurseScope = {
  caseIds: string[]
  theatreIds: string[]
  /** Today's calendar date (YYYY-MM-DD) in the deployment's calendar. */
  shiftDate: string
}

export function isNurse(user: { role?: string | null } | null | undefined): boolean {
  return user?.role === NURSE_ACCOUNT_ROLE
}

/** Whether this account may take an action at all (case access is checked separately). */
export function userMay(user: { role?: string | null } | null | undefined, action: CaseAction): boolean {
  return roleMay(isNurse(user) ? "ANAESTHESIA_NURSE" : "ANAESTHETIST", action)
}

/**
 * The refusal for an action an anaesthesia nurse may not take, or null when
 * this account may. Routes call it right after authentication.
 */
export function refuseIfNotAllowed(user: { role?: string | null } | null | undefined, action: CaseAction): NextResponse | null {
  if (userMay(user, action)) return null
  return NextResponse.json({ error: "Not allowed for an anaesthesia nurse", code: "NURSE_NOT_ALLOWED", action }, { status: 403 })
}

const dateOf = (key: string) => new Date(`${key}T00:00:00.000Z`)

/** The cases a nurse reaches, as a query. */
export function nurseCaseWhere(scope: NurseScope | undefined): Prisma.CaseWhereInput {
  const or: Prisma.CaseWhereInput[] = []
  if (scope && scope.caseIds.length > 0) or.push({ id: { in: scope.caseIds } })
  if (scope && scope.theatreIds.length > 0) {
    or.push({
      operatingTheatreId: { in: scope.theatreIds },
      finalizedAt: null,
      OR: [{ plannedSurgeryDate: null }, { plannedSurgeryDate: dateOf(scope.shiftDate) }],
    })
  }
  // Nothing assigned: a query that matches no case.
  return or.length > 0 ? { OR: or } : { id: { in: [] } }
}

/** Whether a nurse reaches one case, from the fields every case access check selects. */
export function nurseReachesCase(scope: NurseScope | undefined, record: {
  id?: string
  operatingTheatreId?: string | null
  finalizedAt?: Date | null
  plannedSurgeryDate?: Date | null
}): boolean {
  if (!scope || !record.id) return false
  if (scope.caseIds.includes(record.id)) return true
  if (!record.operatingTheatreId || !scope.theatreIds.includes(record.operatingTheatreId)) return false
  if (record.finalizedAt) return false
  if (!record.plannedSurgeryDate) return true
  return record.plannedSurgeryDate.toISOString().slice(0, 10) === scope.shiftDate
}

/**
 * A nurse who writes to a theatre case keeps it until it is finalised, even
 * after her shift: the case is hers now (source THEATRE).
 */
export async function recordNurseWork(
  db: Pick<Prisma.TransactionClient, "caseNurse">,
  user: { id: string; role?: string | null },
  caseId: string,
): Promise<void> {
  if (!isNurse(user)) return
  await db.caseNurse.upsert({
    where: { caseId_userId: { caseId, userId: user.id } },
    create: { caseId, userId: user.id, source: "THEATRE" },
    update: {},
  })
}
