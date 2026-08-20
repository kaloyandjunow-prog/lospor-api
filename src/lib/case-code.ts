import type { Prisma, PrismaClient } from "@/generated/prisma/client"

/** Anything that can run a `case` query — the client, or a `$transaction` handle. */
type Db = PrismaClient | Prisma.TransactionClient

/**
 * Next case code in a user's yearly sequence, e.g. "2026-0007".
 *
 * Codes are per-user and reset each calendar year. Uniqueness is
 * `@@unique([userId, caseCode])`, so two clinicians both holding 2026-0001 is
 * normal and expected — which is precisely why a case moving between users may
 * have to be renumbered. See `transferCaseOwnership`.
 *
 * Takes a `Db` so it can run inside the same transaction as the write that
 * consumes it; computing a code outside the transaction that inserts it leaves
 * a race the unique index has to catch.
 *
 * `year` defaults to now, which is right for a new case and wrong for a
 * renumbering. A case handed over in January and performed the previous
 * December must not be renumbered into the recipient's *new* year: the code is
 * printed on the anaesthetic chart, and a 2027 number on a 2026 operation
 * misdates the record and puts it in the wrong year's sequence for anyone
 * counting. Transfers pass the year the case already belongs to.
 */
export async function generateCaseCode(
  userId: string,
  db: Db,
  year: number = new Date().getFullYear(),
): Promise<string> {
  // Read from a counter, never from the cases this person currently owns.
  //
  // Deriving it from ownership is what made handovers unsafe: hand away your
  // highest case and the ceiling drops, so the next case you create takes the
  // number you just handed over -- already printed on that chart, and accepted
  // by the database because the old case now belongs to someone else.
  //
  // The counter is seeded for every existing clinician-year by
  // 20260819160000_case_code_sequence, so it starts above everything already
  // issued. `increment` is a single atomic UPDATE, and it runs in the caller's
  // transaction, so a case that rolls back does not burn a number.
  const sequence = await db.caseCodeSequence.upsert({
    where: { userId_year: { userId, year } },
    // First case of a year for this clinician: issue 1, store 2.
    create: { userId, year, next: 2 },
    update: { next: { increment: 1 } },
    select: { next: true },
  })
  // upsert returns the row after the write in both branches, so the number just
  // issued is one below what is stored for next time.
  const issued = sequence.next - 1
  return `${year}-${String(issued).padStart(4, "0")}`
}

/**
 * Make sure `userId`'s counter is above `caseCode`, so it is never issued again.
 *
 * A case arriving by handover keeps its number whenever the recipient does not
 * already hold it — which is the common case, and means a number lands in their
 * sequence that their own counter knows nothing about. Left alone the counter
 * would walk up to it and issue it a second time.
 *
 * Called on every transfer, including the ones that did not renumber. Cheap,
 * and the alternative is relying on a unique-constraint retry to notice, which
 * only works where a retry exists.
 */
export async function reserveCaseCode(userId: string, db: Db, caseCode: string): Promise<void> {
  const match = /^(\d{4})-(\d+)$/.exec(caseCode)
  if (!match) return
  const year = Number(match[1])
  const after = Number(match[2]) + 1

  const existing = await db.caseCodeSequence.findUnique({
    where: { userId_year: { userId, year } },
    select: { next: true },
  })
  if (!existing) {
    await db.caseCodeSequence.create({ data: { userId, year, next: after } })
    return
  }
  // Only ever forward. A handover of an old, low-numbered case must not drag
  // the counter back over numbers already issued.
  if (existing.next < after) {
    await db.caseCodeSequence.update({
      where: { userId_year: { userId, year } },
      data: { next: after },
    })
  }
}

/** True when `err` is a Prisma unique-constraint violation, optionally on `field`. */
export function isPrismaUniqueError(err: unknown, field?: string): boolean {
  if (!err || typeof err !== "object" || !("code" in err) || err.code !== "P2002") return false
  if (!field) return true
  const target = "meta" in err && err.meta && typeof err.meta === "object" && "target" in err.meta
    ? err.meta.target
    : undefined
  return Array.isArray(target) ? target.includes(field) : false
}
