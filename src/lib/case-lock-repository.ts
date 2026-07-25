import { prisma } from "@/lib/prisma"

export type StoredCaseLock = {
  caseId: string
  userId: string
  deviceId: string
  expiresAt: Date
}

type AcquireCaseLockInput = {
  caseId: string
  userId: string
  deviceId: string
  ttlMs: number
}

/**
 * Acquires or refreshes a lease in one PostgreSQL statement. The WHERE clause
 * is the compare-and-set: a live lease can only be refreshed by its owner.
 */
export async function acquireCaseLockAtomic(
  input: AcquireCaseLockInput,
): Promise<StoredCaseLock | null> {
  const rows = await prisma.$queryRaw<StoredCaseLock[]>`
    INSERT INTO "CaseLock" ("caseId", "userId", "deviceId", "expiresAt")
    VALUES (
      ${input.caseId},
      ${input.userId},
      ${input.deviceId},
      CURRENT_TIMESTAMP + (${input.ttlMs} * INTERVAL '1 millisecond')
    )
    ON CONFLICT ("caseId") DO UPDATE
    SET
      "userId" = EXCLUDED."userId",
      "deviceId" = EXCLUDED."deviceId",
      "expiresAt" = EXCLUDED."expiresAt"
    WHERE
      "CaseLock"."expiresAt" <= CURRENT_TIMESTAMP
      OR (
        "CaseLock"."userId" = EXCLUDED."userId"
        AND "CaseLock"."deviceId" = EXCLUDED."deviceId"
      )
    RETURNING "caseId", "userId", "deviceId", "expiresAt"
  `
  return rows[0] ?? null
}

export async function readCaseLock(caseId: string): Promise<StoredCaseLock | null> {
  return prisma.caseLock.findUnique({ where: { caseId } })
}
