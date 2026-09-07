import { prisma } from "@/lib/prisma"
import type { Prisma } from "@/generated/prisma/client"

/**
 * The dashboard's case list, ordered by clinical urgency rather than by
 * creation date or the status enum's own declaration order.
 *
 * A plain `orderBy: { status: "asc" }` sorts by the enum's declared ordinal --
 * DRAFT, IN_PROGRESS, AWAITING_REVIEW, COMPLETE -- which puts every draft
 * ahead of every case actively counting down to auto-close. With more than
 * `take` drafts, the one case that most needs a clinician's attention could
 * be the one pushed off the page. Postgres enum columns only sort forward or
 * backward by that fixed ordinal, so the real priority order --
 * AWAITING_REVIEW, IN_PROGRESS, DRAFT, COMPLETE -- has to be built by
 * querying one status tier at a time rather than expressed as a single
 * `orderBy`.
 *
 * `skip`/`take` are honoured across the whole priority-ordered sequence, not
 * per tier: paging past the end of the AWAITING_REVIEW tier continues into
 * IN_PROGRESS, and so on, exactly as if the tiers had been concatenated into
 * one list and then paged.
 *
 * Assumes `where` does not already constrain `status` -- true of every
 * caller today (`caseReadWhereForUser` is access-control only) -- since each
 * tier query adds its own `status` to `where` and would otherwise silently
 * override a caller-supplied one.
 */
const STATUS_PRIORITY = ["AWAITING_REVIEW", "IN_PROGRESS", "DRAFT", "COMPLETE"] as const

export async function findCasesByPriority<Include extends Prisma.CaseInclude>(
  where: Prisma.CaseWhereInput,
  include: Include,
  skip: number,
  take: number,
): Promise<Prisma.CaseGetPayload<{ include: Include }>[]> {
  let remainingSkip = skip
  let remainingTake = take
  const results: Prisma.CaseGetPayload<{ include: Include }>[] = []

  for (const status of STATUS_PRIORITY) {
    if (remainingTake <= 0) break
    const tierWhere: Prisma.CaseWhereInput = { ...where, status }
    const tierCount = await prisma.case.count({ where: tierWhere })
    if (remainingSkip >= tierCount) {
      remainingSkip -= tierCount
      continue
    }
    const rows = await prisma.case.findMany({
      where: tierWhere,
      include,
      orderBy: { createdAt: "desc" },
      skip: remainingSkip,
      take: remainingTake,
    }) as Prisma.CaseGetPayload<{ include: Include }>[]
    results.push(...rows)
    remainingTake -= rows.length
    remainingSkip = 0
  }

  return results
}
