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
 */
export async function generateCaseCode(userId: string, db: Db): Promise<string> {
  const prefix = `${new Date().getFullYear()}-`
  // Base the next code on the highest existing one (not a row count) so a gap
  // left by a deleted draft can't collide with a still-existing higher code.
  const last = await db.case.findFirst({
    where: { userId, caseCode: { startsWith: prefix } },
    orderBy: { caseCode: "desc" },
    select: { caseCode: true },
  })
  const lastN = last?.caseCode ? Number(last.caseCode.slice(prefix.length)) : 0
  const next = (Number.isFinite(lastN) ? lastN : 0) + 1
  return `${prefix}${String(next).padStart(4, "0")}`
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
