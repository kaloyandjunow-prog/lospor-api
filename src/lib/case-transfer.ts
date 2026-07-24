import type { PrismaClient } from "@/generated/prisma/client"
import { generateCaseCode, isPrismaUniqueError } from "@/lib/case-code"

export type TransferOutcome = {
  /** The code the case carried before the move, when it had to be renumbered. */
  previousCaseCode: string | null
  /** The code it carries now — unchanged unless the recipient already used it. */
  caseCode: string | null
  institutionId: string | null
}

/**
 * Move a case to another clinician.
 *
 * Two things make this more than a `userId` update:
 *
 * 1. **Case codes are per-user sequences that both start at 0001.** Any two
 *    clinicians who each opened a case this year both hold "2026-0001", so a
 *    plain reassignment trips `@@unique([userId, caseCode])` and 500s. When the
 *    recipient already holds the code, the case is renumbered into their
 *    sequence and the old code is recorded on the transfer row, so the paper
 *    record can still be reconciled with the database.
 * 2. **The institution travels with the case.** Leaving `institutionId` behind
 *    puts the wrong hospital on the printed record and in the OMOP export's
 *    care_site.
 *
 * Everything runs in one transaction, including superseding any other pending
 * transfer, so a case can never end up half-moved.
 */
export async function transferCaseOwnership(
  /** Passed in rather than imported: `@/lib/prisma` is server-only, and this
   *  has to be exercisable from a script against a real database — the bug it
   *  guards exists purely because of a unique constraint. */
  db: PrismaClient,
  caseId: string,
  toUserId: string,
  opts: { supersedePending?: boolean; acceptTransferId?: string } = {},
): Promise<TransferOutcome> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(async tx => {
        const [current, recipient] = await Promise.all([
          tx.case.findUniqueOrThrow({ where: { id: caseId }, select: { caseCode: true } }),
          tx.user.findUniqueOrThrow({ where: { id: toUserId }, select: { institutionId: true } }),
        ])

        // Renumber only when the recipient genuinely holds this code already;
        // most transfers keep their original code, which matters because the
        // code is written on the printed record by hand.
        let caseCode = current.caseCode
        let previousCaseCode: string | null = null
        if (caseCode) {
          const clash = await tx.case.findFirst({
            where: { userId: toUserId, caseCode, id: { not: caseId } },
            select: { id: true },
          })
          if (clash) {
            previousCaseCode = caseCode
            caseCode = await generateCaseCode(toUserId, tx)
          }
        }

        if (opts.supersedePending) {
          await tx.caseTransfer.updateMany({
            where: { caseId, status: "PENDING" },
            data: { status: "DECLINED", resolvedAt: new Date() },
          })
        }
        if (opts.acceptTransferId) {
          await tx.caseTransfer.update({
            where: { id: opts.acceptTransferId },
            data: { status: "ACCEPTED", resolvedAt: new Date(), previousCaseCode },
          })
        }

        await tx.case.update({
          where: { id: caseId },
          data: { userId: toUserId, institutionId: recipient.institutionId, caseCode },
        })

        return { previousCaseCode, caseCode, institutionId: recipient.institutionId }
      })
    } catch (e) {
      // Another case can claim the freshly-computed code between our read and
      // our write. Recompute and retry, as the create path already does.
      if (isPrismaUniqueError(e, "caseCode") && attempt < 4) continue
      throw e
    }
  }
}
