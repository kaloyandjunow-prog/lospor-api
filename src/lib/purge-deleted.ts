import { prisma } from "@/lib/prisma"

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
 * The table gains a permanent row per key — one per login email ever seen,
 * including addresses that were only ever typo'd or probed. The counters are
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
 * - **Cases are kept.** They hold no patient identifiers by design, and they are
 *   the register's entire research value. Destroying them because a clinician
 *   closed their account would be the wrong trade.
 * - **Audit rows are kept and still reference the (now anonymous) id.** That is
 *   why `AuditLog.userId` is deliberately not a foreign key — a purge must not
 *   cascade away the record of what was done.
 *
 * What is removed is everything that ties the account to a person: name, email,
 * title, credentials. The row survives as an opaque pseudonym so historical
 * authorship stays coherent.
 */
export async function purgeDeletedAccounts(now = new Date()): Promise<PurgeResult> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000)

  const due = await prisma.user.findMany({
    where: {
      deletedAt: { not: null, lte: cutoff },
      // Already-anonymised rows keep their sentinel email, so they are not
      // rescanned on every run.
      email: { not: { startsWith: "deleted-" } },
    },
    select: { id: true },
  })

  let anonymised = 0
  for (const { id } of due) {
    try {
      await prisma.user.update({
        where: { id },
        data: {
          email:        `deleted-${id}@lospor.invalid`,
          name:         "Deleted account",
          firstName:    "",
          lastName:     "",
          title:        "",
          // Unusable hash — the account can never be signed into again.
          passwordHash: "",
          // Any token minted before now is already dead via the epoch check.
          passwordChangedAt: now,
        },
      })
      anonymised++
    } catch {
      // One bad row must not abort the whole run; the next run retries it.
    }
  }

  const rateLimitRowsRemoved = await pruneRateLimits(now)

  return { scanned: due.length, anonymised, userIds: due.map(d => d.id), rateLimitRowsRemoved }
}
