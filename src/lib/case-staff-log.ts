import type { Prisma } from "@/generated/prisma/client"

/**
 * The history of who was on a case (2026-11-23): a row each time a doctor or a nurse joins or leaves it. Never changed or
 * removed -- the database refuses -- so a case always says who was on it at any time. CaseNurse is only who is on it now.
 */
export type StaffEntry = {
  caseId: string
  userId: string
  kind: "DOCTOR" | "NURSE"
  action: "JOINED" | "LEFT"
  /** How: CREATED, TRANSFER, ASSIGNED, THEATRE, HANDOVER, SELF, REMOVED. */
  reason: string
  byUserId?: string | null
}

export async function logCaseStaff(db: Pick<Prisma.TransactionClient, "caseStaffLog">, entries: StaffEntry[]): Promise<void> {
  if (!entries.length) return
  await db.caseStaffLog.createMany({
    data: entries.map(entry => ({
      caseId: entry.caseId,
      userId: entry.userId,
      kind: entry.kind,
      action: entry.action,
      reason: entry.reason,
      byUserId: entry.byUserId ?? null,
    })),
  })
}
