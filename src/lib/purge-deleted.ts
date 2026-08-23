import { prisma } from "@/lib/prisma"
import { logAuditInTransaction } from "@/lib/audit"

/**
 * Retention: an account soft-deleted more than this long ago is anonymised.
 * 30 days gives a grace window for an accidental or disputed deletion, then the
 * account stops being identifiable.
 */
export const RETENTION_DAYS = 30

export type PurgeResult = {
  scanned: number
  anonymised: number
  userIds: string[]
  rateLimitRowsRemoved: number
}

/**
 * Drop spent rate-limit counters.
 *
 * The table gains a permanent row per key — one per digested login identifier
 * ever seen, including identifiers that were only typo'd or probed. The counters are
 * meaningless once their window has passed, so anything untouched for a day is
 * dead weight (and, for login keys, a slowly-accumulating list of attempted
 * email addresses we have no reason to keep).
 */
export async function pruneRateLimits(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  try {
    const { count } = await prisma.rateLimit.deleteMany({ where: { windowStart: { lt: cutoff } } })
    return count
  } catch {
    return 0   // never let housekeeping fail the job
  }
}

/**
 * Anonymise accounts past the retention window.
 *
 * Deliberately anonymise rather than hard-delete:
 *
 * - **Cases are kept.** They carry no *direct* patient identifiers by design, and
 *   they are the register's entire research value. Destroying them because a
 *   clinician closed their account would be the wrong trade. Note this makes
 *   them pseudonymised, not anonymous: age, sex, institution, precise timestamps
 *   and free text can still single out an individual, so they remain personal
 *   data and a data-subject request may still reach them.
 * - **Audit rows are kept and still reference the (now anonymous) id.** That is
 *   why `AuditLog.userId` is deliberately not a foreign key — a purge must not
 *   cascade away the record of what was done.
 *
 * What is removed is everything that ties the account to a person: name,
 * username, contact email, title, credentials. The row survives as an opaque pseudonym so historical
 * authorship stays coherent.
 */
export async function purgeDeletedAccounts(now = new Date()): Promise<PurgeResult> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000)

  const due = await prisma.user.findMany({
    where: {
      deletedAt: { not: null, lte: cutoff },
      anonymizedAt: null,
    },
    select: { id: true, email: true, username: true },
  })

  let anonymised = 0
  const anonymisedUserIds: string[] = []
  for (const { id, email, username } of due) {
    try {
      await prisma.$transaction(async transaction => {
        await transaction.user.update({
          where: { id },
          data: {
            email:        email ? `deleted-${id}@lospor.invalid` : null,
            username:     username ? `deleted-${id}` : null,
            usernameCanonical: username ? `deleted-${id}`.toLowerCase() : null,
            name:         "Deleted account",
            firstName:    "",
            lastName:     "",
            title:        "",
            // Unusable hash — the account can never be signed into again.
            passwordHash: "",
            // Any token minted before now is already dead via the epoch check.
            passwordChangedAt: now,
            activatedAt: null,
            recoveryRequiredAt: null,
            suspendedAt: null,
            anonymizedAt: now,
          },
        })
        await logAuditInTransaction(transaction, id, "ACCOUNT_ANONYMISED", id, {
          retentionDays: RETENTION_DAYS,
        })
      })
      anonymised++
      anonymisedUserIds.push(id)
    } catch {
      // One bad row (including a failed audit insert) rolls back as a unit and
      // is retried on the next run without blocking unrelated due accounts.
    }
  }

  const rateLimitRowsRemoved = await pruneRateLimits(now)

  return { scanned: due.length, anonymised, userIds: anonymisedUserIds, rateLimitRowsRemoved }
}
