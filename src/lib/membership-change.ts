import { Prisma, type AccountKind, type UserRole } from "@/generated/prisma/client"

export type LockedMembership = {
  id: string
  role: UserRole
  accountKind?: AccountKind
  institutionId: string | null
  activatedAt?: Date | null
  suspendedAt?: Date | null
  recoveryRequiredAt?: Date | null
  deletedAt?: Date | null
  anonymizedAt?: Date | null
}

/** Serialize institution moves with concurrent HOD promotion/demotion. */
export async function lockMembership(
  transaction: Prisma.TransactionClient,
  userId: string,
): Promise<LockedMembership | null> {
  const rows = await transaction.$queryRaw<LockedMembership[]>`
    SELECT "id", "role"::text AS "role", "accountKind"::text AS "accountKind", "institutionId",
           "activatedAt", "suspendedAt", "recoveryRequiredAt", "deletedAt", "anonymizedAt"
    FROM "User"
    WHERE "id" = ${userId}
    FOR UPDATE
  `
  return rows[0] ?? null
}

/** A head cannot carry department-wide authority into another institution. */
export function membershipChangeData(
  current: LockedMembership,
  institutionId: string,
): { institutionId: string; role?: "MEMBER" } {
  return {
    institutionId,
    ...(current.role === "HEAD_OF_DEPT" && current.institutionId !== institutionId
      ? { role: "MEMBER" as const }
      : {}),
  }
}

export function isHodDemotion(current: LockedMembership, nextRole: string | undefined): boolean {
  return current.role === "HEAD_OF_DEPT" && nextRole === "MEMBER"
}

/**
 * A demoted HOD keeps every lock on a case still assigned to them, and loses
 * only locks that depended on their former department-wide authority.
 */
export async function releaseUnrelatedHodLocks(
  transaction: Prisma.TransactionClient,
  userId: string,
): Promise<number> {
  return transaction.$executeRaw`
    DELETE FROM "CaseLock" AS lock
    USING "Case" AS clinical_case
    WHERE lock."caseId" = clinical_case."id"
      AND lock."userId" = ${userId}
      AND clinical_case."userId" <> ${userId}
  `
}
