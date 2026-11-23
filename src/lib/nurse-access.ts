import { NextResponse } from "next/server"
import { SENIOR_NURSE_ACCOUNT_ROLE, clinicalRoleOf, isNurseAccountRole, roleMay, type CaseAction } from "@lospor/core/clinical-roles"
import { calendarDayKey } from "@lospor/core/dashboard-date-scope"
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

/** A nurse or a senior nurse. */
export function isNurse(user: { role?: string | null } | null | undefined): boolean {
  return isNurseAccountRole(user?.role)
}

/** The senior nurse (2026-11-23): edits every case of her hospital and puts nurses on cases. */
export function isSeniorNurse(user: { role?: string | null } | null | undefined): boolean {
  return user?.role === SENIOR_NURSE_ACCOUNT_ROLE
}

/** Whether this account may take an action at all (case access is checked separately). */
export function userMay(user: { role?: string | null } | null | undefined, action: CaseAction): boolean {
  return roleMay(clinicalRoleOf(user?.role), action)
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
 * The nurses of a theatre are put on its cases (2026-11-23), not only reached through the theatre: a nurse on theatre T for a
 * day gets a place (source THEATRE) on every unfinalised case of T planned for that day -- or with no planned date, on today.
 * Run when a nurse is put on a theatre, when a case is put in a theatre, and when a case's planned date changes. A place is
 * never taken back by the shift being cleared: it stays until the case is finalised, like a place she was given by hand.
 */
export async function pinTheatreNurses(
  db: Pick<Prisma.TransactionClient, "case" | "caseNurse" | "theatreNurseShift">,
  scope: { theatreId: string; shiftDate: string; userId?: string; caseId?: string; today: string },
): Promise<number> {
  const day = dateOf(scope.shiftDate)
  const shifts = await db.theatreNurseShift.findMany({
    where: { theatreId: scope.theatreId, shiftDate: day, ...(scope.userId ? { userId: scope.userId } : {}) },
    select: { userId: true },
  })
  if (!shifts.length) return 0
  const cases = await db.case.findMany({
    where: {
      operatingTheatreId: scope.theatreId,
      status: { notIn: ["COMPLETE", "CANCELLED"] },
      ...(scope.caseId ? { id: scope.caseId } : {}),
      OR: [{ plannedSurgeryDate: day }, ...(scope.shiftDate === scope.today ? [{ plannedSurgeryDate: null }] : [])],
    },
    select: { id: true },
  })
  if (!cases.length) return 0
  const made = await db.caseNurse.createMany({
    data: cases.flatMap(row => shifts.map(shift => ({ caseId: row.id, userId: shift.userId, source: "THEATRE" as const }))),
    skipDuplicates: true,
  })
  return made.count
}

/** The nurses on this case's theatre for its day (its planned date, or today when it has none) get a place on it. */
export async function pinNursesOfCaseTheatre(
  db: Pick<Prisma.TransactionClient, "case" | "caseNurse" | "theatreNurseShift">,
  caseId: string,
): Promise<number> {
  const row = await db.case.findUnique({ where: { id: caseId }, select: { operatingTheatreId: true, plannedSurgeryDate: true } })
  if (!row?.operatingTheatreId) return 0
  const today = calendarDayKey(new Date())
  const shiftDate = row.plannedSurgeryDate ? row.plannedSurgeryDate.toISOString().slice(0, 10) : today
  return pinTheatreNurses(db, { theatreId: row.operatingTheatreId, shiftDate, caseId, today })
}

/**
 * A nurse who works a case she reaches only through her theatre keeps it until it is finalised, even after her shift or at
 * midnight: the case is hers now (source THEATRE). A nurse put on the case, and a senior nurse, are not pinned by writing.
 */
export async function recordNurseWork(
  db: Pick<Prisma.TransactionClient, "caseNurse">,
  user: { id: string; role?: string | null },
  caseId: string,
): Promise<void> {
  if (!isNurse(user) || isSeniorNurse(user)) return
  await db.caseNurse.upsert({
    where: { caseId_userId: { caseId, userId: user.id } },
    create: { caseId, userId: user.id, source: "THEATRE" },
    update: {},
  })
}

/**
 * An edit may not give a nurse a doctor's decision (10.8.0): the acknowledgement that a drug is given despite an
 * allergy warning is carried over unchanged from the stored event, never put on or changed by a nurse.
 */
export function refuseChangedAllergyAck(
  user: { role?: string | null } | null | undefined,
  stored: { allergyAck?: unknown } | null | undefined,
  incoming: { allergyAck?: unknown },
): NextResponse | null {
  const ack = (value: unknown) => (Array.isArray(value) ? value.map(String).sort().join("|") : "")
  if (ack(incoming.allergyAck) === ack(stored?.allergyAck)) return null
  const refusal = refuseIfNotAllowed(user, "GIVE_DESPITE_ALLERGY")
  if (!refusal) return null
  // A nurse's edit that leaves the acknowledgement out does not take the doctor's away: it stays as it was.
  if (ack(incoming.allergyAck) === "") { incoming.allergyAck = stored?.allergyAck; return null }
  return refusal
}
